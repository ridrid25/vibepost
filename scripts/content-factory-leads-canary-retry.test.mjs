import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildRetryCallbackData,
  buildRetryDeepLink,
  CONTENT_FACTORY_LEADS_CANARY_RETRY,
  createRetryToken,
  digestRetryToken,
  normalizeRetryEvidence,
  parseRetryCallbackData,
  readRetryControlBody,
  readRetryTelegramUpdate,
  retryPublicationMarkup,
  retryStartResponse,
} from "../supabase/functions/_shared/content-factory-leads-canary-retry.mjs";
import {
  executeRetryDelivery,
  RetryFlowError,
} from "../supabase/functions/_shared/content-factory-leads-canary-retry-orchestrator.mjs";

const migration = readFileSync(
  "supabase/migrations/20260902000001_content_factory_leads_canary_retry.sql",
  "utf8",
);
const dispatcher = readFileSync(
  "supabase/functions/content-factory-leads-canary/index.ts",
  "utf8",
);
const control = readFileSync(
  "supabase/functions/content-factory-leads-canary-retry-control/index.ts",
  "utf8",
);
const config = readFileSync("supabase/config.toml", "utf8");
const runId = "10000000-0000-4000-8000-000000000013";

test("fresh cf1 and callback contain no internal publication identifiers", async () => {
  const token = createRetryToken();
  assert.match(token, /^cf1_[A-Za-z0-9_-]{43}$/u);
  assert.match(await digestRetryToken(token), /^[0-9a-f]{64}$/u);
  assert.equal(
    buildRetryDeepLink(token),
    `https://t.me/ContentFactoryLeads_bot?start=${token}`,
  );
  assert.equal(/creative-|publication_id|user_id/u.test(token), false);
  const callback = buildRetryCallbackData(runId);
  assert.equal(callback.length < 64, true);
  assert.equal(parseRetryCallbackData(callback), runId);
  assert.equal(CONTENT_FACTORY_LEADS_CANARY_RETRY.STAGE_KEY, "POST13D");
});

test("control actions are exact and bounded", async () => {
  for (const action of ["prepare", "negative_check", "complete", "rollback"]) {
    const request = new Request("https://local/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    assert.deepEqual(await readRetryControlBody(request), { action });
  }
  await assert.rejects(
    readRetryControlBody(new Request("https://local/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "prepare", token: "forbidden" }),
    })),
    /REQUEST_SCHEMA_INVALID/u,
  );
});

test("POST13D start and callback are run-bound and reject POST13C callback", async () => {
  const token = createRetryToken();
  const start = await readRetryTelegramUpdate(updateRequest({
    update_id: 10,
    message: {
      message_id: 20,
      from: { id: 123, is_bot: false, first_name: "Owner" },
      chat: { id: 123, type: "private", first_name: "Owner" },
      date: 1_788_000_000,
      text: `/start ${token}`,
      entities: [{ offset: 0, length: 6, type: "bot_command" }],
    },
  }), runId);
  assert.equal(start.kind, "BOT_START");
  const response = retryStartResponse(start.transientChatId, runId);
  assert.equal(
    response.reply_markup.inline_keyboard[0][0].callback_data,
    buildRetryCallbackData(runId),
  );

  const callbackUpdate = {
    update_id: 11,
    callback_query: {
      id: "callback-13d",
      from: { id: 123, is_bot: false, first_name: "Owner" },
      message: {
        message_id: 21,
        from: {
          id: 999,
          is_bot: true,
          first_name: "Content Factory Leads",
          username: "ContentFactoryLeads_bot",
        },
        chat: { id: 123, type: "private", first_name: "Owner" },
        date: 1_788_000_001,
        text: CONTENT_FACTORY_LEADS_CANARY_RETRY.BOT_PROMPT_TEXT,
        reply_markup: response.reply_markup,
      },
      chat_instance: "instance-13d",
      data: buildRetryCallbackData(runId),
    },
  };
  const callback = await readRetryTelegramUpdate(
    updateRequest(callbackUpdate),
    runId,
  );
  assert.equal(callback.kind, "CANARY_LEAD_CREATED");
  await assert.rejects(
    readRetryTelegramUpdate(updateRequest({
      ...callbackUpdate,
      callback_query: {
        ...callbackUpdate.callback_query,
        data: "post13c_confirm_v1",
      },
    }), runId),
    /POST13D_CALLBACK_INVALID/u,
  );
});

test("publication has one transient CTA and evidence rejects PII", () => {
  const token = createRetryToken();
  const markup = retryPublicationMarkup(token);
  assert.equal(markup.inline_keyboard.length, 1);
  assert.equal(markup.inline_keyboard[0].length, 1);
  assert.equal(markup.inline_keyboard[0][0].url.endsWith(token), true);

  const row = {
    canary_run_id: runId,
    creative_id: `creative-${"a".repeat(64)}`,
    publication_id: "20000000-0000-4000-8000-000000000013",
    token_id: "30000000-0000-4000-8000-000000000013",
    token_digest: "b".repeat(64),
    event_id: "40000000-0000-4000-8000-000000000013",
    event_type: "CANARY_LEAD_CREATED",
    subject_id: `subject_${"c".repeat(64)}`,
    occurred_at: "2026-09-02T00:00:00.000Z",
    attribution_quality: "DETERMINISTIC_CANARY",
    provenance: {
      policy_version: "POST13D_ISOLATED_CANARY_RETRY_V1",
      source_system: "content_factory_leads_canary_retry",
      test_only: true,
    },
  };
  assert.equal(normalizeRetryEvidence([row]).length, 1);
  assert.throws(
    () => normalizeRetryEvidence([{ ...row, username: "owner" }]),
    /POST13D_EVIDENCE_INVALID/u,
  );
});

test("single-attempt saga sends once and finalizes once", async () => {
  const calls = [];
  const result = await executeRetryDelivery({
    prepare: async () => (calls.push("prepare"), { canary_run_id: runId }),
    claim: async () => (calls.push("claim"), true),
    send: async () => (calls.push("send"), { messageId: 77 }),
    finalize: async () => (calls.push("finalize"), true),
    compensate: async () => (calls.push("compensate"), true),
    rollback: async () => (calls.push("rollback"), true),
  });
  assert.equal(result.state, "ACTIVE");
  assert.deepEqual(calls, ["prepare", "claim", "send", "finalize"]);
});

test("ambiguous delivery never retries and becomes unproven rollback", async () => {
  const calls = [];
  await assert.rejects(
    executeRetryDelivery({
      prepare: async () => (calls.push("prepare"), { canary_run_id: runId }),
      claim: async () => (calls.push("claim"), true),
      send: async () => {
        calls.push("send");
        throw new RetryFlowError("TIMEOUT", { delivery: "AMBIGUOUS" });
      },
      finalize: async () => (calls.push("finalize"), true),
      compensate: async () => (calls.push("compensate"), true),
      rollback: async (_run, reason, proven) => {
        calls.push(`rollback:${reason}:${proven}`);
        return true;
      },
    }),
    /POST13D_DELIVERY_FAILED/u,
  );
  assert.deepEqual(calls, [
    "prepare",
    "claim",
    "send",
    "rollback:DELIVERY_AMBIGUOUS:false",
  ]);
});

test("proven pre-send credential failure terminally rolls back", async () => {
  const calls = [];
  await assert.rejects(
    executeRetryDelivery({
      prepare: async () => ({ canary_run_id: runId }),
      claim: async () => true,
      send: async () => {
        throw new RetryFlowError("POST13D_CANARY_BOT_NOT_PROVEN", {
          delivery: "NONE",
        });
      },
      finalize: async () => true,
      compensate: async () => (calls.push("compensate"), true),
      rollback: async (_run, reason, proven) => {
        calls.push(`rollback:${reason}:${proven}`);
        return true;
      },
    }),
    /POST13D_DELIVERY_FAILED/u,
  );
  assert.deepEqual(calls, ["rollback:DELIVERY_REJECTED:true"]);
});

test("verified delivery with failed finalize compensates exact message", async () => {
  const calls = [];
  await assert.rejects(
    executeRetryDelivery({
      prepare: async () => ({ canary_run_id: runId }),
      claim: async () => true,
      send: async () => ({ messageId: 78 }),
      finalize: async () => false,
      compensate: async (_run, delivery) => {
        calls.push(`compensate:${delivery.messageId}`);
        return true;
      },
      rollback: async (_run, reason, proven) => {
        calls.push(`rollback:${reason}:${proven}`);
        return true;
      },
    }),
    /POST13D_DELIVERY_FAILED/u,
  );
  assert.deepEqual(calls, [
    "compensate:78",
    "rollback:FINALIZE_FAILED:true",
  ]);
});

test("verified Telegram markup mismatch preserves message id for exact compensation", async () => {
  const calls = [];
  await assert.rejects(
    executeRetryDelivery({
      prepare: async () => ({ canary_run_id: runId }),
      claim: async () => true,
      send: async () => {
        throw new RetryFlowError("POST13D_TELEGRAM_MARKUP_AMBIGUOUS", {
          delivery: "VERIFIED",
          delivered: { messageId: 79, telegramChatId: "-1001234567890" },
        });
      },
      finalize: async () => true,
      compensate: async (_run, delivery) => {
        calls.push(`compensate:${delivery.messageId}`);
        return true;
      },
      rollback: async (_run, reason, proven) => {
        calls.push(`rollback:${reason}:${proven}`);
        return true;
      },
    }),
    /POST13D_DELIVERY_FAILED/u,
  );
  assert.deepEqual(calls, [
    "compensate:79",
    "rollback:FINALIZE_FAILED:true",
  ]);
});

test("source and migration keep POST13C immutable and protected systems absent", () => {
  assert.match(
    migration,
    /stage_key text not null unique check \(stage_key = 'POST13D'\)/u,
  );
  assert.match(migration, /delivery_attempts between 0 and 1/u);
  assert.match(migration, /delivery_lease_expires_at timestamptz/u);
  assert.match(
    migration,
    /recover_content_factory_leads_canary_retry_delivery/u,
  );
  assert.match(migration, /state = 'COMPLETED'/u);
  assert.match(migration, /resolution_hash = v_resolution_hash/u);
  assert.equal(
    (migration.match(/pg_advisory_xact_lock\(pg_catalog\.hashtext\('POST13D_RUN'\)\)/gu) ?? []).length >= 7,
    true,
  );
  assert.match(migration, /t\.status = 'REVOKED'/u);
  assert.match(migration, /raw_cf1_count = 0/u);
  assert.doesNotMatch(
    migration,
    /update public\.telegram_(?:canary_runtime_state|attribution_canary_runs|canary_attribution_events)/u,
  );
  assert.doesNotMatch(control, /setWebhook|deleteWebhook|console\./u);
  assert.equal((control.match(/\/sendMessage/g) ?? []).length, 1);
  assert.match(control, /constantTimeHexEqual/u);
  assert.match(control, /assertCanaryPublisherIdentity/u);
  assert.match(control, /"getMe"/u);
  assert.doesNotMatch(
    `${migration}\n${control}`,
    /meeting_assistant|booking_id|calendar_id|payment_id|revenue_id/iu,
  );
  assert.match(dispatcher, /record_content_factory_leads_retry_bot_start/u);
  assert.match(dispatcher, /record_content_factory_leads_retry_canary_lead/u);
  assert.match(
    config,
    /\[functions\.content-factory-leads-canary-retry-control\]\s*verify_jwt\s*=\s*true/u,
  );
});

function updateRequest(value) {
  return new Request(
    "https://local/functions/v1/content-factory-leads-canary/webhook",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    },
  );
}
