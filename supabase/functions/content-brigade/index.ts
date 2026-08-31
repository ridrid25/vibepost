// Narrow server-to-server API for Content Brigade v2.
// Uses a dedicated Vault secret; service_role never leaves Supabase.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  evaluateYoutubeExperiment,
  normalizeYoutubeMetricFacts,
  selectYoutubeCheckpointSnapshot,
} from "../_shared/youtube-own-learning.mjs";

const STUDIO_FIELDS = [
  "average_watch_time_seconds",
  "average_retention_percent",
  "full_watch_percent",
  "traffic_for_you_percent",
  "traffic_profile_percent",
  "traffic_search_percent",
  "traffic_following_percent",
  "saves",
  "retention_drop_second",
] as const;

const PERCENT_FIELDS = new Set([
  "average_retention_percent",
  "full_watch_percent",
  "traffic_for_you_percent",
  "traffic_profile_percent",
  "traffic_search_percent",
  "traffic_following_percent",
]);
const CONFIG_TTL_MS = 60_000;
const MAX_BODY_BYTES = 256 * 1024;
const MATERIAL_FIELDS = [
  "topic", "content_format", "hook_type", "character_id", "visual_style_id",
  "pacing_profile", "punch_type", "loop_type", "camera_profile",
  "prompt_framework_version",
] as const;
const RATE_METRICS = new Set(["like_rate", "comment_rate", "share_rate", "save_rate"]);
const CHECKPOINT_HOURS: Record<string, number> = {
  "1h": 1, "6h": 6, "24h": 24, "72h": 72, "7d": 168,
};
const CHECKPOINT_TOLERANCE_HOURS: Record<string, number> = {
  "1h": 0.5, "6h": 0.5, "24h": 1, "72h": 3, "7d": 12,
};
let cachedSecretDigest: Uint8Array | null = null;
let cachedSecretDigestAt = 0;
let secretDigestRefresh: Promise<Uint8Array | null> | null = null;
let cachedOwner: string | null = null;
let cachedOwnerAt = 0;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let different = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    different |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return different === 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function annotationPatch(value: unknown): Record<string, string | null> | null {
  if (value === undefined) return {};
  if (!isObject(value)) return null;
  const allowed = new Set<string>(MATERIAL_FIELDS);
  const patch: Record<string, string | null> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!allowed.has(key) ||
        (fieldValue !== null &&
          (typeof fieldValue !== "string" || !fieldValue.trim() || fieldValue.length > 100))) {
      return null;
    }
    patch[key] = typeof fieldValue === "string" ? fieldValue.trim() : null;
  }
  return patch;
}

function wilsonInterval(successes: number, trials: number) {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) ||
      successes < 0 || trials <= 0 || successes > trials) return null;
  const z = 1.959963984540054;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) / trials) +
    (z2 / (4 * trials * trials))) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function effectInterval(control: { successes: number; trials: number },
  variant: { successes: number; trials: number }) {
  const controlInterval = wilsonInterval(control.successes, control.trials);
  const variantInterval = wilsonInterval(variant.successes, variant.trials);
  if (!controlInterval || !variantInterval) return null;
  const controlRate = control.successes / control.trials;
  const variantRate = variant.successes / variant.trials;
  const difference = variantRate - controlRate;
  return {
    lower: Math.max(-1, difference - Math.sqrt(
      (variantRate - variantInterval.lower) ** 2 +
      (controlInterval.upper - controlRate) ** 2,
    )),
    upper: Math.min(1, difference + Math.sqrt(
      (variantInterval.upper - variantRate) ** 2 +
      (controlRate - controlInterval.lower) ** 2,
    )),
    controlRate,
    variantRate,
  };
}

async function configuredValue(admin: SupabaseClient, name: string): Promise<string | null> {
  const { data, error } = await admin.rpc("get_secret", { p_name: name });
  if (error || typeof data !== "string" || !data) return null;
  return data;
}

async function configuredSecretDigest(admin: SupabaseClient): Promise<Uint8Array | null> {
  if (cachedSecretDigest && Date.now() - cachedSecretDigestAt < CONFIG_TTL_MS) {
    return cachedSecretDigest;
  }
  if (secretDigestRefresh) return await secretDigestRefresh;
  secretDigestRefresh = (async () => {
    const value = await configuredValue(admin, "vibepost_content_brigade_secret");
    if (!value) return null;
    cachedSecretDigest = await sha256(value);
    cachedSecretDigestAt = Date.now();
    return cachedSecretDigest;
  })();
  try {
    return await secretDigestRefresh;
  } finally {
    secretDigestRefresh = null;
  }
}

async function configuredOwner(admin: SupabaseClient): Promise<string | null> {
  if (cachedOwner && Date.now() - cachedOwnerAt < CONFIG_TTL_MS) return cachedOwner;
  const owner = await configuredValue(admin, "vibepost_content_brigade_owner");
  if (owner) {
    cachedOwner = owner;
    cachedOwnerAt = Date.now();
  }
  return owner;
}

async function ownedVideo(admin: SupabaseClient, userId: string, videoId: string): Promise<boolean> {
  const { data, error } = await admin.from("videos")
    .select("id")
    .eq("id", videoId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function loadContext(admin: SupabaseClient, userId: string) {
  const { data: videos, error: videosError } = await admin.from("videos")
    .select("id,tiktok_video_id,published_at,duration_seconds,caption,title,description,topic,content_format,hook_type,experiment_id,hypothesis_id,character_id,visual_style_id,pacing_profile,punch_type,loop_type,camera_profile,prompt_framework_version")
    .eq("user_id", userId)
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(50);
  if (videosError) throw videosError;
  const videoIds = (videos ?? []).map((video) => video.id);

  const snapshotsPromise = videoIds.length
    ? admin.from("video_metric_snapshots")
      .select("id,video_id,collected_at,age_hours,views,likes,comments,shares,source")
      .eq("user_id", userId)
      .in("video_id", videoIds)
      .order("collected_at", { ascending: false })
      .limit(1000)
    : Promise.resolve({ data: [], error: null });
  const studioPromise = videoIds.length
    ? admin.from("studio_metrics")
      .select("id,video_id,average_watch_time_seconds,average_retention_percent,full_watch_percent,traffic_for_you_percent,traffic_profile_percent,traffic_search_percent,traffic_following_percent,saves,retention_drop_second,source,captured_at,updated_at")
      .eq("user_id", userId)
      .in("video_id", videoIds)
    : Promise.resolve({ data: [], error: null });

  const [snapshotsResult, studioResult, experimentsResult, hypothesesResult,
    lessonsResult, frameworksResult, analysesResult, promptsResult] = await Promise.all([
    snapshotsPromise,
    studioPromise,
    admin.from("experiments").select("*").eq("user_id", userId)
      .order("created_at", { ascending: false }).limit(50),
    admin.from("content_hypotheses").select("*").eq("user_id", userId)
      .order("created_at", { ascending: false }).limit(50),
    admin.from("content_lessons").select("*").eq("user_id", userId)
      .neq("status", "REJECTED").order("created_at", { ascending: false }).limit(100),
    admin.from("prompt_framework_versions").select("*,prompt_framework_rules(*)")
      .eq("user_id", userId).eq("is_current", true).maybeSingle(),
    admin.from("content_analysis_results").select("*").eq("user_id", userId)
      .order("created_at", { ascending: false }).limit(100),
    admin.from("video_prompt_records").select("*").eq("user_id", userId)
      .order("created_at", { ascending: false }).limit(50),
  ]);
  const results = [snapshotsResult, studioResult, experimentsResult, hypothesesResult,
    lessonsResult, frameworksResult, analysesResult, promptsResult];
  const firstError = results.find((result) => result.error)?.error;
  if (firstError) throw firstError;

  return {
    videos: videos ?? [],
    api_metric_snapshots: snapshotsResult.data ?? [],
    studio_metrics: studioResult.data ?? [],
    experiments: experimentsResult.data ?? [],
    hypotheses: hypothesesResult.data ?? [],
    lessons: lessonsResult.data ?? [],
    current_prompt_framework: frameworksResult.data ?? null,
    analysis_results: analysesResult.data ?? [],
    prompt_records: promptsResult.data ?? [],
    source_contract: {
      api_metric_snapshots: "api",
      studio_metrics: "manual_tiktok_studio",
      derived_metrics: "calculated",
    },
  };
}

async function upsertStudioMetrics(
  admin: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
) {
  const videoId = body.video_id;
  if (!isUuid(videoId) || !(await ownedVideo(admin, userId, videoId))) {
    return json(404, { error: "video_not_found" });
  }
  const row: Record<string, unknown> = {
    user_id: userId,
    video_id: videoId,
    source: "manual_tiktok_studio",
  };
  let supplied = 0;
  let suppliedNonNull = 0;
  for (const field of STUDIO_FIELDS) {
    if (!Object.hasOwn(body, field)) continue;
    supplied++;
    const value = body[field];
    if (value === null) {
      row[field] = null;
      continue;
    }
    suppliedNonNull++;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
        (PERCENT_FIELDS.has(field) && value > 100) ||
        (field === "saves" && !Number.isSafeInteger(value))) {
      return json(400, { error: "invalid_studio_metric", field });
    }
    row[field] = value;
  }
  if (!supplied) return json(400, { error: "no_studio_metrics_supplied" });
  if (!suppliedNonNull) return json(400, { error: "all_studio_metrics_are_null" });
  const capturedAt = typeof body.captured_at === "string"
    ? new Date(body.captured_at) : new Date();
  if (!Number.isFinite(capturedAt.getTime()) ||
      capturedAt.getTime() < Date.UTC(2020, 0, 1) ||
      capturedAt.getTime() > Date.now() + 5 * 60_000) {
    return json(400, { error: "invalid_captured_at" });
  }
  row.captured_at = capturedAt.toISOString();
  const { data, error } = await admin.from("studio_metrics")
    .upsert(row, { onConflict: "video_id" }).select().single();
  if (error) throw error;
  return json(200, { studio_metrics: data });
}

async function recordPrompt(
  admin: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
) {
  const videoId = body.video_id;
  if (!isUuid(videoId) || !(await ownedVideo(admin, userId, videoId))) {
    return json(404, { error: "video_not_found" });
  }
  const promptBytes = new TextEncoder().encode(JSON.stringify({
    prompt_structure: body.prompt_structure,
    prompt_patterns: body.prompt_patterns,
  })).byteLength;
  if (typeof body.prompt_version !== "string" || !body.prompt_version.trim() ||
      body.prompt_version.length > 64 || !isObject(body.prompt_structure) ||
      promptBytes > 64 * 1024 ||
      (body.prompt_patterns !== undefined &&
        (!Array.isArray(body.prompt_patterns) || body.prompt_patterns.length > 50)) ||
      (body.experiment_variable !== undefined &&
        (typeof body.experiment_variable !== "string" || body.experiment_variable.length > 100))) {
    return json(400, { error: "invalid_prompt_record" });
  }
  const { data, error } = await admin.from("video_prompt_records").upsert({
    user_id: userId,
    video_id: videoId,
    prompt_version: body.prompt_version.trim(),
    prompt_structure: body.prompt_structure,
    prompt_patterns: body.prompt_patterns ?? [],
    experiment_variable: typeof body.experiment_variable === "string"
      ? body.experiment_variable : null,
    technical_valid: typeof body.technical_valid === "boolean" ? body.technical_valid : null,
  }, { onConflict: "video_id" }).select().single();
  if (error) throw error;
  return json(200, { prompt_record: data });
}

async function recordExperiment(
  admin: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
) {
  const variantVideoId = body.variant_video_id;
  const controlVideoId = body.control_video_id;
  const variantParameters = annotationPatch(body.variant_parameters);
  const controlParameters = annotationPatch(body.control_parameters);
  const successMetrics = body.success_metrics;
  if (typeof body.hypothesis !== "string" || !body.hypothesis.trim() ||
      body.hypothesis.length > 2000 ||
      typeof body.changed_variable !== "string" || !body.changed_variable.trim() ||
      body.changed_variable.length > 100 ||
      !isUuid(variantVideoId) || !isUuid(controlVideoId) || variantVideoId === controlVideoId ||
      variantParameters === null || controlParameters === null ||
      (body.constants !== undefined && !isObject(body.constants)) ||
      !isObject(successMetrics) ||
      typeof successMetrics.primary_metric !== "string" ||
      !RATE_METRICS.has(successMetrics.primary_metric) ||
      typeof successMetrics.direction !== "string" ||
      !["increase", "decrease"].includes(successMetrics.direction) ||
      typeof successMetrics.checkpoint !== "string" ||
      !Object.hasOwn(CHECKPOINT_HOURS, successMetrics.checkpoint) ||
      !finiteNumber(successMetrics.mde) || successMetrics.mde <= 0 ||
      (body.status !== undefined &&
        (typeof body.status !== "string" ||
          !["OPEN", "AWAITING_DATA"].includes(body.status)))) {
    return json(400, { error: "invalid_experiment" });
  }
  if (!(await ownedVideo(admin, userId, variantVideoId)) ||
      !(await ownedVideo(admin, userId, controlVideoId))) {
    return json(404, { error: "video_not_found" });
  }
  const { data, error } = await admin.rpc("create_content_experiment", {
    p_user_id: userId,
    p_hypothesis: body.hypothesis.trim(),
    p_changed_variable: body.changed_variable.trim(),
    p_constants: body.constants ?? {},
    p_success_metrics: successMetrics,
    p_control_video_id: controlVideoId,
    p_variant_video_id: variantVideoId,
    p_hypothesis_id: isUuid(body.hypothesis_id) ? body.hypothesis_id : null,
    p_status: typeof body.status === "string" ? body.status : "OPEN",
    p_control_parameters: controlParameters,
    p_variant_parameters: variantParameters,
  });
  if (error) throw error;
  return json(201, { experiment: data });
}

async function annotateVideo(
  admin: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
) {
  const videoId = body.video_id;
  const patch = annotationPatch(body.parameters);
  if (!isUuid(videoId) || patch === null || !Object.keys(patch).length) {
    return json(400, { error: "invalid_video_annotation" });
  }
  if (!(await ownedVideo(admin, userId, videoId))) {
    return json(404, { error: "video_not_found" });
  }
  const { data, error } = await admin.from("videos").update(patch)
    .eq("id", videoId).eq("user_id", userId).select().single();
  if (error) throw error;
  return json(200, { video: data });
}

async function recordAnalysis(
  admin: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
) {
  const videoId = body.video_id;
  const experimentId = body.experiment_id;
  const checkpoint = body.checkpoint;
  if (!isUuid(videoId) || !isUuid(experimentId) || typeof checkpoint !== "string" ||
      !Object.hasOwn(CHECKPOINT_HOURS, checkpoint)) {
    return json(400, { error: "invalid_analysis_request" });
  }
  const { data: experiment, error: experimentError } = await admin.from("experiments")
    .select("*").eq("id", experimentId).eq("user_id", userId).maybeSingle();
  if (experimentError) throw experimentError;
  if (!experiment) return json(404, { error: "experiment_not_found" });
  const spec = isObject(experiment.success_metrics) ? experiment.success_metrics : {};
  if (spec.checkpoint !== checkpoint || typeof spec.primary_metric !== "string" ||
      !RATE_METRICS.has(spec.primary_metric) ||
      !["increase", "decrease"].includes(String(spec.direction)) ||
      !finiteNumber(spec.mde) || spec.mde <= 0) {
    return json(400, { error: "experiment_metric_contract_invalid" });
  }
  const { data: videoRows, error: videoError } = await admin.from("videos")
    .select("id,experiment_id,published_at,duration_seconds,topic,content_format,hook_type,character_id,visual_style_id,pacing_profile,punch_type,loop_type,camera_profile,prompt_framework_version")
    .eq("user_id", userId).in("id", [videoId, experiment.control_video_id]);
  if (videoError) throw videoError;
  const variant = (videoRows ?? []).find((row) => row.id === videoId);
  const control = (videoRows ?? []).find((row) => row.id === experiment.control_video_id);
  if (!variant || !control || variant.experiment_id !== experimentId) {
    return json(400, { error: "experiment_video_link_invalid" });
  }
  const targetAge = CHECKPOINT_HOURS[checkpoint];
  const tolerance = CHECKPOINT_TOLERANCE_HOURS[checkpoint];
  const { data: snapshots, error: snapshotsError } = await admin
    .from("video_metric_snapshots")
    .select("video_id,age_hours,views,likes,comments,shares,collected_at")
    .eq("user_id", userId).in("video_id", [videoId, experiment.control_video_id])
    .gte("age_hours", targetAge - tolerance)
    .lte("age_hours", targetAge + tolerance)
    .limit(100);
  if (snapshotsError) throw snapshotsError;
  const latest = new Map<string, Record<string, unknown>>();
  for (const snapshot of snapshots ?? []) {
    const current = latest.get(snapshot.video_id);
    if (!current || Math.abs(Number(snapshot.age_hours) - targetAge) <
        Math.abs(Number(current.age_hours) - targetAge)) {
      latest.set(snapshot.video_id, snapshot);
    }
  }
  const variantSnapshot = latest.get(videoId);
  const controlSnapshot = latest.get(experiment.control_video_id);
  const studioByVideo = new Map<string, Record<string, unknown>>();
  if (spec.primary_metric === "save_rate") {
    const { data: studios, error: studioError } = await admin.from("studio_metrics")
      .select("video_id,saves,captured_at").eq("user_id", userId)
      .in("video_id", [videoId, experiment.control_video_id]);
    if (studioError) throw studioError;
    for (const studio of studios ?? []) studioByVideo.set(studio.video_id, studio);
  }
  const sample = (id: string, snapshot: Record<string, unknown> | undefined) => {
    const trials = snapshot?.views;
    const video = id === videoId ? variant : control;
    const studio = studioByVideo.get(id);
    const studioAge = studio?.captured_at && video.published_at
      ? (new Date(String(studio.captured_at)).getTime() -
        new Date(String(video.published_at)).getTime()) / 3_600_000 : null;
    const comparableStudioSaves = finiteNumber(studioAge) &&
        Math.abs(studioAge - targetAge) <= tolerance
      ? studio?.saves : null;
    const successes = spec.primary_metric === "like_rate" ? snapshot?.likes
      : spec.primary_metric === "comment_rate" ? snapshot?.comments
      : spec.primary_metric === "share_rate" ? snapshot?.shares
      : comparableStudioSaves;
    return Number.isInteger(trials) && Number.isInteger(successes) &&
        Number(trials) > 0 && Number(successes) >= 0 && Number(successes) <= Number(trials)
      ? { successes: Number(successes), trials: Number(trials) } : null;
  };
  const variantSample = sample(videoId, variantSnapshot);
  const controlSample = sample(experiment.control_video_id, controlSnapshot);
  const durationBin = (value: unknown) => finiteNumber(value)
    ? `${Math.floor(value / 5) * 5}-${Math.floor(value / 5) * 5 + 4}` : null;
  const parameters = (video: Record<string, unknown>) => ({
    topic: video.topic ?? null,
    content_format: video.content_format ?? null,
    duration_bin: durationBin(video.duration_seconds),
    character_id: video.character_id ?? null,
    visual_style_id: video.visual_style_id ?? null,
    hook_type: video.hook_type ?? null,
    pacing_profile: video.pacing_profile ?? null,
    punch_type: video.punch_type ?? null,
    loop_type: video.loop_type ?? null,
    camera_profile: video.camera_profile ?? null,
    prompt_framework_version: video.prompt_framework_version ?? null,
  });
  const controlParameters = parameters(control);
  const variantParameters = parameters(variant);
  const materialChanges = Object.keys(controlParameters)
    .filter((key) => controlParameters[key as keyof typeof controlParameters] !==
      variantParameters[key as keyof typeof variantParameters]);
  const { data: promptRecord, error: promptError } = await admin.from("video_prompt_records")
    .select("technical_valid").eq("user_id", userId).eq("video_id", videoId).maybeSingle();
  if (promptError) throw promptError;
  const limitations: string[] = [];
  if (!variantSample || variantSample.trials < 400) limitations.push("variant views below 400 or metric missing");
  if (!controlSample || controlSample.trials < 400) limitations.push("control views below 400 or metric missing");
  if (!variantSnapshot || !controlSnapshot) limitations.push("comparable checkpoint snapshots missing");
  if (materialChanges.length !== 1 || materialChanges[0] !== experiment.changed_variable) {
    limitations.push("experiment must change exactly its one declared material variable");
  }
  if (promptRecord?.technical_valid !== true) limitations.push("video did not technically implement the prompt");

  let conclusion = "INCONCLUSIVE";
  let evidence: unknown[] = [];
  if (!limitations.length && variantSample && controlSample) {
    const interval = effectInterval(controlSample, variantSample);
    if (!interval) limitations.push("effect confidence interval could not be calculated");
    else {
      const beneficial = spec.direction === "decrease"
        ? { lower: -interval.upper, upper: -interval.lower }
        : { lower: interval.lower, upper: interval.upper };
      conclusion = beneficial.lower >= Number(spec.mde)
        ? "PASS" : beneficial.upper < Number(spec.mde) ? "FAIL" : "INCONCLUSIVE";
      if (conclusion === "INCONCLUSIVE") limitations.push("effect interval crosses MDE");
      evidence = [{
        experiment_id: experimentId,
        primary_metric: spec.primary_metric,
        checkpoint,
        effect_ci: { lower: interval.lower, upper: interval.upper },
        beneficial_effect_ci: beneficial,
        direction: spec.direction,
        mde: spec.mde,
        changed_variable: materialChanges[0],
        control_rate: interval.controlRate,
        variant_rate: interval.variantRate,
      }];
    }
  }
  const row = {
    user_id: userId,
    video_id: videoId,
    experiment_id: experimentId,
    checkpoint,
    conclusion,
    evidence,
    metrics: evidence[0] ?? {},
    metric_sources: { [String(spec.primary_metric)]: spec.primary_metric === "save_rate"
      ? "manual_tiktok_studio" : "api" },
    confidence: "LOW",
    sample_size: {
      audience_sample_size: variantSample?.trials ?? null,
      control_sample_size: controlSample?.trials ?? null,
      reference_video_count: control ? 1 : 0,
    },
    limitations,
    expected: spec,
    actual: { conclusion, evidence },
  };
  const { data, error } = await admin.from("content_analysis_results")
    .upsert(row, { onConflict: "video_id,checkpoint,experiment_id" }).select().single();
  if (error) throw error;
  const { error: updateError } = await admin.from("experiments").update({
    result: conclusion,
    confidence: "LOW",
    status: "ANALYZED",
  }).eq("id", experimentId).eq("user_id", userId);
  if (updateError) throw updateError;
  return json(201, { analysis_result: data });
}

function independentEvidenceIds(evidence: unknown[]): string[] {
  const ids = evidence.map((item) => isObject(item) && isUuid(item.experiment_id)
    ? item.experiment_id : null).filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

async function recordLesson(
  admin: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
) {
  const evidence = Array.isArray(body.evidence) ? body.evidence : [];
  const status = typeof body.status === "string" ? body.status : "HYPOTHESIS";
  const evidenceIds = independentEvidenceIds(evidence);
  const independentCount = evidenceIds.length;
  if (typeof body.lesson !== "string" || !body.lesson.trim() ||
      typeof body.category !== "string" ||
      !["CONFIRMED_LESSON", "WINNING_PATTERN", "FAILED_PATTERN", "HYPOTHESIS"].includes(body.category) ||
      !["HYPOTHESIS", "SUPPORTED", "CONFIRMED", "REJECTED"].includes(status) ||
      (status === "SUPPORTED" && independentCount < 2) ||
      (status === "CONFIRMED" && independentCount < 3) ||
      (status === "REJECTED" && independentCount < 2) ||
      (body.confidence !== undefined &&
        (typeof body.confidence !== "string" ||
          !["LOW", "MEDIUM", "HIGH"].includes(body.confidence))) ||
      (body.videos_used !== undefined &&
        (!Array.isArray(body.videos_used) || !body.videos_used.every(isUuid))) ||
      (body.applicable_topics !== undefined &&
        (!Array.isArray(body.applicable_topics) ||
          !body.applicable_topics.every((topic) => typeof topic === "string")))) {
    return json(400, { error: "invalid_or_insufficient_lesson_evidence" });
  }
  if (status !== "HYPOTHESIS") {
    const expectedConclusion = status === "REJECTED" ? "FAIL" : "PASS";
    const { data: analyses, error: analysesError } = await admin
      .from("content_analysis_results")
      .select("experiment_id,conclusion,created_at")
      .eq("user_id", userId)
      .in("experiment_id", evidenceIds)
      .order("created_at", { ascending: false });
    if (analysesError) throw analysesError;
    const latestConclusion = new Map<string, string>();
    for (const analysis of analyses ?? []) {
      if (analysis.experiment_id && !latestConclusion.has(analysis.experiment_id)) {
        latestConclusion.set(analysis.experiment_id, analysis.conclusion);
      }
    }
    const verifiedCount = evidenceIds.filter((id) =>
      latestConclusion.get(id) === expectedConclusion).length;
    const requiredCount = status === "CONFIRMED" ? 3 : 2;
    if (verifiedCount < requiredCount) {
      return json(400, { error: "lesson_evidence_not_verified" });
    }
  }
  const { data, error } = await admin.rpc("insert_content_lesson", {
    p_user_id: userId,
    p_lesson: body.lesson.trim(),
    p_category: body.category,
    p_evidence: evidence,
    p_videos_used: body.videos_used ?? [],
    p_sample_size: isObject(body.sample_size) ? body.sample_size : {},
    p_confidence: typeof body.confidence === "string" ? body.confidence : "LOW",
    p_status: status,
    p_applicable_topics: Array.isArray(body.applicable_topics) ? body.applicable_topics : [],
  });
  if (error) throw error;
  return json(201, { lesson: data });
}

async function runServerCycle(admin: SupabaseClient, userId: string) {
  const { data: experiments, error: experimentsError } = await admin.from("experiments")
    .select("id,hypothesis,success_metrics,status")
    .eq("user_id", userId).in("status", ["OPEN", "AWAITING_DATA", "ANALYZED"]);
  if (experimentsError) throw experimentsError;
  const experimentIds = (experiments ?? []).map((experiment) => experiment.id);
  if (!experimentIds.length) {
    return json(200, {
      evaluated: 0,
      analyses_written: 0,
      lessons_written: 0,
      next_hypothesis: "NO STRONG HYPOTHESIS",
    });
  }
  const { data: variants, error: variantsError } = await admin.from("videos")
    .select("id,experiment_id").eq("user_id", userId).in("experiment_id", experimentIds);
  if (variantsError) throw variantsError;
  const { data: lessons, error: lessonsError } = await admin.from("content_lessons")
    .select("evidence").eq("user_id", userId);
  if (lessonsError) throw lessonsError;
  const existingLessonKeys = new Set<string>();
  for (const lesson of lessons ?? []) {
    for (const item of Array.isArray(lesson.evidence) ? lesson.evidence : []) {
      if (isObject(item) && isUuid(item.experiment_id) && isUuid(item.video_id) &&
          typeof item.checkpoint === "string") {
        existingLessonKeys.add(`${item.experiment_id}|${item.video_id}|${item.checkpoint}`);
      }
    }
  }
  const experimentById = new Map((experiments ?? []).map((row) => [row.id, row]));
  let analysesWritten = 0;
  let lessonsWritten = 0;
  const results: unknown[] = [];
  for (const variant of variants ?? []) {
    const experiment = experimentById.get(variant.experiment_id);
    const spec = isObject(experiment?.success_metrics) ? experiment.success_metrics : {};
    if (typeof spec.checkpoint !== "string") continue;
    const analysisResponse = await recordAnalysis(admin, userId, {
      video_id: variant.id,
      experiment_id: variant.experiment_id,
      checkpoint: spec.checkpoint,
    });
    const analysisPayload = await analysisResponse.json();
    if (!analysisResponse.ok) {
      results.push({ experiment_id: variant.experiment_id, video_id: variant.id,
        error: analysisPayload.error ?? "analysis_failed" });
      continue;
    }
    analysesWritten++;
    const analysis = analysisPayload.analysis_result;
    results.push({ experiment_id: variant.experiment_id, video_id: variant.id,
      conclusion: analysis?.conclusion ?? "INCONCLUSIVE" });
    const key = `${variant.experiment_id}|${variant.id}|${spec.checkpoint}`;
    if (analysis?.conclusion && analysis.conclusion !== "INCONCLUSIVE" &&
        !existingLessonKeys.has(key)) {
      const lessonResponse = await recordLesson(admin, userId, {
        lesson: `Эксперимент ${variant.experiment_id}: ${analysis.conclusion}. ` +
          "Одиночное наблюдение; требуется независимое подтверждение.",
        category: "HYPOTHESIS",
        status: "HYPOTHESIS",
        confidence: "LOW",
        evidence: [{ experiment_id: variant.experiment_id, video_id: variant.id,
          checkpoint: spec.checkpoint, conclusion: analysis.conclusion,
          hypothesis: experiment?.hypothesis ?? null }],
        videos_used: [variant.id],
        sample_size: analysis.sample_size ?? {},
        applicable_topics: [],
      });
      if (lessonResponse.ok) {
        lessonsWritten++;
        existingLessonKeys.add(key);
      }
    }
  }
  return json(200, {
    evaluated: results.length,
    analyses_written: analysesWritten,
    lessons_written: lessonsWritten,
    next_hypothesis: results.some((item) =>
      isObject(item) && item.conclusion && item.conclusion !== "INCONCLUSIVE")
      ? "HYPOTHESIS_RECORDED_REQUIRES_CREATIVE_CYCLE"
      : "NO STRONG HYPOTHESIS",
    results,
  });
}

async function recordYoutubeExperiment(
  admin: SupabaseClient, userId: string, body: Record<string, unknown>,
) {
  for (const key of ["hypothesis_id", "control_short_id", "variant_short_id"]) {
    if (!isUuid(body[key])) return json(400, { error: `invalid_${key}` });
  }
  if (typeof body.changed_variable !== "string" || !isObject(body.constants) ||
      !isObject(body.success_metrics)) return json(400, { error: "invalid_youtube_experiment" });
  const { data, error } = await admin.rpc("create_youtube_content_experiment", {
    p_user_id: userId,
    p_hypothesis_id: body.hypothesis_id,
    p_control_short_id: body.control_short_id,
    p_variant_short_id: body.variant_short_id,
    p_changed_variable: body.changed_variable,
    p_constants: body.constants,
    p_success_metrics: body.success_metrics,
  });
  if (error) throw error;
  return json(200, { ok: true, experiment: data });
}

async function recordYoutubeAnalysis(
  admin: SupabaseClient, userId: string, body: Record<string, unknown>,
) {
  if (!isUuid(body.experiment_id) || typeof body.checkpoint !== "string") {
    return json(400, { error: "invalid_youtube_analysis" });
  }
  const { data: experiment, error: experimentError } = await admin.from("experiments")
    .select("*").eq("id", body.experiment_id).eq("user_id", userId)
    .eq("platform", "youtube_shorts").maybeSingle();
  if (experimentError) throw experimentError;
  if (!experiment) return json(404, { error: "youtube_experiment_not_found" });
  const shortIds = [experiment.control_youtube_short_id, experiment.variant_youtube_short_id];
  const { data: publications, error: publicationError } = await admin.from("published_shorts")
    .select("id,user_id,published_at,vph").eq("user_id", userId).in("id", shortIds);
  if (publicationError) throw publicationError;
  const { data: snapshots, error: snapshotError } = await admin.from("published_shorts_stats")
    .select("short_id,user_id,polled_at,views,likes,comments").eq("user_id", userId)
    .in("short_id", shortIds);
  if (snapshotError) throw snapshotError;
  const publicationById = new Map((publications ?? []).map((row) => [row.id, row]));
  const selected = shortIds.map((shortId) => {
    const publication = publicationById.get(shortId);
    const result = selectYoutubeCheckpointSnapshot({
      published_at: publication?.published_at,
      snapshots: (snapshots ?? []).filter((row) => row.short_id === shortId),
      checkpoint: body.checkpoint,
    });
    return { shortId, publication, ...result };
  });
  const missing = selected.filter((row) => !row.snapshot).map((row) => row.limitation);
  const control = selected[0].snapshot
    ? normalizeYoutubeMetricFacts(selected[0].snapshot, selected[0].publication) : {};
  const variant = selected[1].snapshot
    ? normalizeYoutubeMetricFacts(selected[1].snapshot, selected[1].publication) : {};
  const verdict = missing.length ? {
    conclusion: "INCONCLUSIVE", confidence: "LOW", limitations: missing,
  } : evaluateYoutubeExperiment({
    control, variant, success_metrics: experiment.success_metrics,
    control_material: experiment.control_material_vector,
    variant_material: experiment.variant_material_vector,
    changed_variable: experiment.changed_variable, constants: experiment.constants,
  });
  // A concrete variant snapshot is required by the reused analysis subject FK.
  // If it is absent the deterministic verdict is returned but no partial row is written.
  if (!selected[1].snapshot) return json(200, { ok: true, persisted: false, verdict });
  const { data, error } = await admin.rpc("persist_youtube_content_analysis", {
    p_user_id: userId, p_experiment_id: experiment.id,
    p_short_id: experiment.variant_youtube_short_id,
    p_snapshot_polled_at: selected[1].snapshot.polled_at,
    p_checkpoint: body.checkpoint, p_conclusion: verdict.conclusion,
    p_evidence: [{ control_short_id: experiment.control_youtube_short_id,
      variant_short_id: experiment.variant_youtube_short_id }],
    p_metrics: { control, variant },
    p_metric_sources: {
      platform: "youtube", store: "published_shorts_stats",
      control_snapshot: selected[0].snapshot
        ? { short_id: selected[0].snapshot.short_id, polled_at: selected[0].snapshot.polled_at } : "UNKNOWN",
      variant_snapshot: { short_id: selected[1].snapshot.short_id, polled_at: selected[1].snapshot.polled_at },
    },
    p_confidence: verdict.confidence,
    p_sample_size: verdict.sample_size ?? {}, p_limitations: verdict.limitations ?? [],
    p_expected: experiment.success_metrics, p_actual: verdict.actual ?? {},
  });
  if (error) throw error;
  return json(200, { ok: true, persisted: true, verdict, analysis: data });
}

async function recordYoutubeLesson(
  admin: SupabaseClient, userId: string, body: Record<string, unknown>,
) {
  if (typeof body.lesson !== "string" || !body.lesson.trim() || !Array.isArray(body.evidence)) {
    return json(400, { error: "invalid_youtube_lesson" });
  }
  const evidenceIds = independentEvidenceIds(body.evidence);
  if (!evidenceIds.length) return json(400, { error: "youtube_lesson_evidence_required" });
  const { data: analyses, error: analysesError } = await admin.from("content_analysis_results")
    .select("id,experiment_id,conclusion,created_at").eq("user_id", userId)
    .eq("platform", "youtube_shorts").in("experiment_id", evidenceIds)
    .order("created_at", { ascending: false }).order("id");
  if (analysesError) throw analysesError;
  const latest = new Map<string, string>();
  for (const row of analyses ?? []) if (!latest.has(row.experiment_id)) {
    latest.set(row.experiment_id, row.conclusion);
  }
  const conclusions = evidenceIds.map((id) => latest.get(id));
  if (conclusions.some((value) => !["PASS", "FAIL"].includes(value ?? "")) ||
      new Set(conclusions).size !== 1) {
    return json(400, { error: "youtube_lesson_evidence_inconsistent" });
  }
  const passed = conclusions[0] === "PASS";
  let category = "HYPOTHESIS";
  let status = "HYPOTHESIS";
  let confidence = "LOW";
  if (passed && evidenceIds.length >= 2) {
    category = ["CONFIRMED_LESSON", "WINNING_PATTERN"].includes(String(body.category))
      ? String(body.category) : "WINNING_PATTERN";
    status = evidenceIds.length >= 3 ? "CONFIRMED" : "SUPPORTED";
    confidence = evidenceIds.length >= 3 ? "HIGH" : "MEDIUM";
  } else if (!passed && evidenceIds.length >= 2) {
    category = "FAILED_PATTERN"; status = "REJECTED"; confidence = "MEDIUM";
  }
  const { data, error } = await admin.rpc("insert_youtube_content_lesson", {
    p_user_id: userId, p_lesson: body.lesson.trim(), p_category: category,
    p_evidence: body.evidence, p_confidence: confidence, p_status: status,
    p_topics: Array.isArray(body.applicable_topics) ? body.applicable_topics : [],
  });
  if (error) throw error;
  return json(200, { ok: true, lesson: data });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const presentedSecret = req.headers.get("x-content-brigade-secret");
  if (!presentedSecret) return json(403, { error: "forbidden" });
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json(413, { error: "request_too_large" });
  }
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const expectedDigest = await configuredSecretDigest(admin);
  if (!expectedDigest ||
      !constantTimeEqual(expectedDigest, await sha256(presentedSecret))) {
    return json(403, { error: "forbidden" });
  }
  const owner = await configuredOwner(admin);
  if (!owner || !isUuid(owner)) return json(500, { error: "owner_not_configured" });

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!isObject(parsed)) throw new Error("object required");
    if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > MAX_BODY_BYTES) {
      return json(413, { error: "request_too_large" });
    }
    body = parsed;
  } catch {
    return json(400, { error: "invalid_json" });
  }

  try {
    const action = typeof body.action === "string" ? body.action : "context";
    if (action === "context") return json(200, await loadContext(admin, owner));
    if (action === "upsert_studio_metrics") {
      return await upsertStudioMetrics(admin, owner, body);
    }
    if (action === "record_prompt") return await recordPrompt(admin, owner, body);
    if (action === "annotate_video") return await annotateVideo(admin, owner, body);
    if (action === "record_experiment") return await recordExperiment(admin, owner, body);
    if (action === "record_analysis") return await recordAnalysis(admin, owner, body);
    if (action === "record_lesson") return await recordLesson(admin, owner, body);
    if (action === "record_youtube_experiment") return await recordYoutubeExperiment(admin, owner, body);
    if (action === "record_youtube_analysis") return await recordYoutubeAnalysis(admin, owner, body);
    if (action === "record_youtube_lesson") return await recordYoutubeLesson(admin, owner, body);
    if (action === "run_cycle") return await runServerCycle(admin, owner);
    return json(400, { error: "unknown_action" });
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "unknown";
    console.error("content-brigade failed", code);
    return json(500, { error: "internal_error" });
  }
});
