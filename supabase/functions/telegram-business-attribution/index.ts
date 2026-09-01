import { createClient } from "npm:@supabase/supabase-js@2";
import {
  mapBusinessEvidence,
  normalizePiiFreeOutcomePage,
  readBoundedStrictJson,
} from "../_shared/telegram-lead-attribution.mjs";

const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_RESPONSE_BYTES = 256 * 1024;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  const bearer = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!bearer) return json(401, { error: "UNAUTHORIZED" });
  const { data: authData, error: authError } = await admin.auth.getUser(bearer);
  if (authError || !authData.user) return json(401, { error: "UNAUTHORIZED" });
  try {
    const body = await readBoundedStrictJson(req, 4096, ["token_digests", "cursor"], ["token_digests"]);
    if (
        !Array.isArray(body.token_digests) || body.token_digests.length < 1 ||
        body.token_digests.length > 20 ||
        body.token_digests.some((item: unknown) => typeof item !== "string" || !DIGEST.test(item)) ||
        !(body.cursor === null || (typeof body.cursor === "string" && /^[A-Za-z0-9_-]{1,512}$/u.test(body.cursor)))) {
      return json(400, { error: "REQUEST_INVALID" });
    }
    const { data: tokens, error: tokenError } = await admin
      .from("telegram_attribution_tokens")
      .select("id,token_digest,creative_telegram_publications!inner(creative_id,telegram_post_id)")
      .eq("user_id", authData.user.id)
      .in("token_digest", body.token_digests);
    if (tokenError) return json(500, { error: "MAPPING_READ_FAILED" });
    const mappings = new Map((tokens ?? []).map((row: any) => [row.token_digest, {
      token_digest: row.token_digest,
      token_id: row.id,
      creative_id: row.creative_telegram_publications.creative_id,
      publication_id: row.creative_telegram_publications.telegram_post_id,
    }]));
    if (mappings.size !== new Set(body.token_digests).size) {
      return json(404, { error: "ATTRIBUTION_GAP" });
    }

    const endpoint = fixedMeetingEndpoint(Deno.env.get("MEETING_ATTRIBUTION_OUTCOME_URL") ?? "");
    const secret = Deno.env.get("VIBE_TO_MEETING_OUTCOME_READER_SECRET") ?? "";
    if (secret.length < 32) return json(503, { error: "OUTCOME_READER_DISABLED" });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json", "x-vibepost-attribution-secret": secret },
        body: JSON.stringify({ token_digests: [...mappings.keys()], cursor: body.cursor ?? null, limit: 100 }),
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return json(502, { error: "OUTCOME_READ_FAILED" });
    const raw = await response.text();
    if (new TextEncoder().encode(raw).length > MAX_RESPONSE_BYTES) {
      return json(502, { error: "OUTCOME_RESPONSE_TOO_LARGE" });
    }
    const page = normalizePiiFreeOutcomePage(JSON.parse(raw));
    const evidence = page.events.map((event: any) => mapBusinessEvidence(mappings.get(event.token_digest), event));
    return json(200, { evidence_root: "BUSINESS_PERFORMANCE",
      resolution: page.status === "NO_EVENTS" ? "UNKNOWN" : "RESOLVED", events: evidence,
      complete: page.complete, next_cursor: page.next_cursor });
  } catch {
    return json(400, { error: "REQUEST_INVALID" });
  }
});

function fixedMeetingEndpoint(value: string): string {
  const url = new URL(value);
  const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if ((!isLoopback && url.protocol !== "https:") || (isLoopback && !["http:", "https:"].includes(url.protocol)) ||
      url.pathname !== "/internal/attribution/outcomes/resolve" || url.search || url.hash) {
    throw new Error("outcome_endpoint_invalid");
  }
  return url.toString();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
