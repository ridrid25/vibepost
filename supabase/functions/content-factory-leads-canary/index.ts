import { createClient } from "npm:@supabase/supabase-js@2";
import {
  assertCanaryRuntime,
  boundedTelegramApi,
  constantTimeHexEqual,
  CONTENT_FACTORY_LEADS_CANARY,
  deriveCanaryIdentity,
  digestCanaryToken,
  digestText,
  normalizeCanaryEvidencePage,
  normalizeEmptyWebhookInfo,
  normalizeTelegramApiIdentity,
  normalizeWebhookInfo,
  readActivationBody,
  readTelegramUpdate,
  webhookCallbackResponse,
  webhookNoopResponse,
  webhookStartResponse,
} from "../_shared/content-factory-leads-canary.mjs";
import { executeRuntimeActivation } from "../_shared/content-factory-leads-canary-orchestrator.mjs";
import {
  constantTimeHexEqual as retryConstantTimeHexEqual,
  deriveCanaryIdentity as deriveRetryIdentity,
  digestRetryToken,
  digestText as digestRetryText,
  normalizeRetryEvidence,
  normalizeRetryRuntime,
  readRetryTelegramUpdate,
  retryCallbackResponse,
  retryNoopResponse,
  retryStartResponse,
} from "../_shared/content-factory-leads-canary-retry.mjs";

const FUNCTION_NAME = "content-factory-leads-canary";

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/u, "");
  if (req.method === "POST" && path.endsWith(`/${FUNCTION_NAME}/activate`)) {
    return handleActivation(req);
  }
  if (req.method === "POST" && path.endsWith(`/${FUNCTION_NAME}/webhook`)) {
    return handleWebhook(req);
  }
  if (
    req.method === "POST" &&
    path.endsWith(`/${FUNCTION_NAME}/confirm-deactivation`)
  ) {
    return handleDeactivationConfirmation(req);
  }
  if (req.method === "GET" && path.endsWith(`/${FUNCTION_NAME}/evidence`)) {
    return handleEvidence(req);
  }
  if (
    req.method === "GET" &&
    path.endsWith(`/${FUNCTION_NAME}/evidence-post13d`)
  ) {
    return handleRetryEvidence(req);
  }
  if (
    req.method === "GET" && path.endsWith(`/${FUNCTION_NAME}/audit-post13d`)
  ) {
    return handleRetryAudit(req);
  }
  if (req.method === "GET" && path.endsWith(`/${FUNCTION_NAME}/health`)) {
    const runtime = await getRuntime();
    const retryRuntime = await getRetryRuntime();
    return json(200, {
      status: runtime?.state ?? "NOT_CONFIGURED",
      post13d_status: retryRuntime?.state ?? "NOT_CONFIGURED",
      version: "POST13C_CANARY_V1",
    });
  }
  return json(404, { error: "NOT_FOUND" });
});

async function handleActivation(req: Request): Promise<Response> {
  let botToken = "";
  let credentialDigest = "";
  let leaseId = "";
  try {
    ({ botToken } = await readActivationBody(req));
    credentialDigest = await digestText(botToken);
    // The owner-held credential never leaves the Termux -> TLS request. The
    // server proves the exact dedicated bot identity before creating the
    // one-use, 15-minute credential-bound authorization row. This avoids
    // exporting either the raw token or its digest through chat/evidence.
    const verifiedIdentity = normalizeTelegramApiIdentity(
      await telegramApi(botToken, "getMe"),
    );
    const admin = adminClient();
    let before = await getRuntime();
    if (!before) {
      const { data, error } = await admin.rpc(
        "authorize_content_factory_leads_canary",
        {
          p_credential_digest: credentialDigest,
          p_expires_at: new Date(Date.now() + 180_000).toISOString(),
        },
      );
      if (error || data !== true) {
        throw new Error("ACTIVATION_AUTHORIZATION_FAILED");
      }
      before = await getRuntime();
    }
    if (
      !before || before.state !== "AUTHORIZED" ||
      !constantTimeHexEqual(
        String(before.bot_credential_digest ?? ""),
        credentialDigest,
      )
    ) {
      return json(409, { error: "ACTIVATION_DISABLED" });
    }

    leaseId = crypto.randomUUID();
    const leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
    const webhookSecret = randomBase64Url32();
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const webhookUrl = `${supabaseUrl}/functions/v1/${FUNCTION_NAME}/webhook`;
    const webhookConfig = Object.freeze({
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
      max_connections: 1,
    });
    const webhookSecretDigest = await digestText(webhookSecret);
    const webhookConfigHash = await digestText(JSON.stringify({
      url: webhookUrl,
      webhook_secret_digest: webhookSecretDigest,
      allowed_updates: webhookConfig.allowed_updates,
      drop_pending_updates: webhookConfig.drop_pending_updates,
      max_connections: webhookConfig.max_connections,
    }));
    const activated = await executeRuntimeActivation({
      claim: async () => {
        const { data, error } = await admin.rpc(
          "claim_content_factory_leads_canary_activation",
          {
            p_credential_digest: credentialDigest,
            p_lease_id: leaseId,
            p_lease_expires_at: leaseExpiresAt,
          },
        );
        if (error) throw new Error("ACTIVATION_CLAIM_UNCERTAIN");
        return data === true;
      },
      verifyIdentity: () => verifiedIdentity,
      setWebhook: async () => {
        const result = await telegramApi(botToken, "setWebhook", webhookConfig);
        if (result?.ok !== true || result?.result !== true) {
          throw new Error("SET_WEBHOOK_FAILED");
        }
      },
      verifyWebhook: async () =>
        normalizeWebhookInfo(
          await telegramApi(botToken, "getWebhookInfo"),
          webhookUrl,
        ),
      complete: async () => {
        const { data, error } = await admin.rpc(
          "complete_content_factory_leads_canary_activation",
          {
            p_lease_id: leaseId,
            p_webhook_secret_digest: webhookSecretDigest,
            p_webhook_config_hash: webhookConfigHash,
          },
        );
        return !error && data === true;
      },
      removeAndVerifyWebhook: () => attemptVerifiedWebhookRemoval(botToken),
      completeDeactivation: async () => {
        const { data, error } = await admin.rpc(
          "complete_content_factory_leads_canary_deactivation",
          {
            p_credential_digest: credentialDigest,
          },
        );
        return !error && data === true;
      },
      markRollbackRequired: async () => {
        const { data, error } = await admin.rpc(
          "mark_content_factory_leads_canary_rollback_required",
          {
            p_lease_id: leaseId,
            p_credential_digest: credentialDigest,
          },
        );
        return !error && data === true;
      },
    });
    botToken = "";
    credentialDigest = "";
    return json(200, {
      status: activated.state,
      bot_username: `@${activated.identity.username}`,
      token_valid: true,
      version: "POST13C_CANARY_V1",
    });
  } catch {
    botToken = "";
    credentialDigest = "";
    return json(400, { error: "ACTIVATION_FAILED" });
  }
}

async function handleWebhook(req: Request): Promise<Response> {
  const retryRuntime = await getRetryRuntime();
  if (retryRuntime?.state === "ACTIVE") {
    return handleRetryWebhook(req, retryRuntime);
  }
  return handlePost13CWebhook(req);
}

async function handlePost13CWebhook(req: Request): Promise<Response> {
  try {
    const runtime = assertCanaryRuntime(await getRuntime(), "ACTIVE");
    const suppliedSecret = req.headers.get("x-telegram-bot-api-secret-token") ??
      "";
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(suppliedSecret)) {
      return webhookJson(webhookNoopResponse());
    }
    const suppliedDigest = await digestText(suppliedSecret);
    if (!constantTimeHexEqual(runtime.webhook_secret_digest, suppliedDigest)) {
      return webhookJson(webhookNoopResponse());
    }

    const update = await readTelegramUpdate(req);
    const hmacKey = Deno.env.get("POST13C_SUBJECT_HMAC_KEY") ?? "";
    const subjectId = await deriveCanaryIdentity(
      hmacKey,
      "subject",
      update.actorId,
    );
    const sourceEventId = await deriveCanaryIdentity(
      hmacKey,
      "update",
      update.updateId,
    );
    const admin = adminClient();

    if (update.kind === "BOT_START") {
      const tokenDigest = await digestCanaryToken(update.token);
      const { data, error } = await admin.rpc(
        "record_content_factory_leads_bot_start",
        {
          p_token_digest: tokenDigest,
          p_subject_id: subjectId,
          p_source_event_id: sourceEventId,
        },
      );
      if (error || data !== true) return webhookJson(webhookNoopResponse());
      return webhookJson(webhookStartResponse(update.transientChatId));
    }

    const { data, error } = await admin.rpc(
      "record_content_factory_leads_canary_lead",
      {
        p_subject_id: subjectId,
        p_source_event_id: sourceEventId,
      },
    );
    if (error || data !== true) return webhookJson(webhookNoopResponse());
    return webhookJson(webhookCallbackResponse(update.callbackQueryId));
  } catch {
    return webhookJson(webhookNoopResponse());
  }
}

async function handleRetryWebhook(
  req: Request,
  rawRuntime: Record<string, unknown>,
): Promise<Response> {
  try {
    const runtime = normalizeRetryRuntime(rawRuntime, "ACTIVE");
    const suppliedSecret =
      req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(suppliedSecret)) {
      return webhookJson(retryNoopResponse());
    }
    const suppliedDigest = await digestRetryText(suppliedSecret);
    if (
      !retryConstantTimeHexEqual(
        runtime.webhook_secret_digest,
        suppliedDigest,
      )
    ) {
      return webhookJson(retryNoopResponse());
    }
    const update = await readRetryTelegramUpdate(req, runtime.canary_run_id);
    const hmacKey = Deno.env.get("POST13C_SUBJECT_HMAC_KEY") ?? "";
    const subjectId = await deriveRetryIdentity(
      hmacKey,
      "subject",
      update.actorId,
    );
    const sourceEventId = await deriveRetryIdentity(
      hmacKey,
      "update",
      update.updateId,
    );
    const admin = adminClient();
    if (update.kind === "BOT_START") {
      const tokenDigest = await digestRetryToken(update.token);
      const { data, error } = await admin.rpc(
        "record_content_factory_leads_retry_bot_start",
        {
          p_token_digest: tokenDigest,
          p_subject_id: subjectId,
          p_source_event_id: sourceEventId,
        },
      );
      if (error || data !== "RECORDED") {
        return webhookJson(retryNoopResponse());
      }
      return webhookJson(
        retryStartResponse(update.transientChatId, runtime.canary_run_id),
      );
    }
    const { data, error } = await admin.rpc(
      "record_content_factory_leads_retry_canary_lead",
      {
        p_canary_run_id: runtime.canary_run_id,
        p_subject_id: subjectId,
        p_source_event_id: sourceEventId,
      },
    );
    if (error || !["RECORDED", "DUPLICATE"].includes(data)) {
      return webhookJson(retryNoopResponse());
    }
    return webhookJson(
      retryCallbackResponse(update.callbackQueryId, data === "DUPLICATE"),
    );
  } catch {
    return webhookJson(retryNoopResponse());
  }
}

async function handleDeactivationConfirmation(req: Request): Promise<Response> {
  const runtime = await getRuntime();
  if (
    !runtime || typeof runtime.state !== "string" ||
    !["ROLLBACK_REQUIRED", "DEACTIVATING"].includes(runtime.state)
  ) {
    return json(409, { error: "DEACTIVATION_DISABLED" });
  }
  let botToken = "";
  try {
    ({ botToken } = await readActivationBody(req));
    const credentialDigest = await digestText(botToken);
    if (
      !constantTimeHexEqual(runtime.bot_credential_digest, credentialDigest)
    ) {
      botToken = "";
      return json(401, { error: "DEACTIVATION_UNAUTHORIZED" });
    }
    normalizeEmptyWebhookInfo(await telegramApi(botToken, "getWebhookInfo"));
    const { data, error } = await adminClient().rpc(
      "complete_content_factory_leads_canary_deactivation",
      { p_credential_digest: credentialDigest },
    );
    botToken = "";
    if (error || data !== true) {
      return json(409, { error: "DEACTIVATION_NOT_FINAL" });
    }
    return json(200, { status: "ROLLED_BACK", version: "POST13C_CANARY_V1" });
  } catch {
    botToken = "";
    return json(400, { error: "DEACTIVATION_NOT_PROVEN" });
  }
}

async function handleEvidence(req: Request): Promise<Response> {
  try {
    const authorization = req.headers.get("authorization") ?? "";
    const bearer = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(authorization)?.[1];
    if (!bearer) return json(401, { error: "UNAUTHORIZED" });
    const admin = adminClient();
    const { data: authData, error: authError } = await admin.auth.getUser(
      bearer,
    );
    if (authError || !authData.user) {
      return json(401, { error: "UNAUTHORIZED" });
    }
    const { data, error } = await admin.rpc(
      "resolve_content_factory_leads_canary_evidence",
      {
        p_user_id: authData.user.id,
      },
    );
    if (error) return json(503, { error: "EVIDENCE_UNAVAILABLE" });
    const events = normalizeCanaryEvidencePage(data ?? []);
    return json(200, {
      evidence_root: "CANARY_TEST_EVIDENCE",
      source_system: "content_factory_leads_canary",
      events,
    });
  } catch {
    return json(400, { error: "EVIDENCE_INVALID" });
  }
}

async function handleRetryEvidence(req: Request): Promise<Response> {
  try {
    const ownerId = await authenticatedOwner(req);
    if (!ownerId) return json(401, { error: "UNAUTHORIZED" });
    const { data, error } = await adminClient().rpc(
      "resolve_content_factory_leads_canary_retry_evidence",
      { p_user_id: ownerId },
    );
    if (error) return json(503, { error: "POST13D_EVIDENCE_UNAVAILABLE" });
    const events = normalizeRetryEvidence(data ?? []);
    return json(200, {
      evidence_root: "POST13D_CANARY_TEST_EVIDENCE",
      source_system: "content_factory_leads_canary_retry",
      events,
    });
  } catch {
    return json(400, { error: "POST13D_EVIDENCE_INVALID" });
  }
}

async function handleRetryAudit(req: Request): Promise<Response> {
  try {
    const ownerId = await authenticatedOwner(req);
    if (!ownerId) return json(401, { error: "UNAUTHORIZED" });
    const runtime = await getRetryRuntime();
    const requestedPhase = new URL(req.url).searchParams.get("phase");
    const phase = requestedPhase ?? (runtime?.state === "COMPLETED"
      ? "COMPLETED"
      : runtime?.state === "ROLLED_BACK"
      ? "ROLLED_BACK"
      : "ACTIVE_COMPLETE");
    if (
      !["PRE_OWNER", "ACTIVE_COMPLETE", "COMPLETED", "ROLLED_BACK"].includes(
        phase,
      ) ||
      (["PRE_OWNER", "ACTIVE_COMPLETE"].includes(phase) &&
        runtime?.state !== "ACTIVE") ||
      (phase === "COMPLETED" && runtime?.state !== "COMPLETED") ||
      (phase === "ROLLED_BACK" && runtime?.state !== "ROLLED_BACK")
    ) {
      return json(409, { error: "POST13D_AUDIT_PHASE_INVALID" });
    }
    const { data, error } = await adminClient().rpc(
      "audit_content_factory_leads_canary_retry",
      { p_phase: phase },
    );
    if (error || !Array.isArray(data)) {
      return json(503, { error: "POST13D_AUDIT_UNAVAILABLE" });
    }
    return json(200, {
      phase,
      passed: data.every((row) => row.passed === true),
      checks: data.map((row) => ({
        check_name: row.check_name,
        passed: row.passed,
        row_count: row.row_count,
        audit_version: row.audit_version,
      })),
    });
  } catch {
    return json(400, { error: "POST13D_AUDIT_INVALID" });
  }
}

async function getRuntime(): Promise<Record<string, unknown> | null> {
  const { data, error } = await adminClient()
    .from("telegram_canary_runtime_state")
    .select(
      "singleton_key,bot_username,state,bot_credential_digest,webhook_secret_digest,webhook_config_hash,activation_lease_id,activation_lease_expires_at",
    )
    .eq("singleton_key", "POST13C")
    .maybeSingle();
  return error ? null : data;
}

async function getRetryRuntime(): Promise<Record<string, unknown> | null> {
  const { data, error } = await adminClient()
    .from("telegram_attribution_canary_retry_runs")
    .select(
      "canary_run_id,stage_key,user_id,state,bot_username,webhook_secret_digest,webhook_config_hash",
    )
    .eq("stage_key", "POST13D")
    .maybeSingle();
  return error ? null : data;
}

async function authenticatedOwner(req: Request): Promise<string | null> {
  const bearer = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(
    req.headers.get("authorization") ?? "",
  )?.[1];
  if (!bearer) return null;
  const { data, error } = await adminClient().auth.getUser(bearer);
  return error || !data.user ? null : data.user.id;
}

function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

function telegramApi(
  botToken: string,
  method: string,
  body?: unknown,
): Promise<TelegramApiResponse> {
  return boundedTelegramApi(fetch, botToken, method, body ?? {});
}

type TelegramApiResponse = {
  ok?: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
};

async function attemptVerifiedWebhookRemoval(
  botToken: string,
): Promise<boolean> {
  try {
    const removed = await telegramApi(botToken, "deleteWebhook", {
      drop_pending_updates: true,
    });
    if (removed?.ok !== true || removed?.result !== true) return false;
    normalizeEmptyWebhookInfo(await telegramApi(botToken, "getWebhookInfo"));
    return true;
  } catch {
    return false;
  }
}

function randomBase64Url32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/u,
    "",
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

function webhookJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export const POST13C_CANARY_CONTRACT = Object.freeze({
  destination: CONTENT_FACTORY_LEADS_CANARY.DESTINATION,
  botUsername: CONTENT_FACTORY_LEADS_CANARY.BOT_USERNAME,
  version: "POST13C_CANARY_V1",
});
