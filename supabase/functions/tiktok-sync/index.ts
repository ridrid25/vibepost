// Manual and scheduled TikTok synchronization.
//
// Until schema_status is explicitly verified, this function only captures
// sanitized fixtures and backend-only raw video items. It does not normalize
// undocumented or unverified fields into Content Brigade analytics tables.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  callerIsServiceRole,
  chunks,
  cursorFromResponse,
  fieldInventory,
  hasMoreFromResponse,
  listVideos,
  normalizeTikTokVideos,
  queryVideos,
  refreshAccessToken,
  sanitizeForFixture,
  schemaGateAllowsNormalization,
  sha256Hex,
  TikTokApiError,
  TokenBundle,
  videosFromResponse,
} from "../_shared/tiktok.ts";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("VIBEPOST_APP_ORIGIN") ?? "https://chrono-vibepost.lovable.app",
  "Access-Control-Allow-Headers": "authorization, x-client-info, x-supabase-api-version, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function saveFixture(
  admin: SupabaseClient,
  context: { userId: string; accountId: string; syncRunId: string },
  endpoint: string,
  response: Record<string, unknown>,
): Promise<string> {
  const redacted = sanitizeForFixture(response);
  const inventory = fieldInventory(response);
  const schemaFingerprint = await sha256Hex(JSON.stringify(
    inventory.map(({ path, types }) => ({ path, types })),
  ));
  const { error } = await admin.from("tiktok_api_fixtures").upsert({
    user_id: context.userId,
    account_id: context.accountId,
    sync_run_id: context.syncRunId,
    endpoint,
    redacted_response: redacted,
    response_sha256: await sha256Hex(JSON.stringify(redacted)),
    field_inventory: inventory,
    schema_fingerprint: schemaFingerprint,
  }, { onConflict: "account_id,endpoint,response_sha256", ignoreDuplicates: true });
  if (error) throw new Error(`fixture save failed: ${error.message}`);
  return schemaFingerprint;
}

async function saveRawVideos(
  admin: SupabaseClient,
  context: { userId: string; accountId: string; syncRunId: string },
  endpoint: string,
  response: Record<string, unknown>,
): Promise<number> {
  const videos = videosFromResponse(response);
  let written = 0;
  for (const video of videos) {
    const payloadSha256 = await sha256Hex(JSON.stringify(video));
    const { data, error } = await admin.from("tiktok_raw_video_items").upsert({
      user_id: context.userId,
      account_id: context.accountId,
      sync_run_id: context.syncRunId,
      endpoint,
      external_video_id: typeof video.id === "string" ? video.id : null,
      raw_payload: video,
      payload_sha256: payloadSha256,
    }, { onConflict: "sync_run_id,endpoint,payload_sha256", ignoreDuplicates: true })
      .select("id").maybeSingle();
    if (error) throw new Error(`raw video save failed: ${error.message}`);
    if (data) written++;
  }
  return written;
}

async function saveNormalizedVideos(
  admin: SupabaseClient,
  context: { accountId: string; syncRunId: string },
  schemaFingerprint: string,
  response: Record<string, unknown>,
  collectedAt: string,
): Promise<number> {
  const videos = normalizeTikTokVideos(response);
  if (!videos.length) return 0;
  const { data, error } = await admin.rpc("ingest_tiktok_video_snapshots", {
    p_account_id: context.accountId,
    p_sync_run_id: context.syncRunId,
    p_endpoint: "/v2/video/query/",
    p_schema_fingerprint: schemaFingerprint,
    p_collected_at: collectedAt,
    p_items: videos,
  });
  if (error) throw new Error(`normalized video save failed: ${error.message}`);
  return typeof data === "number" ? data : videos.length;
}

async function captureAll(
  admin: SupabaseClient,
  context: { userId: string; accountId: string; syncRunId: string },
  accessToken: string,
  initialCursor: number | null,
  schemaGate: {
    schemaStatus: string;
    approvedByEndpoint: Record<string, string[]>;
  },
): Promise<{
  seen: number;
  written: number;
  normalized: number;
  cursor: number | null;
  hasMore: boolean;
  schemaFingerprints: string[];
  schemaObservations: Array<{ endpoint: string; fingerprint: string }>;
}> {
  const ids = new Set<string>();
  const schemaFingerprints = new Set<string>();
  const schemaObservationKeys = new Set<string>();
  const schemaObservations: Array<{ endpoint: string; fingerprint: string }> = [];
  const observeSchema = (endpoint: string, fingerprint: string) => {
    schemaFingerprints.add(fingerprint);
    const key = `${endpoint}\u0000${fingerprint}`;
    if (!schemaObservationKeys.has(key)) {
      schemaObservationKeys.add(key);
      schemaObservations.push({ endpoint, fingerprint });
    }
  };
  let cursor: number | null = initialCursor;
  let hasMore = false;
  let seen = 0;
  let written = 0;
  let normalized = 0;
  const pendingNormalization: Array<{
    fingerprint: string;
    response: Record<string, unknown>;
    collectedAt: string;
  }> = [];

  // Hard page cap prevents a malformed cursor from keeping an Edge invocation
  // alive forever. The next scheduled run will continue refreshing the recent
  // public set.
  for (let page = 0; page < 10; page++) {
    const response = await listVideos(accessToken, cursor);
    const fingerprint = await saveFixture(admin, context, "/v2/video/list/", response);
    const videos = videosFromResponse(response);
    // 19.10.2026 ТикТок один раз прислал пустой список: у такого ответа нет полей
    // ролика, отпечаток другой, и защита сбросила утверждённую схему — статистика
    // не писалась шесть дней. Пустая страница о форме роликов ничего не говорит.
    if (videos.length) observeSchema("/v2/video/list/", fingerprint);
    for (const video of videos) if (typeof video.id === "string") ids.add(video.id);
    seen += videos.length;
    written += await saveRawVideos(admin, context, "/v2/video/list/", response);

    const nextCursor = cursorFromResponse(response);
    hasMore = hasMoreFromResponse(response);
    if (!hasMore || nextCursor === null || nextCursor === cursor) {
      if (nextCursor === null || nextCursor === cursor) hasMore = false;
      cursor = nextCursor;
      break;
    }
    cursor = nextCursor;
  }

  for (const batch of chunks([...ids], 20)) {
    const response = await queryVideos(accessToken, batch);
    const fingerprint = await saveFixture(admin, context, "/v2/video/query/", response);
    observeSchema("/v2/video/query/", fingerprint);
    await saveRawVideos(admin, context, "/v2/video/query/", response);
    pendingNormalization.push({ fingerprint, response, collectedAt: new Date().toISOString() });
  }

  const observedFingerprints = [...schemaFingerprints];
  if (schemaGateAllowsNormalization(
    schemaGate.schemaStatus,
    schemaGate.approvedByEndpoint,
    schemaObservations,
  )) {
    for (const item of pendingNormalization) {
      normalized += await saveNormalizedVideos(
        admin,
        context,
        item.fingerprint,
        item.response,
        item.collectedAt,
      );
    }
  }
  return {
    seen,
    written,
    normalized,
    cursor,
    hasMore,
    schemaFingerprints: observedFingerprints,
    schemaObservations,
  };
}

async function refreshAndPersist(
  admin: SupabaseClient,
  account: { id: string },
  bundle: TokenBundle,
  clientKey: string,
  clientSecret: string,
  expectedGeneration: number,
): Promise<{ bundle: TokenBundle; accessExpiresAt: string; refreshExpiresAt: string; tokenGeneration: number }> {
  const token = await refreshAccessToken({
    clientKey,
    clientSecret,
    refreshToken: bundle.refresh_token,
  });
  const nextBundle = {
    access_token: token.access_token,
    // TikTok can rotate refresh tokens; always persist the returned value.
    refresh_token: token.refresh_token,
  };
  const accessExpiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
  const refreshExpiresAt = new Date(Date.now() + token.refresh_expires_in * 1000).toISOString();
  const { error: vaultError } = await admin.rpc("store_tiktok_token_bundle", {
    p_account_id: account.id,
    p_bundle: JSON.stringify(nextBundle),
    p_expected_generation: expectedGeneration,
  });
  if (vaultError) throw new Error(`token vault update failed: ${vaultError.message}`);
  const { error: accountError } = await admin.from("tiktok_accounts").update({
    scopes: String(token.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    access_expires_at: accessExpiresAt,
    refresh_expires_at: refreshExpiresAt,
    auth_status: "active",
    last_error: null,
  }).eq("id", account.id).eq("token_generation", expectedGeneration + 1);
  if (accountError) throw new Error(`account token metadata update failed: ${accountError.message}`);
  return {
    bundle: nextBundle,
    accessExpiresAt,
    refreshExpiresAt,
    tokenGeneration: expectedGeneration + 1,
  };
}

async function synchronizeClaimedAccount(
  admin: SupabaseClient,
  account: {
    id: string;
    user_id: string;
    provider_app_id: string;
    auth_status: string;
    access_expires_at: string | null;
    refresh_expires_at: string | null;
    token_generation: number;
    backfill_cursor: number | null;
    backfill_complete: boolean;
    schema_status: string;
    verified_schema_fingerprints: string[] | null;
    verified_endpoint_fingerprints: Record<string, string[]> | null;
    sync_lease_token: string | null;
  },
  triggerType: "manual" | "scheduled",
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const { data: existingRun } = await admin.from("tiktok_sync_runs")
    .select("id,status,items_seen,items_written,error")
    .eq("account_id", account.id)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  let run: { id: string } | null = null;
  if (existingRun?.status === "failed") {
    // A caller retrying the same logical operation must be able to recover
    // from a transient failure. The status predicate makes this an atomic
    // failed -> running claim; a concurrent retry gets zero rows and dedupes.
    const { data: reclaimed, error: reclaimError } = await admin.from("tiktok_sync_runs")
      .update({
        status: "running",
        started_at: new Date().toISOString(),
        finished_at: null,
        http_status: null,
        api_error_code: null,
        tiktok_log_id: null,
        error: null,
        items_seen: 0,
        items_written: 0,
      })
      .eq("id", existingRun.id)
      .eq("status", "failed")
      .select("id")
      .maybeSingle();
    if (reclaimError) throw new Error(`sync retry claim failed: ${reclaimError.message}`);
    if (reclaimed) run = reclaimed;
    else {
      const { data: current } = await admin.from("tiktok_sync_runs")
        .select("id,status,items_seen,items_written,error")
        .eq("id", existingRun.id).single();
      return { account_id: account.id, deduplicated: true, ...current };
    }
  } else if (existingRun) {
    // running/completed are true duplicates; reauth_required must wait for a
    // fresh OAuth consent flow rather than hammering the same refresh token.
    return { account_id: account.id, deduplicated: true, ...existingRun };
  } else {
    const { data: inserted, error: runError } = await admin.from("tiktok_sync_runs").insert({
      user_id: account.user_id,
      account_id: account.id,
      trigger_type: triggerType,
      idempotency_key: idempotencyKey,
      cursor_before: account.backfill_complete ? null : account.backfill_cursor,
    }).select("id").single();
    if (runError?.code === "23505") {
      const { data: concurrent } = await admin.from("tiktok_sync_runs")
        .select("id,status,items_seen,items_written,error")
        .eq("account_id", account.id)
        .eq("idempotency_key", idempotencyKey)
        .single();
      return { account_id: account.id, deduplicated: true, ...concurrent };
    }
    if (runError || !inserted) throw new Error(runError?.message ?? "sync run create failed");
    run = inserted;
  }
  if (!run) throw new Error("sync run claim failed");

  const context = { userId: account.user_id, accountId: account.id, syncRunId: run.id };
  let tokenGeneration = account.token_generation;
  try {
    const clientKey = Deno.env.get("TIKTOK_CLIENT_KEY");
    const clientSecret = Deno.env.get("TIKTOK_CLIENT_SECRET");
    if (!clientKey || !clientSecret || account.provider_app_id !== clientKey) {
      throw new Error("TikTok app credentials are missing or do not match this account");
    }

    const { data: rawBundle, error: bundleError } = await admin
      .rpc("get_tiktok_token_bundle", { p_account_id: account.id });
    if (bundleError || !rawBundle) throw new Error("TikTok token bundle is missing");
    let bundle = JSON.parse(rawBundle) as TokenBundle;
    if (!bundle.access_token || !bundle.refresh_token) throw new Error("TikTok token bundle is invalid");

    let refreshed = false;
    if (!account.access_expires_at || new Date(account.access_expires_at).getTime() < Date.now() + 5 * 60_000) {
      const refresh = await refreshAndPersist(
        admin, account, bundle, clientKey, clientSecret, tokenGeneration,
      );
      bundle = refresh.bundle;
      tokenGeneration = refresh.tokenGeneration;
      refreshed = true;
    }

    let capture;
    try {
      capture = await captureAll(
        admin,
        context,
        bundle.access_token,
        account.backfill_complete ? null : account.backfill_cursor,
        {
          schemaStatus: account.schema_status,
          approvedByEndpoint: account.verified_endpoint_fingerprints ?? {},
        },
      );
    } catch (error) {
      const tokenInvalid = error instanceof TikTokApiError && error.code === "access_token_invalid";
      if (!tokenInvalid || refreshed) throw error;
      const refresh = await refreshAndPersist(
        admin, account, bundle, clientKey, clientSecret, tokenGeneration,
      );
      bundle = refresh.bundle;
      tokenGeneration = refresh.tokenGeneration;
      capture = await captureAll(
        admin,
        context,
        bundle.access_token,
        account.backfill_complete ? null : account.backfill_cursor,
        {
          schemaStatus: account.schema_status,
          approvedByEndpoint: account.verified_endpoint_fingerprints ?? {},
        },
      );
    }

    await admin.from("tiktok_sync_runs").update({
      status: "completed",
      finished_at: new Date().toISOString(),
      cursor_after: capture.cursor,
      items_seen: capture.seen,
      items_written: capture.written,
    }).eq("id", run.id);
    const backfillUpdate = account.backfill_complete
      ? {}
      : {
          backfill_cursor: capture.hasMore ? capture.cursor : null,
          backfill_complete: !capture.hasMore,
        };
    const schemaStillVerified = schemaGateAllowsNormalization(
      account.schema_status,
      account.verified_endpoint_fingerprints ?? {},
      capture.schemaObservations,
    );
    // Нечего сверять (одни пустые ответы) — утверждение не трогаем.
    const schemaApprovalUpdate = capture.schemaObservations.length === 0
      ? {}
      : schemaStillVerified
      ? { schema_status: "verified" }
      : {
          schema_status: "fixture_captured",
          schema_verified_at: null,
          schema_verified_by: null,
          verified_fixture_hashes: null,
          verified_schema_fingerprints: null,
          verified_endpoint_fingerprints: null,
        };
    await admin.from("tiktok_accounts").update({
      ...schemaApprovalUpdate,
      last_synced_at: new Date().toISOString(),
      next_sync_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      last_error: null,
      last_tiktok_log_id: null,
      ...backfillUpdate,
    }).eq("id", account.id).eq("token_generation", tokenGeneration);
    return { account_id: account.id, run_id: run.id, status: "completed", ...capture };
  } catch (error) {
    const apiError = error instanceof TikTokApiError ? error : null;
    const needsReauth = apiError?.code === "invalid_grant" ||
      apiError?.code === "access_token_invalid" ||
      apiError?.code === "token_endpoint_ambiguous" ||
      apiError?.code === "scope_not_authorized" || apiError?.code === "scope_permission_missed";
    const message = error instanceof Error ? error.message : String(error);
    const nextStatus = needsReauth ? "reauth_required" : "failed";
    await admin.from("tiktok_sync_runs").update({
      status: nextStatus,
      finished_at: new Date().toISOString(),
      http_status: apiError?.status ?? null,
      api_error_code: apiError?.code ?? "sync_failed",
      tiktok_log_id: apiError?.logId ?? null,
      error: message.slice(0, 500),
    }).eq("id", run.id);
    await admin.from("tiktok_accounts").update({
      // Network/429/5xx failures must remain retryable. Only authorization
      // failures stop scheduled sync and require a new consent flow.
      auth_status: needsReauth ? "reauth_required" : "active",
      last_error: message.slice(0, 500),
      last_tiktok_log_id: apiError?.logId ?? null,
      next_sync_at: new Date(Date.now() + (apiError?.status === 429 ? 15 : 5) * 60_000).toISOString(),
    }).eq("id", account.id).eq("token_generation", tokenGeneration);
    return {
      account_id: account.id,
      run_id: run.id,
      status: nextStatus,
      error: needsReauth ? "tiktok_reauthorization_required" : "tiktok_sync_failed",
      code: apiError?.code ?? "sync_failed",
      log_id: apiError?.logId ?? null,
    };
  }
}

async function synchronizeAccount(
  admin: SupabaseClient,
  account: {
    id: string;
    user_id: string;
    provider_app_id: string;
    auth_status: string;
    access_expires_at: string | null;
    refresh_expires_at: string | null;
    token_generation: number;
    backfill_cursor: number | null;
    backfill_complete: boolean;
    schema_status: string;
    verified_schema_fingerprints: string[] | null;
    verified_endpoint_fingerprints: Record<string, string[]> | null;
    sync_lease_token: string;
  },
  triggerType: "manual" | "scheduled",
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  try {
    return await synchronizeClaimedAccount(admin, account, triggerType, idempotencyKey);
  } finally {
    // Guarded release means a stale invocation can never clear a newer lease.
    const { error } = await admin.rpc("release_tiktok_account_sync", {
      p_account_id: account.id,
      p_lease_token: account.sync_lease_token,
    });
    if (error) console.error("TikTok sync lease release failed", { account_id: account.id });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    serviceKey,
  );
  // verify_jwt=true in config.toml means the gateway has already validated
  // JWT signatures before the service_role payload fallback is inspected.
  const serviceRequest = await callerIsServiceRole(req, serviceKey);
  const accountId = typeof body.account_id === "string" ? body.account_id : null;
  let manualKey = req.headers.get("Idempotency-Key") ??
    (typeof body.idempotency_key === "string" ? body.idempotency_key : null);
  let accounts: Array<{
    id: string;
    user_id: string;
    provider_app_id: string;
    auth_status: string;
    access_expires_at: string | null;
    refresh_expires_at: string | null;
    token_generation: number;
    backfill_cursor: number | null;
    backfill_complete: boolean;
    schema_status: string;
    verified_schema_fingerprints: string[] | null;
    verified_endpoint_fingerprints: Record<string, string[]> | null;
    sync_lease_token: string | null;
  }> = [];

  if (serviceRequest) {
    if (accountId) {
      const { data } = await admin.from("tiktok_accounts")
        .select("id,user_id,provider_app_id,auth_status,access_expires_at,refresh_expires_at,token_generation,backfill_cursor,backfill_complete,schema_status,verified_schema_fingerprints,verified_endpoint_fingerprints")
        .eq("id", accountId).maybeSingle();
      if (data) accounts = [{ ...data, sync_lease_token: null }];
    } else {
      const limit = Math.max(1, Math.min(Number(body.limit) || 5, 20));
      const { data: claimed, error } = await admin.rpc("claim_due_tiktok_accounts", { p_limit: limit });
      if (error) {
        console.error("TikTok due-account claim failed", { code: error.code });
        return json(500, { error: "sync_claim_failed" });
      }
      const ids = (claimed ?? []).map((row: { account_id: string }) => row.account_id);
      if (ids.length) {
        const { data } = await admin.from("tiktok_accounts")
          .select("id,user_id,provider_app_id,auth_status,access_expires_at,refresh_expires_at,token_generation,backfill_cursor,backfill_complete,schema_status,verified_schema_fingerprints,verified_endpoint_fingerprints,sync_lease_token")
          .in("id", ids);
        accounts = data ?? [];
      }
    }
  } else {
    const authorization = req.headers.get("Authorization") ?? "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authorization } } },
    );
    const { data: { user }, error } = await userClient.auth.getUser();
    if (error || !user) return json(401, { error: "Требуется вход в VibePost" });
    let accountQuery = admin.from("tiktok_accounts")
      .select("id,user_id,provider_app_id,auth_status,access_expires_at,refresh_expires_at,token_generation,backfill_cursor,backfill_complete,schema_status,verified_schema_fingerprints,verified_endpoint_fingerprints")
      .eq("user_id", user.id);
    accountQuery = accountId
      ? accountQuery.eq("id", accountId)
      : accountQuery.order("created_at", { ascending: false }).limit(1);
    const { data } = await accountQuery.maybeSingle();
    if (data) {
      // The currently published VibePost client sends an empty body and
      // predates the explicit Idempotency-Key header. Preserve duplicate
      // protection by deriving a stable key for repeated taps within a minute.
      manualKey ??= `manual:${user.id}:${data.id}:${Math.floor(Date.now() / 60_000)}`;
      accounts = [{ ...data, sync_lease_token: null }];
    }
  }

  if (!accounts.length) return json(accountId ? 404 : 200, { ok: true, results: [] });
  const readyAccounts: Array<(typeof accounts)[number] & { sync_lease_token: string }> = [];
  const results: Array<Record<string, unknown>> = [];
  for (const account of accounts) {
    if (account.auth_status !== "active") {
      results.push({ account_id: account.id, status: account.auth_status, retryable: false });
      continue;
    }
    let leaseToken = account.sync_lease_token;
    if (!leaseToken) {
      const { data, error } = await admin.rpc("claim_tiktok_account_sync", {
        p_account_id: account.id,
      });
      if (error) return json(500, { error: "sync_lease_failed" });
      leaseToken = typeof data === "string" ? data : null;
    }
    if (!leaseToken) {
      results.push({ account_id: account.id, status: "busy", deduplicated: true });
      continue;
    }
    readyAccounts.push({ ...account, sync_lease_token: leaseToken });
  }

  const fifteenMinuteBucket = Math.floor(Date.now() / (15 * 60_000));
  for (const account of readyAccounts) {
    const key = serviceRequest
      ? `scheduled:${fifteenMinuteBucket}`
      : manualKey!;
    results.push(await synchronizeAccount(
      admin,
      account,
      serviceRequest ? "scheduled" : "manual",
      key.slice(0, 200),
    ));
  }
  return json(200, { ok: true, results });
});
