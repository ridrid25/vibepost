// Authenticated disconnect: revoke TikTok access, then delete the local
// account. The delete trigger removes the Vault token bundle.
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  refreshAccessToken,
  revokeAccess,
  TikTokApiError,
  TokenBundle,
} from "../_shared/tiktok.ts";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("VIBEPOST_APP_ORIGIN") ?? "https://chrono-vibepost.lovable.app",
  "Access-Control-Allow-Headers": "authorization, x-client-info, x-supabase-api-version, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const authorization = req.headers.get("Authorization") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(
    supabaseUrl,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authorization } } },
  );
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json(401, { error: "authentication_required" });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const accountId = typeof body.account_id === "string" ? body.account_id : null;
  const forceLocalCleanup = body.force_local_cleanup === true;

  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let accountQuery = admin.from("tiktok_accounts")
    .select("id,provider_app_id,auth_status")
    .eq("user_id", user.id);
  accountQuery = accountId
    ? accountQuery.eq("id", accountId)
    : accountQuery.order("created_at", { ascending: false }).limit(1);
  const { data: account } = await accountQuery.maybeSingle();
  if (!account) return json(404, { error: "account_not_found" });

  const deleteLocalAccount = async () => {
    const { error } = await admin.from("tiktok_accounts")
      .delete().eq("id", account.id).eq("user_id", user.id);
    return error;
  };
  if (["provider_revoked", "revoked"].includes(account.auth_status)) {
    const error = await deleteLocalAccount();
    if (error) return json(500, { error: "local_disconnect_failed" });
    return json(200, { ok: true, status: "revoked" });
  }

  const { data: leaseData, error: leaseError } = await admin.rpc("begin_tiktok_disconnect", {
    p_account_id: account.id,
    p_user_id: user.id,
  });
  const leaseToken = typeof leaseData === "string" ? leaseData : null;
  if (leaseError) return json(500, { error: "disconnect_lease_failed" });
  if (!leaseToken) return json(409, { error: "account_busy", retryable: true });
  const releaseLease = () => admin.rpc("release_tiktok_account_sync", {
    p_account_id: account.id,
    p_lease_token: leaseToken,
  });
  if (forceLocalCleanup) {
    const error = await deleteLocalAccount();
    if (error) {
      await admin.from("tiktok_accounts").update({
        auth_status: "revoked_pending",
        last_error: "Forced local cleanup failed",
      }).eq("id", account.id).eq("sync_lease_token", leaseToken);
      await releaseLease();
      return json(500, { error: "local_disconnect_failed" });
    }
    return json(200, { ok: true, status: "locally_removed", provider_revoke: "NOT_VERIFIED" });
  }

  // Re-read token metadata after acquiring the lease; the initial ownership
  // lookup may have raced a sync that completed immediately before our claim.
  const { data: currentAccount } = await admin.from("tiktok_accounts")
    .select("provider_app_id,access_expires_at,token_generation")
    .eq("id", account.id).eq("user_id", user.id).maybeSingle();
  if (!currentAccount) {
    await releaseLease();
    return json(404, { error: "account_not_found" });
  }

  const clientKey = Deno.env.get("TIKTOK_CLIENT_KEY");
  const clientSecret = Deno.env.get("TIKTOK_CLIENT_SECRET");
  if (!clientKey || !clientSecret || currentAccount.provider_app_id !== clientKey) {
    await admin.from("tiktok_accounts").update({
      auth_status: "revoked_pending",
      last_error: "TikTok OAuth configuration is unavailable",
    }).eq("id", account.id).eq("sync_lease_token", leaseToken);
    await releaseLease();
    return json(503, { error: "tiktok_oauth_not_configured" });
  }

  const { data: rawBundle } = await admin.rpc("get_tiktok_token_bundle", {
    p_account_id: account.id,
  });
  if (!rawBundle) {
    await admin.from("tiktok_accounts").update({
      auth_status: "revoked_pending",
      last_error: "TikTok token bundle is missing",
    }).eq("id", account.id).eq("sync_lease_token", leaseToken);
    await releaseLease();
    return json(409, { error: "token_bundle_missing", force_local_cleanup_available: true });
  }

  try {
    let bundle = JSON.parse(rawBundle) as TokenBundle;
    if (!currentAccount.access_expires_at ||
        new Date(currentAccount.access_expires_at).getTime() < Date.now() + 60_000) {
      const token = await refreshAccessToken({
        clientKey,
        clientSecret,
        refreshToken: bundle.refresh_token,
      });
      bundle = { access_token: token.access_token, refresh_token: token.refresh_token };
      const { error: storeError } = await admin.rpc("store_tiktok_token_bundle", {
        p_account_id: account.id,
        p_bundle: JSON.stringify(bundle),
        p_expected_generation: currentAccount.token_generation,
      });
      if (storeError) throw new Error("refreshed token could not be persisted");
      await admin.from("tiktok_accounts").update({
        access_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        refresh_expires_at: new Date(Date.now() + token.refresh_expires_in * 1000).toISOString(),
        scopes: String(token.scope ?? "").split(",").map((scope) => scope.trim()).filter(Boolean),
      }).eq("id", account.id).eq("token_generation", currentAccount.token_generation + 1);
    }
    await revokeAccess({ clientKey, clientSecret, accessToken: bundle.access_token });
  } catch (error) {
    const apiError = error instanceof TikTokApiError ? error : null;
    await admin.from("tiktok_accounts").update({
      auth_status: "revoked_pending",
      last_error: "TikTok revoke is pending",
      last_tiktok_log_id: apiError?.logId ?? null,
    }).eq("id", account.id).eq("user_id", user.id).eq("sync_lease_token", leaseToken);
    await releaseLease();
    return json(202, {
      ok: false,
      status: "revoked_pending",
      code: apiError?.code ?? "revoke_failed",
      log_id: apiError?.logId ?? null,
      force_local_cleanup_available: true,
    });
  }

  // Persist provider success before local cleanup. If deletion fails, the next
  // call skips a second revoke and only retries the local/Vault cleanup.
  const { error: stateError } = await admin.from("tiktok_accounts").update({
    auth_status: "provider_revoked",
    last_error: null,
    last_tiktok_log_id: null,
  }).eq("id", account.id).eq("user_id", user.id).eq("sync_lease_token", leaseToken);
  await releaseLease();
  if (stateError) return json(500, { error: "provider_revoke_state_failed" });

  const deleteError = await deleteLocalAccount();
  if (deleteError) return json(500, { error: "local_disconnect_failed" });
  return json(200, { ok: true, status: "revoked" });
});
