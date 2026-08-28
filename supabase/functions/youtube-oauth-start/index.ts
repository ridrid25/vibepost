// Начало OAuth-потока YouTube-публикатора.
// Зовут двое: фронт с JWT пользователя и telegram-webhook с service_role
// (тогда user_id приходит в теле). Возвращает ссылку авторизации Google.
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildAuthorizeUrl, randomState, sha256Hex, YOUTUBE_SCOPES } from "../_shared/youtube-oauth.ts";

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
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authorization = req.headers.get("Authorization") ?? "";
  const bearer = authorization.replace(/^Bearer\s+/i, "");
  const body = await req.json().catch(() => ({}));

  // Подпись JWT уже проверил шлюз (verify_jwt=true), поэтому роли из payload
  // можно верить. Сравнение строк с env-ключом ломалось на ротации ключей.
  let role = "";
  try {
    const payload = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    role = typeof payload.role === "string" ? payload.role : "";
  } catch { /* не JWT — уйдёт по ветке пользователя */ }

  let userId: string | null = null;
  if (role === "service_role") {
    userId = typeof body.user_id === "string" ? body.user_id : null;
    if (!userId) return json(400, { error: "user_id обязателен при вызове с service_role" });
  } else {
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: { user }, error } = await userClient.auth.getUser();
    if (error || !user) return json(401, { error: "Требуется вход в VibePost" });
    userId = user.id;
  }

  const clientId = Deno.env.get("YOUTUBE_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("YOUTUBE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return json(503, {
      error: "YouTube OAuth ещё не настроен",
      missing: [
        ...(!clientId ? ["YOUTUBE_OAUTH_CLIENT_ID"] : []),
        ...(!clientSecret ? ["YOUTUBE_OAUTH_CLIENT_SECRET"] : []),
      ],
    });
  }
  const redirectUri = `${supabaseUrl}/functions/v1/youtube-oauth-callback`;

  const state = randomState();
  const stateHash = await sha256Hex(state);
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const admin = createClient(supabaseUrl, serviceKey);

  await admin.from("youtube_oauth_states")
    .delete().lt("expires_at", new Date().toISOString());

  const { error } = await admin.from("youtube_oauth_states").insert({
    user_id: userId,
    state_hash: stateHash,
    redirect_uri: redirectUri,
    expires_at: expiresAt,
  });
  if (error) {
    console.error("YouTube OAuth state insert failed", { code: error.code });
    return json(500, { error: "oauth_state_create_failed" });
  }

  return json(200, {
    authorization_url: buildAuthorizeUrl({ clientId, redirectUri, state }),
    expires_at: expiresAt,
    scopes: YOUTUBE_SCOPES,
  });
});
