import { createClient } from "npm:@supabase/supabase-js@2";
import { readBoundedStrictJson } from "../_shared/telegram-lead-attribution.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );
    const bearer = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!bearer) return json(401, { error: "UNAUTHORIZED" });
    const { data: authData, error: authError } = await admin.auth.getUser(bearer);
    if (authError || !authData.user) return json(401, { error: "UNAUTHORIZED" });
    const body = await readBoundedStrictJson(req, 512, ["token_id"]);
    if (typeof body.token_id !== "string" || !UUID.test(body.token_id)) {
      return json(400, { error: "TOKEN_ID_INVALID" });
    }
    const { data, error } = await admin.rpc("revoke_telegram_attribution_token", {
      p_user_id: authData.user.id,
      p_token_id: body.token_id,
    });
    if (error || data !== true) return json(404, { error: "ACTIVE_TOKEN_UNKNOWN" });
    return json(200, { token_id: body.token_id, status: "REVOKED" });
  } catch {
    return json(400, { error: "REQUEST_INVALID" });
  }
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
