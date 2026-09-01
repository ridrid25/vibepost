// POST-07 owner-authenticated, bounded TikTok MARKET_REFERENCE boundary.
// This endpoint never crawls, scrapes, downloads media, creates experiments or
// lessons, changes prompts, publishes, or invokes the Generator.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { buildTikTokFeedbackContext } from "../_shared/tiktok-feedback-context.mjs";
import {
  MAX_INGEST_URLS,
  MarketReferenceError,
  buildTikTokFactPayload,
  buildTikTokMarketPreview,
  resolveTikTokOEmbed,
  validateHumanDna,
  validateTikTokReferenceUrl,
} from "../_shared/tiktok-market-reference.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["INGEST", "LABEL", "ADD_DNA", "PREVIEW"]);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function exactKeys(value: unknown, allowed: string[]): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).every((key) => allowed.includes(key));
}

async function configuredOwner(admin: SupabaseClient): Promise<string | null> {
  const { data, error } = await admin.rpc("get_secret", {
    p_name: "vibepost_content_brigade_owner",
  });
  return !error && typeof data === "string" && UUID.test(data) ? data : null;
}

async function authenticateOwner(req: Request, admin: SupabaseClient): Promise<string | null> {
  const authorization = req.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match) return null;
  const [{ data, error }, owner] = await Promise.all([
    admin.auth.getUser(match[1]),
    configuredOwner(admin),
  ]);
  return !error && data.user && owner === data.user.id ? owner : null;
}

async function collectPages(
  fetchPage: (from: number, to: number) => Promise<{ data: Record<string, any>[] | null; error: any }>,
) {
  const rows: Record<string, any>[] = [];
  for (let from = 0;; from += 500) {
    const { data, error } = await fetchPage(from, from + 499);
    if (error) throw new Error("feedback_read_failed");
    rows.push(...(data ?? []));
    if ((data ?? []).length < 500) return rows;
  }
}

async function inChunks(
  ids: string[],
  fetchChunk: (ids: string[], from: number, to: number) =>
    Promise<{ data: Record<string, any>[] | null; error: any }>,
) {
  const rows: Record<string, any>[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    rows.push(...await collectPages((from, to) => fetchChunk(chunk, from, to)));
  }
  return rows;
}

// A read-only copy of the accepted POST-04 input projection. The canonical
// classification and hashing remain in buildTikTokFeedbackContext.
async function loadTikTokFeedbackInputs(admin: SupabaseClient, userId: string) {
  const positiveLessons = await collectPages((from, to) => admin.from("content_lessons").select("*")
    .eq("user_id", userId).in("category", ["CONFIRMED_LESSON", "WINNING_PATTERN"])
    .in("status", ["SUPPORTED", "CONFIRMED"]).range(from, to));
  const avoidedLessons = await collectPages((from, to) => admin.from("content_lessons").select("*")
    .eq("user_id", userId).eq("category", "FAILED_PATTERN").eq("status", "REJECTED")
    .range(from, to));
  const lessons = [...positiveLessons, ...avoidedLessons];
  const experiments = await collectPages((from, to) => admin.from("experiments")
    .select("*").eq("user_id", userId).order("created_at").order("id").range(from, to));
  const experimentIds = experiments.map((row) => row.id);
  const analyses = await inChunks(experimentIds, (ids, from, to) => admin
    .from("content_analysis_results").select("*").eq("user_id", userId)
    .in("experiment_id", ids).order("created_at", { ascending: false }).range(from, to));
  const mutations = await collectPages((from, to) => admin.from("creative_mutations")
    .select("id,parent_creative_id,child_creative_id,changed_variable,mutation_kind")
    .eq("user_id", userId).order("created_at").order("id").range(from, to));
  const hypotheses = await collectPages((from, to) => admin.from("content_hypotheses").select("*")
    .eq("user_id", userId).eq("status", "REJECTED")
    .order("updated_at", { ascending: false }).range(from, to));
  const { data: framework, error: frameworkError } = await admin
    .from("prompt_framework_versions").select("*,prompt_framework_rules(*)")
    .eq("user_id", userId).eq("is_current", true).maybeSingle();
  if (frameworkError) throw new Error("feedback_read_failed");
  const ideaFields = "id,target_platform,status,route,decided_at,created_at,animal,hook,changed_variable,idea_pattern,feedback_batch_key";
  const [approvedResult, rejectedResult, recentIdeas] = await Promise.all([
    admin.from("video_ideas").select(ideaFields).eq("user_id", userId).eq("target_platform", "tiktok")
      .not("decided_at", "is", null).in("route", ["self", "paid"])
      .in("status", ["approved", "generating", "done"])
      .order("decided_at", { ascending: false }).order("id").limit(10),
    admin.from("video_ideas").select(ideaFields).eq("user_id", userId).eq("target_platform", "tiktok")
      .not("decided_at", "is", null).is("route", null).eq("status", "rejected")
      .order("decided_at", { ascending: false }).order("id").limit(10),
    collectPages((from, to) => admin.from("video_ideas").select(ideaFields)
      .eq("user_id", userId).eq("target_platform", "tiktok")
      .or("decided_at.not.is.null,feedback_batch_key.not.is.null")
      .order("created_at", { ascending: false }).range(from, to)),
  ]);
  if (approvedResult.error || rejectedResult.error) throw new Error("feedback_read_failed");
  const ideas = [...new Map([
    ...(approvedResult.data ?? []), ...(rejectedResult.data ?? []), ...recentIdeas,
  ].map((row) => [row.id, row])).values()];
  const evidenceVideoIds = [...new Set(lessons.flatMap((lesson) =>
    (Array.isArray(lesson.videos_used) ? lesson.videos_used : []))
    .filter((id: unknown) => typeof id === "string" && UUID.test(id)))] as string[];
  const snapshots = await inChunks(evidenceVideoIds, (ids, from, to) => admin
    .from("video_metric_snapshots").select("*").eq("user_id", userId).in("video_id", ids)
    .order("collected_at", { ascending: false }).range(from, to));
  const studio = await inChunks(evidenceVideoIds, (ids, from, to) => admin
    .from("studio_metrics").select("*").eq("user_id", userId).in("video_id", ids).range(from, to));
  return { lessons, experiments, analyses, mutations, hypotheses, framework: framework ?? null,
    ideas, snapshots, studio_metrics: studio };
}

function observation(resolved: Record<string, any>) {
  return {
    source_kind: "OWNER_SUBMITTED",
    external_reference_id: resolved.external_reference_id,
    canonical_url: resolved.canonical_url,
    creator_name: resolved.creator_name,
    creator_handle: resolved.creator_handle,
    observed_at: resolved.observed_at,
    payload: buildTikTokFactPayload(resolved),
  };
}

async function ingest(admin: SupabaseClient, userId: string, body: Record<string, any>) {
  if (!exactKeys(body, ["action", "urls"]) || !Array.isArray(body.urls) ||
      body.urls.length < 1 || body.urls.length > MAX_INGEST_URLS) {
    throw new MarketReferenceError("market_ingest_invalid");
  }
  const references = body.urls.map(validateTikTokReferenceUrl);
  const unique = [...new Map(references.map((row) => [row.external_reference_id, row])).values()];
  const ids = unique.map((row) => row.external_reference_id);
  const { data: existing, error: existingError } = await admin.from("market_references")
    .select("id,external_reference_id").eq("user_id", userId).eq("platform", "tiktok")
    .in("external_reference_id", ids);
  if (existingError) throw new Error("market_read_failed");
  const found = new Set((existing ?? []).map((row) => row.external_reference_id));
  const pending = unique.filter((row) => !found.has(row.external_reference_id));
  const observations = [];
  for (const reference of pending) {
    observations.push(observation(await resolveTikTokOEmbed(reference)));
  }
  if (observations.length) {
    const { error } = await admin.rpc("persist_tiktok_market_observations", {
      p_user_id: userId,
      p_observations: observations,
    });
    if (error) throw new Error("market_persist_failed");
  }
  const { data: rows, error: rowsError } = await admin.from("market_references")
    .select("id,external_reference_id,canonical_url,creator_name,creator_handle,owner_disposition,status,created_at")
    .eq("user_id", userId).eq("platform", "tiktok").in("external_reference_id", ids);
  if (rowsError || (rows ?? []).length !== unique.length) throw new Error("market_read_failed");
  const referenceIds = (rows ?? []).map((row) => row.id);
  const { data: facts, error: factsError } = await admin.from("market_reference_evidence")
    .select("id,market_reference_id,payload,observed_at")
    .eq("user_id", userId).eq("evidence_kind", "FACT_OBSERVATION")
    .in("market_reference_id", referenceIds);
  if (factsError || (facts ?? []).length !== referenceIds.length) throw new Error("market_read_failed");
  const factByReference = new Map((facts ?? []).map((row) => [row.market_reference_id, row]));
  return (rows ?? []).sort((a, b) => ids.indexOf(a.external_reference_id) - ids.indexOf(b.external_reference_id))
    .map((row) => ({ ...row, fact_evidence: factByReference.get(row.id) }));
}

async function label(admin: SupabaseClient, userId: string, body: Record<string, any>) {
  if (!exactKeys(body, ["action", "market_reference_id", "owner_disposition"]) ||
      !UUID.test(String(body.market_reference_id)) ||
      !["TAKE", "SKIP", "INTERESTING_MECHANIC", "NOT_MY_STYLE"].includes(body.owner_disposition)) {
    throw new MarketReferenceError("market_label_invalid");
  }
  const { data, error } = await admin.rpc("set_tiktok_market_disposition", {
    p_user_id: userId, p_market_reference_id: body.market_reference_id,
    p_disposition: body.owner_disposition,
  });
  if (error) throw new Error("market_label_failed");
  return data;
}

async function addDna(admin: SupabaseClient, userId: string, body: Record<string, any>) {
  if (!exactKeys(body, ["action", "market_reference_id", "dna"]) ||
      !UUID.test(String(body.market_reference_id))) throw new MarketReferenceError("market_dna_invalid");
  const { data: reference, error: referenceError } = await admin.from("market_references")
    .select("id,creator_name,creator_handle,owner_disposition").eq("user_id", userId)
    .eq("id", body.market_reference_id).maybeSingle();
  if (referenceError || !reference || !["TAKE", "INTERESTING_MECHANIC"].includes(reference.owner_disposition)) {
    throw new MarketReferenceError("market_dna_ineligible");
  }
  const { data: facts, error: factsError } = await admin.from("market_reference_evidence")
    .select("id,payload").eq("user_id", userId).eq("market_reference_id", reference.id)
    .eq("evidence_kind", "FACT_OBSERVATION");
  if (factsError || facts?.length !== 1) throw new Error("market_fact_invalid");
  const payload = validateHumanDna(body.dna, {
    marketReferenceId: reference.id,
    sourceFacts: {
      title: facts[0].payload?.facts?.title?.value,
      creator_name: reference.creator_name,
      creator_handle: reference.creator_handle,
    },
  });
  if (!payload.fact_evidence_ids.includes(facts[0].id)) {
    throw new MarketReferenceError("market_dna_fact_invalid");
  }
  const { data, error } = await admin.rpc("append_tiktok_market_dna", {
    p_user_id: userId, p_market_reference_id: reference.id, p_payload: payload,
  });
  if (error) throw new Error("market_dna_persist_failed");
  return data;
}

async function preview(admin: SupabaseClient, userId: string, body: Record<string, any>) {
  if (!exactKeys(body, ["action", "market_reference_id", "topic"]) ||
      !UUID.test(String(body.market_reference_id)) ||
      (body.topic !== undefined && (typeof body.topic !== "string" || !body.topic.trim() || body.topic.length > 100))) {
    throw new MarketReferenceError("market_preview_invalid");
  }
  const { data: reference, error: referenceError } = await admin.from("market_references")
    .select("id,owner_disposition").eq("user_id", userId).eq("id", body.market_reference_id)
    .maybeSingle();
  if (referenceError || !reference) throw new MarketReferenceError("market_preview_ineligible");
  const { data: evidence, error: evidenceError } = await admin.from("market_reference_evidence")
    .select("id,evidence_kind,evidence_version,payload").eq("user_id", userId)
    .eq("market_reference_id", reference.id)
    .order("evidence_version", { ascending: false }).order("created_at", { ascending: false });
  if (evidenceError) throw new Error("market_read_failed");
  const facts = (evidence ?? []).filter((row) => row.evidence_kind === "FACT_OBSERVATION");
  const dna = (evidence ?? []).find((row) => row.evidence_kind === "DNA_INFERENCE" &&
    row.payload?.reviewer_status === "ACCEPTED");
  if (facts.length !== 1 || !dna) throw new MarketReferenceError("market_preview_ineligible");
  const inputs = await loadTikTokFeedbackInputs(admin, userId);
  const base = await buildTikTokFeedbackContext({
    ...inputs,
    topic: typeof body.topic === "string" ? body.topic.trim() : null,
    evaluation_at: new Date().toISOString(),
  });
  return await buildTikTokMarketPreview(base, {
    reference, factEvidence: facts[0], dnaEvidence: dna,
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error_code: "market_method_not_allowed" });
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  if (!serviceKey || !url) return json(503, { error_code: "market_service_unavailable" });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const userId = await authenticateOwner(req, admin);
  if (!userId) return json(403, { error_code: "market_owner_required" });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.hasOwn(body, "user_id") || !ACTIONS.has(String((body as any).action))) {
    return json(400, { error_code: "market_request_invalid" });
  }
  try {
    const action = String((body as any).action);
    const result = action === "INGEST" ? await ingest(admin, userId, body as Record<string, any>)
      : action === "LABEL" ? await label(admin, userId, body as Record<string, any>)
      : action === "ADD_DNA" ? await addDna(admin, userId, body as Record<string, any>)
      : await preview(admin, userId, body as Record<string, any>);
    return json(200, { ok: true, action, result });
  } catch (error) {
    const code = error instanceof MarketReferenceError ? error.code : "market_operation_rejected";
    const status = code === "oembed_rate_limited" ? 429 : 400;
    return json(status, { error_code: code });
  }
});
