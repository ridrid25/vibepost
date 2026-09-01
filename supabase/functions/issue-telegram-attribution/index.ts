import { createClient } from "npm:@supabase/supabase-js@2";
import {
  TELEGRAM_ATTRIBUTION,
  buildMeetingDeepLink,
  digestCf1Token,
  generateCf1Token,
  readBoundedStrictJson,
} from "../_shared/telegram-lead-attribution.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );
    const authorization = req.headers.get("authorization") ?? "";
    const bearer = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(authorization)?.[1];
    if (!bearer) return json(401, { error: "UNAUTHORIZED" });
    const { data: authData, error: authError } = await admin.auth.getUser(bearer);
    if (authError || !authData.user) return json(401, { error: "UNAUTHORIZED" });

    const body = await readBoundedStrictJson(req, 1024, ["creative_identity_map_id", "telegram_post_id"]);
    if (!UUID.test(body.creative_identity_map_id) || !UUID.test(body.telegram_post_id)) {
      return json(400, { error: "IDENTITY_INVALID" });
    }
    const botUsername = Deno.env.get("MEETING_BOT_USERNAME") ?? "";
    const rawToken = generateCf1Token();
    const previewDeepLink = buildMeetingDeepLink(botUsername, rawToken);
    const initialDigest = await digestCf1Token(rawToken);
    const { data: publication, error: bindError } = await admin.rpc(
      "bind_telegram_creative_publication",
      {
        p_user_id: authData.user.id,
        p_creative_identity_map_id: body.creative_identity_map_id,
        p_telegram_post_id: body.telegram_post_id,
      },
    );
    if (bindError || !publication?.id) return json(409, { error: "PUBLICATION_BIND_FAILED" });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidateToken = attempt === 0 ? rawToken : generateCf1Token();
      const digest = attempt === 0 ? initialDigest : await digestCf1Token(candidateToken);
      const { data, error } = await admin.rpc("register_telegram_attribution_token", {
        p_user_id: authData.user.id,
        p_publication_mapping_id: publication.id,
        p_token_digest: digest,
        p_token_version: TELEGRAM_ATTRIBUTION.TOKEN_VERSION,
        p_destination: TELEGRAM_ATTRIBUTION.DESTINATION,
      });
      const record = Array.isArray(data) ? data[0] : data;
      if (!error && record?.was_created === true) {
        return json(201, {
          token_id: record.token_id,
          token_version: "cf1",
          destination: "meeting_assistant",
          preview_deep_link: attempt === 0
            ? previewDeepLink
            : buildMeetingDeepLink(botUsername, candidateToken),
          live_activation: false,
        });
      }
      if (!error && record?.was_created === false) {
        return json(409, { error: "RAW_TOKEN_UNAVAILABLE", token_id: record.token_id,
          token_digest: record.registered_digest, status: record.token_status });
      }
      if (!String(error?.message ?? "").includes("telegram_attribution_digest_collision")) {
        return json(409, { error: "TOKEN_REGISTRATION_FAILED" });
      }
    }
    return json(503, { error: "TOKEN_COLLISION_RETRY_EXHAUSTED" });
  } catch {
    return json(400, { error: "REQUEST_INVALID" });
  }
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
