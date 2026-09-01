import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  boundedTelegramApi,
  buildCanaryDeepLink,
  constantTimeHexEqual,
  CONTENT_FACTORY_LEADS_CANARY,
  createCanaryToken,
  deriveCanaryIdentity,
  digestCanaryToken,
  isVerifiedMarkupRemoval,
  normalizeCanaryEvidencePage,
  normalizeWebhookInfo,
  readActivationBody,
  readCtaActivationBody,
  readTelegramUpdate,
  webhookCallbackResponse,
  webhookStartResponse,
} from "../supabase/functions/_shared/content-factory-leads-canary.mjs";
import {
  executeCanaryRollback,
  executeCtaActivation,
  executeRuntimeActivation,
} from "../supabase/functions/_shared/content-factory-leads-canary-orchestrator.mjs";

const migration = readFileSync(
  "supabase/migrations/20260901000003_content_factory_leads_canary.sql",
  "utf8",
);
const canaryFunction = readFileSync(
  "supabase/functions/content-factory-leads-canary/index.ts",
  "utf8",
);
const ctaFunction = readFileSync(
  "supabase/functions/activate-content-factory-leads-cta/index.ts",
  "utf8",
);
const rollbackFunction = readFileSync(
  "supabase/functions/rollback-content-factory-leads-canary/index.ts",
  "utf8",
);
const config = readFileSync("supabase/config.toml", "utf8");
const termuxScripts = [
  "scripts/post13c-token-preflight-termux.sh",
  "scripts/post13c-activate-termux.sh",
  "scripts/post13c-deactivate-termux.sh",
].map((path) => readFileSync(path, "utf8"));

test("dedicated cf1 destination is truthful and keeps 256-bit opaque identity", async () => {
  const token = createCanaryToken();
  assert.match(token, /^cf1_[A-Za-z0-9_-]{43}$/u);
  assert.equal(Buffer.from(token.slice(4), "base64url").length, 32);
  assert.match(await digestCanaryToken(token), /^[0-9a-f]{64}$/u);
  const url = buildCanaryDeepLink(token);
  assert.equal(url, `https://t.me/ContentFactoryLeads_bot?start=${token}`);
  assert.equal(/creative-|publication|user_id|chat_id/u.test(url), false);
  assert.equal(
    CONTENT_FACTORY_LEADS_CANARY.DESTINATION,
    "content_factory_leads_canary",
  );
});

test("activation and CTA inputs are exact, bounded and fail closed", async () => {
  const botToken = `${"1".repeat(9)}:${"A".repeat(40)}`;
  const activation = new Request("https://local/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bot_token: botToken }),
  });
  assert.deepEqual(await readActivationBody(activation), { botToken });
  await assert.rejects(
    readActivationBody(
      new Request("https://local/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bot_token: botToken, extra: true }),
      }),
    ),
    /REQUEST_SCHEMA_INVALID/u,
  );

  const ids = {
    creative_identity_map_id: "10000000-0000-4000-8000-000000000001",
    telegram_post_id: "20000000-0000-4000-8000-000000000001",
  };
  assert.deepEqual(
    await readCtaActivationBody(
      new Request("https://local/cta", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ids),
      }),
    ),
    {
      creativeIdentityMapId: ids.creative_identity_map_id,
      telegramPostId: ids.telegram_post_id,
    },
  );

  const identityProof = canaryFunction.indexOf(
    'normalizeTelegramApiIdentity(\n      await telegramApi(botToken, "getMe")',
  );
  const serverAuthorization = canaryFunction.indexOf(
    '"authorize_content_factory_leads_canary"',
  );
  assert.ok(identityProof >= 0 && serverAuthorization > identityProof);
  assert.match(canaryFunction, /p_credential_digest: credentialDigest/u);
  assert.doesNotMatch(
    canaryFunction,
    /credential_digest[^\n]*(?:return|json\()/iu,
  );
});

test("Telegram start and explicit callback are separate strict stages", async () => {
  const token = createCanaryToken();
  const start = await readTelegramUpdate(requestUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 123, is_bot: false, first_name: "Owner" },
      chat: { id: 123, type: "private", first_name: "Owner" },
      date: 1_788_000_000,
      text: `/start ${token}`,
      entities: [{ offset: 0, length: 6, type: "bot_command" }],
    },
  }));
  assert.equal(start.kind, "BOT_START");
  assert.equal(start.token, token);
  const startResponse = webhookStartResponse(start.transientChatId);
  assert.equal(startResponse.method, "sendMessage");
  assert.equal(
    startResponse.reply_markup.inline_keyboard[0][0].callback_data,
    "post13c_confirm_v1",
  );

  const callback = await readTelegramUpdate(requestUpdate({
    update_id: 2,
    callback_query: {
      id: "callback-1",
      from: { id: 123, is_bot: false, first_name: "Owner" },
      message: {
        message_id: 11,
        from: { id: 999, is_bot: true, first_name: "Bot" },
        chat: { id: 123, type: "private", first_name: "Owner" },
        date: 1_788_000_001,
        text: "Источник зафиксирован.",
        reply_markup: {},
      },
      chat_instance: "instance-1",
      data: "post13c_confirm_v1",
    },
  }));
  assert.equal(callback.kind, "CANARY_LEAD_CREATED");
  assert.equal(
    webhookCallbackResponse(callback.callbackQueryId).method,
    "answerCallbackQuery",
  );

  await assert.rejects(
    readTelegramUpdate(requestUpdate({
      update_id: 3,
      message: {
        message_id: 12,
        from: { id: 123, is_bot: false, first_name: "Owner", secret: "drift" },
        chat: { id: 123, type: "private", first_name: "Owner" },
        date: 1_788_000_002,
        text: `/start ${token}`,
        entities: [{ offset: 0, length: 6, type: "bot_command" }],
      },
    })),
    /TELEGRAM_SCHEMA_DRIFT/u,
  );
});

test("HMAC pseudonyms are stable and do not expose Telegram identities", async () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  const subjectA = await deriveCanaryIdentity(key, "subject", 123456789);
  const subjectB = await deriveCanaryIdentity(key, "subject", 123456789);
  const update = await deriveCanaryIdentity(key, "update", 123456789);
  assert.equal(subjectA, subjectB);
  assert.notEqual(subjectA, update);
  assert.match(subjectA, /^subject_[0-9a-f]{64}$/u);
  assert.equal(subjectA.includes("123456789"), false);
  assert.equal(constantTimeHexEqual("a".repeat(64), "a".repeat(64)), true);
  assert.equal(constantTimeHexEqual("a".repeat(64), "b".repeat(64)), false);
});

test("read-side exposes only test-only PII-free evidence", () => {
  const row = {
    creative_id: `creative-${"a".repeat(64)}`,
    publication_id: "10000000-0000-4000-8000-000000000001",
    token_id: "20000000-0000-4000-8000-000000000001",
    token_digest: "b".repeat(64),
    event_id: "30000000-0000-4000-8000-000000000001",
    event_type: "CANARY_LEAD_CREATED",
    subject_id: `subject_${"c".repeat(64)}`,
    occurred_at: "2026-09-01T18:00:00.000Z",
    attribution_quality: "DETERMINISTIC_CANARY",
    provenance: {
      policy_version: "POST13C_ISOLATED_CANARY_V1",
      source_system: "content_factory_leads_canary",
      test_only: true,
    },
  };
  assert.equal(
    normalizeCanaryEvidencePage([row])[0].event_type,
    "CANARY_LEAD_CREATED",
  );
  assert.throws(
    () => normalizeCanaryEvidencePage([{ ...row, phone: "+70000000000" }]),
    /CANARY_EVIDENCE_INVALID/u,
  );
});

test("source boundary never persists raw CTA/token and never touches Meeting or Booking", () => {
  assert.match(
    migration,
    /destination in \('meeting_assistant', 'content_factory_leads_canary'\)/u,
  );
  assert.match(migration, /destination = 'content_factory_leads_canary'/u);
  assert.match(
    migration,
    /event_type in \('BOT_START', 'CANARY_LEAD_CREATED'\)/u,
  );
  assert.match(migration, /'test_only', true/u);
  assert.doesNotMatch(
    migration,
    /raw_token|booking_id|calendar_id|content_lessons/u,
  );
  assert.doesNotMatch(
    ctaFunction,
    /\.from\("posts"\)\.update|inline_buttons:/u,
  );
  assert.match(ctaFunction, /editMessageReplyMarkup/u);
  assert.match(
    ctaFunction,
    /ensure_content_factory_leads_canary_token_revoked/u,
  );
  assert.doesNotMatch(ctaFunction, /preview_deep_link|rawToken.*return/u);
  assert.match(canaryFunction, /evidence_root: "CANARY_TEST_EVIDENCE"/u);
  assert.doesNotMatch(
    canaryFunction,
    /console\.|meeting_assistant|Booking|Google Calendar/u,
  );
  assert.doesNotMatch(
    rollbackFunction,
    /console\.|meeting_assistant|Booking|Google Calendar/u,
  );
});

test("deployment and Termux helpers are fixed, no-argument and token-safe", () => {
  assert.match(
    config,
    /\[functions\.content-factory-leads-canary\]\s*verify_jwt\s*=\s*false/u,
  );
  assert.match(
    config,
    /\[functions\.activate-content-factory-leads-cta\]\s*verify_jwt\s*=\s*true/u,
  );
  for (const script of termuxScripts) {
    assert.match(script, /\[ "\$#" -(?:ne|eq) 0 \]/u);
    assert.match(script, /set \+x/u);
    assert.doesNotMatch(script, /\bcat\b/u);
    assert.doesNotMatch(script, /echo .*token/iu);
    assert.doesNotMatch(script, /curl[^\n]*\$token/u);
    assert.match(script, /max-time(?: =)? 15|--max-time 15/u);
    assert.match(script, /max-filesize(?: =)? 65536|--max-filesize 65536/u);
  }
});

test("runtime activation proves exact webhook config and compensates uncertain writes", async () => {
  assert.deepEqual(
    normalizeWebhookInfo(
      {
        ok: true,
        result: {
          url:
            "https://example.test/functions/v1/content-factory-leads-canary/webhook",
          max_connections: 1,
          allowed_updates: ["message", "callback_query"],
        },
      },
      "https://example.test/functions/v1/content-factory-leads-canary/webhook",
    ),
    {
      url:
        "https://example.test/functions/v1/content-factory-leads-canary/webhook",
      maxConnections: 1,
      allowedUpdates: ["message", "callback_query"],
    },
  );
  assert.throws(() =>
    normalizeWebhookInfo({
      ok: true,
      result: {
        url: "https://example.test/webhook",
        max_connections: 40,
        allowed_updates: ["message"],
      },
    }, "https://example.test/webhook"), /CANARY_WEBHOOK_VERIFICATION_FAILED/u);

  const calls = [];
  await assert.rejects(
    executeRuntimeActivation({
      claim: async () => (calls.push("claim"), true),
      verifyIdentity:
        async () => (calls.push("identity"),
          { username: "ContentFactoryLeads_bot" }),
      setWebhook: async () => {
        calls.push("set");
        throw new Error("LOST_RESPONSE");
      },
      verifyWebhook: async () => calls.push("verify"),
      complete: async () => true,
      removeAndVerifyWebhook: async () => (calls.push("remove"), true),
      completeDeactivation: async () => (calls.push("terminal"), true),
      markRollbackRequired: async () => calls.push("rollback-required"),
    }),
    /ACTIVATION_FAILED/u,
  );
  assert.deepEqual(calls, ["claim", "identity", "set", "remove", "terminal"]);

  const finalizeCalls = [];
  await assert.rejects(
    executeRuntimeActivation({
      claim: async () => true,
      verifyIdentity: async () => ({ username: "ContentFactoryLeads_bot" }),
      setWebhook: async () => undefined,
      verifyWebhook: async () => undefined,
      complete: async () => {
        throw new Error("FINALIZE_RESPONSE_LOST");
      },
      removeAndVerifyWebhook: async () => (finalizeCalls.push("remove"), true),
      completeDeactivation: async () => (finalizeCalls.push("terminal"), true),
      markRollbackRequired: async () => finalizeCalls.push("rollback-required"),
    }),
    /ACTIVATION_FAILED/u,
  );
  assert.deepEqual(finalizeCalls, ["remove", "terminal"]);

  const claimCalls = [];
  await assert.rejects(
    executeRuntimeActivation({
      claim: async () => {
        throw new Error("CLAIM_RESPONSE_LOST");
      },
      verifyIdentity: async () => undefined,
      setWebhook: async () => undefined,
      verifyWebhook: async () => undefined,
      complete: async () => true,
      removeAndVerifyWebhook: async () => (claimCalls.push("remove"), true),
      completeDeactivation: async () => (claimCalls.push("terminal"), true),
      markRollbackRequired: async () => claimCalls.push("rollback-required"),
    }),
    /ACTIVATION_FAILED/u,
  );
  assert.deepEqual(claimCalls, ["remove", "terminal"]);
});

test("CTA lost response revokes first, removes exact markup and deactivates", async () => {
  const calls = [];
  await assert.rejects(
    executeCtaActivation({
      snapshotSentinels: async () => ({
        sentinel_count: 2,
        matches: true,
        current_hash: "a".repeat(64),
        frozen_hash: "a".repeat(64),
      }),
      prepare: async () => ({ token_id: "token", bot_id: "bot" }),
      getRun: async () => null,
      editCta: async () => {
        calls.push("edit");
        throw new Error("LOST_RESPONSE");
      },
      markActive: async () => true,
      ensureTokenRevoked: async () => (calls.push("revoke"), true),
      removeAndVerifyCta: async () => (calls.push("remove"), true),
      markRunRollback: async (
        _run,
        proven,
      ) => (calls.push(`mark:${proven}`), true),
      beginDeactivation: async () => (calls.push("deactivate"), true),
    }),
    /CANARY_CTA_ACTIVATION_FAILED/u,
  );
  assert.deepEqual(calls, [
    "edit",
    "revoke",
    "remove",
    "mark:true",
    "deactivate",
  ]);
});

test("revoke failure is rollback-required and zero-run rollback is terminal", async () => {
  const calls = [];
  await assert.rejects(
    executeCtaActivation({
      snapshotSentinels: async () => ({
        sentinel_count: 2,
        matches: true,
        current_hash: "b".repeat(64),
        frozen_hash: "b".repeat(64),
      }),
      prepare: async () => ({ token_id: "token" }),
      getRun: async () => null,
      editCta: async () => {
        throw new Error("TIMEOUT");
      },
      markActive: async () => true,
      ensureTokenRevoked: async () => false,
      removeAndVerifyCta: async () => true,
      markRunRollback: async (
        _run,
        proven,
      ) => (calls.push(`mark:${proven}`), true),
      beginDeactivation: async () => (calls.push("deactivate"), true),
    }),
    /CANARY_CTA_ACTIVATION_FAILED/u,
  );
  assert.deepEqual(calls, ["mark:false", "deactivate"]);

  const zero = await executeCanaryRollback({
    getRun: async () => null,
    beginDeactivation: async () => (calls.push("zero-deactivate"), true),
  });
  assert.equal(zero.zero_run, true);
  assert.equal(calls.at(-1), "zero-deactivate");
});

test("bounded Telegram client fails closed on timeout and oversized response", async () => {
  const token = `${"1".repeat(9)}:${"A".repeat(40)}`;
  await assert.rejects(
    boundedTelegramApi(
      async (_url, init) => {
        assert.equal(init.signal instanceof AbortSignal, true);
        throw new DOMException("timed out", "TimeoutError");
      },
      token,
      "getMe",
    ),
    /timed out/u,
  );
  await assert.rejects(
    boundedTelegramApi(
      async () =>
        new Response("x", {
          status: 200,
          headers: { "content-length": "65537" },
        }),
      token,
      "getMe",
    ),
    /TELEGRAM_API_RESPONSE_INVALID/u,
  );
  assert.equal(
    isVerifiedMarkupRemoval(
      {
        ok: true,
        result: { message_id: 77, chat: { id: "-100123" } },
      },
      "-100123",
      77,
    ),
    true,
  );
  assert.equal(
    isVerifiedMarkupRemoval(
      {
        ok: true,
        result: { message_id: 78, chat: { id: "-100123" } },
      },
      "-100123",
      77,
    ),
    false,
  );
  assert.equal(
    isVerifiedMarkupRemoval(
      {
        ok: false,
        error_code: 400,
        description: "Bad Request: message is not modified",
      },
      "-100123",
      77,
    ),
    true,
  );
});

function requestUpdate(body) {
  return new Request("https://local/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
