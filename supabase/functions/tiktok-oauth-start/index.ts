// Start the official TikTok Login Kit OAuth flow.
// POST with the current Supabase user JWT. Returns a TikTok authorization URL.
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildAuthorizeUrl,
  randomState,
  REQUIRED_SCOPES,
  sha256Hex,
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const authorization = req.headers.get("Authorization") ?? "";
  const userClient = createClient(
    supabaseUrl,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authorization } } },
  );
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json(401, { error: "Требуется вход в VibePost" });

  const clientKey = Deno.env.get("TIKTOK_CLIENT_KEY");
  const redirectUri = Deno.env.get("TIKTOK_REDIRECT_URI");
  if (!clientKey || !redirectUri) {
    return json(503, {
      error: "TikTok OAuth ещё не настроен",
      missing: [
        ...(!clientKey ? ["TIKTOK_CLIENT_KEY"] : []),
        ...(!redirectUri ? ["TIKTOK_REDIRECT_URI"] : []),
      ],
    });
  }

  const state = randomState();
  const stateHash = await sha256Hex(state);
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const admin = createClient(
    supabaseUrl,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Best-effort cleanup. OAuth correctness does not depend on this delete.
  await admin.from("tiktok_oauth_states")
    .delete().lt("expires_at", new Date().toISOString());

  const { error } = await admin.from("tiktok_oauth_states").insert({
    user_id: user.id,
    state_hash: stateHash,
    redirect_uri: redirectUri,
    expires_at: expiresAt,
  });
  if (error) {
    console.error("TikTok OAuth state insert failed", { code: error.code });
    return json(500, { error: "oauth_state_create_failed" });
  }

  return json(200, {
    authorization_url: buildAuthorizeUrl({
      clientKey,
      redirectUri,
      state,
      scopes: REQUIRED_SCOPES,
      disableAutoAuth: true,
    }),
    expires_at: expiresAt,
    scopes: REQUIRED_SCOPES,
  });
});
