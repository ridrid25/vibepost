// META-FIRST read-only connection gate. Every outbound provider call is GET.
import { metaReadRequests, executeMetaRead, normalizeMetaGraphResult } from "../_shared/meta-readonly.mjs";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function serviceRole(request: Request): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const expected = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return expected.length > 20 && auth === `Bearer ${expected}`;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json(405, { error_code: "METHOD_NOT_ALLOWED" });
  if (!serviceRole(request)) return json(403, { error_code: "SERVICE_ROLE_REQUIRED" });
  if (Deno.env.get("META_LIVE_READ_ENABLED") !== "YES") {
    return json(503, { error_code: "META_LIVE_READ_NOT_ACTIVATED", fixture_ready: true });
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["date_start", "date_stop", "mode", "normalization_context"].sort()) ||
      body.mode !== "READ_ONLY_VALIDATE") {
      return json(400, { error_code: "REQUEST_INVALID" });
    }
    const accountId = Deno.env.get("META_AD_ACCOUNT_ID") ?? "";
    const apiVersion = Deno.env.get("META_GRAPH_API_VERSION") ?? "";
    const accessToken = Deno.env.get("META_ACCESS_TOKEN") ?? "";
    const descriptors = metaReadRequests({ accountId, apiVersion, dateStart: body.date_start, dateStop: body.date_stop });
    const result = await executeMetaRead({ descriptors, accessToken });
    const normalized = await normalizeMetaGraphResult({
      graph: result, context: body.normalization_context, apiVersion,
      dateStart: body.date_start, dateStop: body.date_stop,
    });
    const counts = {
      profiles: normalized.profiles.length, objects: normalized.objects.length,
      bindings: normalized.bindings.length, snapshots: normalized.snapshots.length,
      actions: normalized.actions.length,
    };
    return json(200, {
      status: "READ_ONLY_NORMALIZED",
      method: "GET",
      provider_write_operations: 0,
      counts,
      batch_hash: normalized.batch_hash,
    });
  } catch (error) {
    const errorCode = typeof error === "object" && error && "code" in error ? String(error.code) : "META_READ_FAILED";
    return json(502, { error_code: errorCode });
  }
});
