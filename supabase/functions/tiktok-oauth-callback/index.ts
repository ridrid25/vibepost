// Official TikTok Login Kit callback.
// Deploy with verify_jwt=false: TikTok calls this URL directly. Security is
// provided by a short-lived, one-time, hashed OAuth state.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  exchangeAuthorizationCode,
  fieldInventory,
  getUserInfo,
  listVideos,
  missingRequiredScopes,
  parseScopes,
  queryVideos,
  sanitizeForFixture,
  schemaGateAllowsNormalization,
  sha256Hex,
  TikTokApiError,
  videoIdBatchesFromResponse,
  videosFromResponse,
} from "../_shared/tiktok.ts";

function html(status: number, title: string, message: string): Response {
  const escape = (value: string) => value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>` +
      `<main style="font:16px system-ui;max-width:680px;margin:48px auto;padding:0 20px">` +
      `<h1>${escape(title)}</h1><p>${escape(message)}</p></main>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
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
  const responseSha256 = await sha256Hex(JSON.stringify(redacted));
  const { error } = await admin.from("tiktok_api_fixtures").upsert({
    user_id: context.userId,
    account_id: context.accountId,
    sync_run_id: context.syncRunId,
    endpoint,
    redacted_response: redacted,
    response_sha256: responseSha256,
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
    if (!data) continue;
    written++;
  }
  return written;
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return html(405, "TikTok OAuth", "Ожидается GET callback.");

  const callback = new URL(req.url);
  const rawState = callback.searchParams.get("state");
  if (!rawState) return html(400, "Подключение не выполнено", "TikTok не вернул OAuth state.");

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const stateHash = await sha256Hex(rawState);
  const { data: consumed, error: stateError } = await admin
    .rpc("consume_tiktok_oauth_state", { p_state_hash: stateHash });
  const state = Array.isArray(consumed) ? consumed[0] : null;
  if (stateError || !state) {
    return html(400, "Подключение не выполнено", "OAuth state истёк, уже использован или не совпал.");
  }

  const oauthError = callback.searchParams.get("error");
  if (oauthError) {
    const description = callback.searchParams.get("error_description") ?? oauthError;
    return html(400, "TikTok не дал доступ", description);
  }
  const code = callback.searchParams.get("code");
  if (!code) return html(400, "Подключение не выполнено", "TikTok не вернул authorization code.");

  const clientKey = Deno.env.get("TIKTOK_CLIENT_KEY");
  const clientSecret = Deno.env.get("TIKTOK_CLIENT_SECRET");
  if (!clientKey || !clientSecret) {
    return html(503, "TikTok OAuth не настроен", "На сервере отсутствует client key или client secret.");
  }

  let leasedAccountId: string | null = null;
  let oauthLeaseToken: string | null = null;
  try {
    const token = await exchangeAuthorizationCode({
      clientKey,
      clientSecret,
      code,
      redirectUri: state.redirect_uri,
    });
    const scopes = parseScopes(token.scope);
    const missingScopes = missingRequiredScopes(scopes);

    const { data: existing } = await admin.from("tiktok_accounts")
      .select("id,user_id,auth_status,token_generation")
      .eq("provider_app_id", clientKey)
      .eq("open_id", token.open_id)
      .maybeSingle();
    if (existing && existing.user_id !== state.user_id) {
      return html(409, "Аккаунт уже подключён", "Этот TikTok уже связан с другим пользователем VibePost.");
    }
    if (existing && ["revoking", "revoked_pending", "provider_revoked"].includes(existing.auth_status)) {
      return html(
        409,
        "Отключение TikTok ещё выполняется",
        "Завершите отключение аккаунта и начните подключение заново.",
      );
    }
    if (existing) {
      const { data: claimed, error: claimError } = await admin.rpc("claim_tiktok_account_oauth", {
        p_account_id: existing.id,
        p_user_id: state.user_id,
        p_expected_generation: existing.token_generation,
      });
      if (claimError || typeof claimed !== "string") {
        return html(
          409,
          "TikTok занят синхронизацией",
          "Повторите подключение после завершения текущей операции.",
        );
      }
      leasedAccountId = existing.id;
      oauthLeaseToken = claimed;
    } else {
      oauthLeaseToken = crypto.randomUUID();
    }

    const desiredAuthStatus = missingScopes.length ? "reauth_required" : "active";
    const desiredAuthError = missingScopes.length
      ? `Не выданы scopes: ${missingScopes.join(", ")}`
      : null;
    const accountValues = {
      user_id: state.user_id,
      provider_app_id: clientKey,
      open_id: token.open_id,
      scopes,
      access_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      refresh_expires_at: new Date(Date.now() + token.refresh_expires_in * 1000).toISOString(),
      // Do not expose an active account until the corresponding token bundle
      // has been durably written to Vault.
      auth_status: "error",
      last_error: "oauth_token_pending",
      // The callback performs the first probe itself. Delay cron so it cannot
      // race that probe immediately after the account row is created.
      next_sync_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      ...(!existing
        ? { sync_claimed_at: new Date().toISOString(), sync_lease_token: oauthLeaseToken }
        : {}),
    };
    const accountQuery = existing
      ? admin.from("tiktok_accounts").update(accountValues)
        .eq("id", existing.id).eq("sync_lease_token", oauthLeaseToken)
      : admin.from("tiktok_accounts").insert(accountValues);
    const { data: account, error: accountError } = await accountQuery
      .select("id,user_id,schema_status,token_generation,verified_schema_fingerprints,verified_endpoint_fingerprints").single();
    if (accountError || !account) throw new Error(accountError?.message ?? "account save failed");
    leasedAccountId = account.id;

    const { error: secretError } = await admin.rpc("store_tiktok_token_bundle", {
      p_account_id: account.id,
      p_bundle: JSON.stringify({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
      }),
      p_expected_generation: account.token_generation,
    });
    if (secretError) throw new Error(`token vault save failed: ${secretError.message}`);
    const { error: activateError } = await admin.from("tiktok_accounts").update({
      auth_status: desiredAuthStatus,
      last_error: desiredAuthError,
    }).eq("id", account.id).eq("token_generation", account.token_generation + 1);
    if (activateError) throw new Error(`account activation failed: ${activateError.message}`);

    if (missingScopes.length) {
      return html(
        400,
        "Нужна повторная авторизация",
        `TikTok не выдал обязательные разрешения: ${missingScopes.join(", ")}.`,
      );
    }

    const { data: syncRun, error: runError } = await admin.from("tiktok_sync_runs")
      .insert({
        user_id: state.user_id,
        account_id: account.id,
        trigger_type: "oauth_probe",
        idempotency_key: `oauth:${state.state_id}`,
      }).select("id").single();
    if (runError || !syncRun) throw new Error(runError?.message ?? "sync run save failed");

    const context = { userId: state.user_id, accountId: account.id, syncRunId: syncRun.id };
    let items = 0;
    const schemaObservations: Array<{ endpoint: string; fingerprint: string }> = [];
    try {
      const profileResponse = await getUserInfo(token.access_token);
      await saveFixture(admin, context, "/v2/user/info/", profileResponse);
      const profileData = profileResponse.data as Record<string, unknown> | undefined;
      const profile = profileData?.user as Record<string, unknown> | undefined;
      if (typeof profile?.display_name === "string") {
        await admin.from("tiktok_accounts")
          .update({ display_name: profile.display_name }).eq("id", account.id);
      }

      const listResponse = await listVideos(token.access_token);
      const listFingerprint = await saveFixture(admin, context, "/v2/video/list/", listResponse);
      schemaObservations.push({ endpoint: "/v2/video/list/", fingerprint: listFingerprint });
      items += await saveRawVideos(admin, context, "/v2/video/list/", listResponse);

      // Query the complete listed set. TikTok accepts at most 20 IDs per
      // request; the live account currently has 18, so this is one batch.
      for (const videoIds of videoIdBatchesFromResponse(listResponse)) {
        const queryResponse = await queryVideos(token.access_token, videoIds);
        const queryFingerprint = await saveFixture(admin, context, "/v2/video/query/", queryResponse);
        schemaObservations.push({ endpoint: "/v2/video/query/", fingerprint: queryFingerprint });
        await saveRawVideos(admin, context, "/v2/video/query/", queryResponse);
      }

      await admin.from("tiktok_sync_runs").update({
        status: "completed",
        finished_at: new Date().toISOString(),
        items_seen: items,
        items_written: items,
      }).eq("id", syncRun.id);
      const schemaStillVerified = schemaGateAllowsNormalization(
        account.schema_status,
        account.verified_endpoint_fingerprints ?? {},
        schemaObservations,
      );
      const schemaApprovalUpdate = schemaStillVerified
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
        last_error: null,
      }).eq("id", account.id);
    } catch (probeError) {
      const apiError = probeError instanceof TikTokApiError ? probeError : null;
      const message = probeError instanceof Error ? probeError.message : String(probeError);
      await admin.from("tiktok_sync_runs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        http_status: apiError?.status ?? null,
        api_error_code: apiError?.code ?? "probe_failed",
        tiktok_log_id: apiError?.logId ?? null,
        error: message.slice(0, 500),
      }).eq("id", syncRun.id);
      await admin.from("tiktok_accounts").update({
        last_error: message.slice(0, 500),
        last_tiktok_log_id: apiError?.logId ?? null,
      }).eq("id", account.id);
      return html(
        202,
        "TikTok подключён, проверка данных не завершена",
        "Токены сохранены в Vault. Повторите Sync TikTok после проверки журналов.",
      );
    }

    return html(
      200,
      "TikTok подключён",
      "Реальные ответы API сохранены в очищенном виде. Схему ещё должен подтвердить review.",
    );
  } catch (error) {
    const apiError = error instanceof TikTokApiError ? error : null;
    console.error("TikTok OAuth callback failed", {
      code: apiError?.code ?? "oauth_callback_failed",
      log_id: apiError?.logId ?? null,
    });
    const suffix = apiError?.logId ? ` TikTok log_id: ${apiError.logId}.` : "";
    return html(
      apiError?.status && apiError.status < 500 ? 400 : 502,
      "Подключение TikTok не завершено",
      `Код ошибки: ${apiError?.code ?? "oauth_callback_failed"}.${suffix}`,
    );
  } finally {
    if (leasedAccountId && oauthLeaseToken) {
      const { error } = await admin.rpc("release_tiktok_account_sync", {
        p_account_id: leasedAccountId,
        p_lease_token: oauthLeaseToken,
      });
      if (error) console.error("TikTok OAuth lease release failed", { account_id: leasedAccountId });
    }
  }
});
