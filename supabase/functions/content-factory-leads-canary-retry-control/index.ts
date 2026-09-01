import { createClient } from "npm:@supabase/supabase-js@2";
import {
  boundedTelegramApi,
  constantTimeHexEqual,
  CONTENT_FACTORY_LEADS_CANARY_RETRY,
  createRetryToken,
  digestRetryToken,
  digestText,
  isVerifiedMarkupRemoval,
  normalizeRetrySendResult,
  readRetryControlBody,
  retryPublicationMarkup,
} from "../_shared/content-factory-leads-canary-retry.mjs";
import {
  executeRetryDelivery,
  RetryFlowError,
} from "../_shared/content-factory-leads-canary-retry-orchestrator.mjs";

type AdminClient = ReturnType<typeof adminClient>;
type RetryRun = {
  canary_run_id: string;
  user_id: string;
  bot_id: string;
  telegram_chat_id: string;
  telegram_post_id: string;
  tg_message_id: number | null;
  delivery_attempts: number;
  bot_credential_digest: string;
  state: string;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
  try {
    const admin = adminClient();
    const ownerId = await authenticatedOwner(req, admin);
    if (!ownerId) return json(401, { error: "UNAUTHORIZED" });
    const { action } = await readRetryControlBody(req);
    const { error: recoveryError } = await admin.rpc(
      "recover_content_factory_leads_canary_retry_delivery",
      {
      p_user_id: ownerId,
      },
    );
    if (recoveryError) throw new Error("POST13D_RECOVERY_RPC_FAILED");
    if (action === "prepare") return await prepare(ownerId, admin);
    if (action === "negative_check") return await negativeCheck(admin);
    if (action === "complete") return await complete(ownerId, admin);
    return await rollback(ownerId, admin);
  } catch {
    return json(409, { error: "POST13D_CONTROL_FAILED" });
  }
});

async function prepare(ownerId: string, admin: AdminClient): Promise<Response> {
  let rawCf1 = "";
  let publisherToken = "";
  const runId = crypto.randomUUID();
  const deliveryLeaseId = crypto.randomUUID();
  const deliveryLeaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
  try {
    rawCf1 = createRetryToken();
    const tokenDigest = await digestRetryToken(rawCf1);
    const markup = retryPublicationMarkup(rawCf1);
    const ctaHash = await digestText(JSON.stringify(markup));
    const compactRunId = runId.replaceAll("-", "");
    const sourceTaskId = `post13d:${compactRunId}`;
    const sourceRevisionId = "post13d.retry.v1";
    const sourceHash = await digestText(
      `${sourceTaskId}:${sourceRevisionId}:${CONTENT_FACTORY_LEADS_CANARY_RETRY.PUBLICATION_TEXT}`,
    );
    const creativeId = `creative-${await digestText(JSON.stringify({
      domain: "content-factory:creative:v1",
      source_hash: sourceHash,
      source_revision_id: sourceRevisionId,
      source_task_id: sourceTaskId,
    }))}`;
    const handoffId = `handoff-${await digestText(`post13d:${runId}:telegram`)}`;

    const result = await executeRetryDelivery({
      prepare: async () => {
        const { data, error } = await admin.rpc(
          "prepare_content_factory_leads_canary_retry",
          {
            p_user_id: ownerId,
            p_canary_run_id: runId,
            p_creative_id: creativeId,
            p_source_task_id: sourceTaskId,
            p_source_revision_id: sourceRevisionId,
            p_source_hash: sourceHash,
            p_handoff_id: handoffId,
            p_token_digest: tokenDigest,
            p_cta_hash: ctaHash,
            p_publication_text:
              CONTENT_FACTORY_LEADS_CANARY_RETRY.PUBLICATION_TEXT,
          },
        );
        if (error || !data?.canary_run_id) {
          throw new RetryFlowError("POST13D_PREPARE_RPC_FAILED");
        }
        return data as RetryRun;
      },
      claim: async (run: RetryRun) => {
        const { data, error } = await admin.rpc(
          "claim_content_factory_leads_canary_retry_delivery",
          {
            p_user_id: ownerId,
            p_canary_run_id: run.canary_run_id,
            p_delivery_lease_id: deliveryLeaseId,
            p_delivery_lease_expires_at: deliveryLeaseExpiresAt,
          },
        );
        return !error && data === true;
      },
      send: async (run: RetryRun) => {
        try {
          publisherToken = await getPublisherToken(admin, run.bot_id);
          const publisherDigest = await digestText(publisherToken);
          if (
            !constantTimeHexEqual(
              run.bot_credential_digest,
              publisherDigest,
            )
          ) {
            throw new Error("POST13D_PUBLISHER_CREDENTIAL_MISMATCH");
          }
          await assertCanaryPublisherIdentity(publisherToken);
        } catch {
          throw new RetryFlowError("POST13D_CANARY_BOT_NOT_PROVEN", {
            delivery: "NONE",
          });
        }
        return await singleAttemptSend(
          publisherToken,
          run.telegram_chat_id,
          CONTENT_FACTORY_LEADS_CANARY_RETRY.PUBLICATION_TEXT,
          markup,
        );
      },
      finalize: async (run: RetryRun, delivered: { messageId: number }) => {
        const { data, error } = await admin.rpc(
          "finalize_content_factory_leads_canary_retry_delivery",
          {
            p_user_id: ownerId,
            p_canary_run_id: run.canary_run_id,
            p_delivery_lease_id: deliveryLeaseId,
            p_tg_message_id: delivered.messageId,
          },
        );
        return !error && data === true;
      },
      compensate: async (run: RetryRun, delivered: { messageId: number }) => {
        if (!publisherToken) {
          publisherToken = await getPublisherToken(admin, run.bot_id);
        }
        return await removeMarkup(
          publisherToken,
          run.telegram_chat_id,
          delivered.messageId,
        );
      },
      rollback: async (
        run: RetryRun,
        reason: string,
        proven: boolean,
      ) => {
        const proofHash = proven
          ? await digestText(JSON.stringify({
            canary_run_id: run.canary_run_id,
            delivery: "NOT_ACTIVE_OR_COMPENSATED",
          }))
          : null;
        const { data, error } = await admin.rpc(
          "rollback_content_factory_leads_canary_retry",
          {
            p_user_id: ownerId,
            p_canary_run_id: run.canary_run_id,
            p_reason: reason,
            p_proven: proven,
            p_compensation_proof_hash: proofHash,
          },
        );
        return !error && data === true;
      },
    });
    rawCf1 = "";
    publisherToken = "";
    return json(200, {
      status: result.state,
      stage: "POST13D",
      canary_run_id: runId,
      new_canary_count: 1,
      new_cf1_count: 1,
      new_test_publication_count: 1,
      bot_username: "@ContentFactoryLeads_bot",
      version: "POST13D_CANARY_RETRY_V1",
    });
  } catch {
    rawCf1 = "";
    publisherToken = "";
    return json(409, { error: "POST13D_PREPARATION_FAILED" });
  }
}

async function negativeCheck(admin: AdminClient): Promise<Response> {
  const { data, error } = await admin.rpc(
    "run_content_factory_leads_canary_retry_negative_check",
  );
  if (error || data !== true) {
    return json(409, { error: "POST13D_NEGATIVE_CHECK_FAILED" });
  }
  return json(200, {
    negative_check: "PASS",
    unknown_cf1: "REJECTED",
    event_creation: 0,
  });
}

async function complete(ownerId: string, admin: AdminClient): Promise<Response> {
  let publisherToken = "";
  const run = await getOwnerRun(ownerId, admin);
  if (!run || run.state !== "ACTIVE" || !run.tg_message_id) {
    return json(409, { error: "POST13D_COMPLETE_DISABLED" });
  }
  try {
    publisherToken = await getPublisherToken(admin, run.bot_id);
    const removed = await removeMarkup(
      publisherToken,
      run.telegram_chat_id,
      run.tg_message_id,
    );
    if (!removed) throw new Error("CTA_REMOVAL_UNCERTAIN");
    const proofHash = await digestText(JSON.stringify({
      canary_run_id: run.canary_run_id,
      telegram_message_id: run.tg_message_id,
      cta_removed: true,
    }));
    const { data, error } = await admin.rpc(
      "complete_content_factory_leads_canary_retry",
      {
        p_user_id: ownerId,
        p_canary_run_id: run.canary_run_id,
        p_cta_removal_proof_hash: proofHash,
      },
    );
    if (error || data !== true) {
      await admin.rpc("rollback_content_factory_leads_canary_retry", {
        p_user_id: ownerId,
        p_canary_run_id: run.canary_run_id,
        p_reason: "FINALIZE_FAILED",
        p_proven: true,
        p_compensation_proof_hash: proofHash,
      });
      throw new Error("POST13D_COMPLETE_RPC_FAILED");
    }
    publisherToken = "";
    return json(200, {
      status: "COMPLETED",
      cf1_status: "REVOKED",
      cta_removed: true,
      rotation_required: true,
    });
  } catch {
    publisherToken = "";
    await admin.rpc("rollback_content_factory_leads_canary_retry", {
      p_user_id: ownerId,
      p_canary_run_id: run.canary_run_id,
      p_reason: "COMPENSATION_UNCERTAIN",
      p_proven: false,
      p_compensation_proof_hash: null,
    });
    return json(409, { error: "POST13D_COMPLETE_FAILED" });
  }
}

async function rollback(ownerId: string, admin: AdminClient): Promise<Response> {
  let publisherToken = "";
  const run = await getOwnerRun(ownerId, admin);
  if (!run || !["PREPARING", "ACTIVE", "ROLLBACK_REQUIRED"].includes(run.state)) {
    return json(409, { error: "POST13D_ROLLBACK_DISABLED" });
  }
  let proven = run.state === "PREPARING" && run.delivery_attempts === 0;
  let proofHash: string | null = null;
  try {
    if (run.state === "ACTIVE" && run.tg_message_id) {
      publisherToken = await getPublisherToken(admin, run.bot_id);
      proven = await removeMarkup(
        publisherToken,
        run.telegram_chat_id,
        run.tg_message_id,
      );
      if (proven) {
        proofHash = await digestText(JSON.stringify({
          canary_run_id: run.canary_run_id,
          telegram_message_id: run.tg_message_id,
          cta_removed: true,
        }));
      }
    }
  } catch {
    proven = false;
  }
  const { data, error } = await admin.rpc(
    "rollback_content_factory_leads_canary_retry",
    {
      p_user_id: ownerId,
      p_canary_run_id: run.canary_run_id,
      p_reason: proven ? "OWNER_ROLLBACK" : "COMPENSATION_UNCERTAIN",
      p_proven: proven,
      p_compensation_proof_hash: proofHash,
    },
  );
  publisherToken = "";
  if (error || data !== true) {
    return json(409, { error: "POST13D_ROLLBACK_FAILED" });
  }
  return json(200, {
    status: proven ? "ROLLED_BACK" : "ROLLBACK_REQUIRED",
    cf1_status: "REVOKED",
    cta_removed: proofHash !== null,
  });
}

async function singleAttemptSend(
  botToken: string,
  chatId: string,
  text: string,
  replyMarkup: Record<string, unknown>,
): Promise<{ messageId: number; telegramChatId: string }> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      }),
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RetryFlowError("POST13D_TELEGRAM_TRANSPORT_AMBIGUOUS", {
      delivery: "AMBIGUOUS",
    });
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 65_536) {
    throw new RetryFlowError("POST13D_TELEGRAM_RESPONSE_AMBIGUOUS", {
      delivery: "AMBIGUOUS",
    });
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new RetryFlowError("POST13D_TELEGRAM_RESPONSE_AMBIGUOUS", {
      delivery: "AMBIGUOUS",
    });
  }
  if (response.ok && (value as { ok?: boolean })?.ok === true) {
    const normalized = normalizeRetrySendResult(value, chatId, text);
    if (
      JSON.stringify((value as { result?: { reply_markup?: unknown } }).result?.reply_markup) !==
        JSON.stringify(replyMarkup)
    ) {
      throw new RetryFlowError("POST13D_TELEGRAM_MARKUP_AMBIGUOUS", {
        delivery: "VERIFIED",
        delivered: {
          messageId: normalized.messageId,
          telegramChatId: normalized.telegramChatId,
        },
      });
    }
    return { messageId: normalized.messageId, telegramChatId: normalized.telegramChatId };
  }
  const telegramCode = Number((value as { error_code?: unknown })?.error_code);
  if (response.status >= 400 && response.status < 500 && telegramCode >= 400 && telegramCode < 500) {
    throw new RetryFlowError("POST13D_TELEGRAM_DELIVERY_REJECTED", {
      delivery: "NONE",
    });
  }
  throw new RetryFlowError("POST13D_TELEGRAM_DELIVERY_AMBIGUOUS", {
    delivery: "AMBIGUOUS",
  });
}

async function assertCanaryPublisherIdentity(botToken: string): Promise<void> {
  const value = await boundedTelegramApi(fetch, botToken, "getMe");
  const result = value?.result as Record<string, unknown> | undefined;
  if (
    value?.ok !== true || !result || result.is_bot !== true ||
    result.username !== "ContentFactoryLeads_bot"
  ) {
    throw new Error("POST13D_CANARY_BOT_IDENTITY_MISMATCH");
  }
}

async function removeMarkup(
  botToken: string,
  chatId: string,
  messageId: number,
): Promise<boolean> {
  return isVerifiedMarkupRemoval(
    await boundedTelegramApi(
      fetch,
      botToken,
      "editMessageReplyMarkup",
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      },
      { acceptedStatuses: [400] },
    ),
    chatId,
    messageId,
  );
}

async function getOwnerRun(
  ownerId: string,
  admin: AdminClient,
): Promise<RetryRun | null> {
  const { data, error } = await admin.from(
    "telegram_attribution_canary_retry_runs",
  ).select(
    "canary_run_id,user_id,bot_id,telegram_chat_id,telegram_post_id,tg_message_id,delivery_attempts,state",
  ).eq("stage_key", "POST13D").eq("user_id", ownerId).maybeSingle();
  return error ? null : data as RetryRun | null;
}

async function getPublisherToken(
  admin: AdminClient,
  botId: string,
): Promise<string> {
  const { data: bot } = await admin.from("bots")
    .select("token_secret_id,is_active").eq("id", botId).maybeSingle();
  if (!bot?.is_active || !bot.token_secret_id) {
    throw new Error("PUBLISHER_BOT_UNAVAILABLE");
  }
  const { data, error } = await admin.rpc("get_bot_token", {
    p_secret_id: bot.token_secret_id,
  });
  if (error || typeof data !== "string" || data.length < 30) {
    throw new Error("PUBLISHER_TOKEN_UNAVAILABLE");
  }
  return data;
}

async function authenticatedOwner(
  req: Request,
  admin: AdminClient,
): Promise<string | null> {
  const bearer = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(
    req.headers.get("authorization") ?? "",
  )?.[1];
  if (!bearer) return null;
  const { data, error } = await admin.auth.getUser(bearer);
  return error || !data.user ? null : data.user.id;
}

function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
