export const FEEDBACK_CONTEXT_VERSION = 1;
export const MATERIAL_FIELDS = Object.freeze([
  "topic",
  "content_format",
  "hook_type",
  "character_id",
  "visual_style_id",
  "pacing_profile",
  "punch_type",
  "loop_type",
  "camera_profile",
  "prompt_framework_version",
]);

const STATUS_PRIORITY = Object.freeze({ CONFIRMED: 2, SUPPORTED: 1 });
const CONFIDENCE_PRIORITY = Object.freeze({ HIGH: 3, MEDIUM: 2, LOW: 1 });
const FRAMEWORK_PRIORITY = Object.freeze({ STANDARD: 2, SUPPORTED: 1 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function feedbackBatchKey(userId, requestId) {
  return await sha256Hex(canonicalJson({
    domain: "vibepost:tiktok-feedback-batch:v1",
    request_id: requestId,
    user_id: userId,
  }));
}

export function normalizeIdeaText(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function ideaPattern(animal, hook) {
  return `${normalizeIdeaText(animal)}|${normalizeIdeaText(hook)}`;
}

function sortedDistinctIds(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && UUID.test(value)))].sort();
}

function evidenceExperimentIds(lesson) {
  return sortedDistinctIds((Array.isArray(lesson?.evidence) ? lesson.evidence : [])
    .map((item) => object(item) ? item.experiment_id : null));
}

function latestAnalyses(rows) {
  const ordered = [...rows].sort((left, right) =>
    timestamp(right.created_at) - timestamp(left.created_at) || String(left.id).localeCompare(String(right.id)));
  const result = new Map();
  for (const row of ordered) {
    if (UUID.test(String(row.experiment_id ?? "")) && !result.has(row.experiment_id)) {
      result.set(row.experiment_id, row);
    }
  }
  return result;
}

function topicEligible(lesson, requestedTopic) {
  const topics = Array.isArray(lesson.applicable_topics)
    ? lesson.applicable_topics.map(normalizeIdeaText).filter(Boolean)
    : [];
  if (!requestedTopic) return topics.length === 0;
  const wanted = normalizeIdeaText(requestedTopic);
  return topics.length === 0 || topics.includes(wanted);
}

function lessonOrdering(left, right, avoidance = false) {
  if (!avoidance) {
    const byStatus = (STATUS_PRIORITY[right.status] ?? 0) - (STATUS_PRIORITY[left.status] ?? 0);
    if (byStatus) return byStatus;
  }
  const byConfidence = (CONFIDENCE_PRIORITY[right.confidence] ?? 0) -
    (CONFIDENCE_PRIORITY[left.confidence] ?? 0);
  if (byConfidence) return byConfidence;
  const byUpdated = timestamp(right.updated_at ?? right.created_at) -
    timestamp(left.updated_at ?? left.created_at);
  return byUpdated || String(left.id).localeCompare(String(right.id));
}

function classifyLessons(lessons, latestByExperiment, requestedTopic) {
  const positive = [];
  const avoidance = [];
  for (const lesson of lessons) {
    if (!topicEligible(lesson, requestedTopic)) continue;
    const experimentIds = evidenceExperimentIds(lesson);
    const conclusions = experimentIds.map((id) => latestByExperiment.get(id)?.conclusion ?? "UNKNOWN");
    const passCount = conclusions.filter((value) => value === "PASS").length;
    const failCount = conclusions.filter((value) => value === "FAIL").length;
    const positiveCategory = ["CONFIRMED_LESSON", "WINNING_PATTERN"].includes(lesson.category);
    const positiveStatus = ["CONFIRMED", "SUPPORTED"].includes(lesson.status);
    const requiredPasses = lesson.status === "CONFIRMED" ? 3 : 2;
    if (positiveCategory && positiveStatus && passCount >= requiredPasses && failCount === 0) {
      positive.push({ ...lesson, experiment_ids: experimentIds });
      continue;
    }
    if (lesson.category === "FAILED_PATTERN" && lesson.status === "REJECTED" &&
        failCount >= 2 && passCount === 0) {
      avoidance.push({ ...lesson, experiment_ids: experimentIds });
    }
  }
  return {
    positive: positive.sort((a, b) => lessonOrdering(a, b)).slice(0, 5),
    avoidance: avoidance.sort((a, b) => lessonOrdering(a, b, true)).slice(0, 5),
  };
}

function validSuccessMetrics(value) {
  return object(value) && typeof value.primary_metric === "string" &&
    ["increase", "decrease"].includes(value.direction) &&
    typeof value.checkpoint === "string" && Number.isFinite(value.mde) && value.mde > 0;
}

function experimentSignature(experiment) {
  return canonicalJson({
    changed_variable: experiment?.changed_variable ?? null,
    constants: object(experiment?.constants) ? experiment.constants : {},
  });
}

function eligibleFramework(value) {
  if (!object(value) || value.is_current !== true ||
      !["STANDARD", "SUPPORTED"].includes(value.status)) return null;
  const rules = (Array.isArray(value.prompt_framework_rules) ? value.prompt_framework_rules : [])
    .filter((rule) => ["STANDARD", "SUPPORTED"].includes(rule.status))
    .sort((left, right) =>
      (FRAMEWORK_PRIORITY[right.status] ?? 0) - (FRAMEWORK_PRIORITY[left.status] ?? 0) ||
      (CONFIDENCE_PRIORITY[right.confidence] ?? 0) - (CONFIDENCE_PRIORITY[left.confidence] ?? 0) ||
      timestamp(right.updated_at ?? right.created_at) - timestamp(left.updated_at ?? left.created_at) ||
      String(left.id).localeCompare(String(right.id)))
    .slice(0, 20);
  return { ...value, prompt_framework_rules: rules };
}

function selectedOwnerPreferences(rows) {
  const eligible = rows.filter((row) => row.target_platform === "tiktok" && row.decided_at);
  const ordering = (left, right) => timestamp(right.decided_at) - timestamp(left.decided_at) ||
    String(left.id).localeCompare(String(right.id));
  const approved = eligible.filter((row) => ["self", "paid"].includes(row.route) &&
      ["approved", "generating", "done"].includes(row.status)).sort(ordering).slice(0, 10);
  const rejected = eligible.filter((row) => row.route == null && row.status === "rejected")
    .sort(ordering).slice(0, 10);
  const shape = (row) => ({
    idea_id: row.id,
    animal: row.animal ?? null,
    hook: row.hook ?? null,
    route: row.route ?? null,
    decided_at: row.decided_at,
  });
  return {
    source_type: "OWNER_PREFERENCE",
    approved: approved.map(shape),
    rejected: rejected.map(shape),
  };
}

function newestBy(rows, key, dateFields) {
  const map = new Map();
  for (const row of rows) {
    const id = row[key];
    if (!id) continue;
    const current = map.get(id);
    const valueTime = Math.max(...dateFields.map((field) => timestamp(row[field])));
    const currentTime = current
      ? Math.max(...dateFields.map((field) => timestamp(current[field])))
      : -1;
    if (!current || valueTime > currentTime ||
        (valueTime === currentTime && String(row.id).localeCompare(String(current.id)) < 0)) {
      map.set(id, row);
    }
  }
  return map;
}

function metricFacts(videoIds, snapshots, studioRows) {
  const api = newestBy(snapshots, "video_id", ["collected_at"]);
  const studio = newestBy(studioRows, "video_id", ["updated_at", "captured_at"]);
  return videoIds.slice(0, 20).map((videoId) => {
    const apiRow = api.get(videoId);
    const studioRow = studio.get(videoId);
    return {
      video_id: videoId,
      api_snapshot_id: apiRow?.id ?? null,
      api_source: apiRow?.source ?? "UNKNOWN",
      views: apiRow?.views ?? "UNKNOWN",
      likes: apiRow?.likes ?? "UNKNOWN",
      comments: apiRow?.comments ?? "UNKNOWN",
      shares: apiRow?.shares ?? "UNKNOWN",
      studio_metric_id: studioRow?.id ?? null,
      studio_source: studioRow?.source ?? "UNKNOWN",
      saves: studioRow?.saves ?? "UNKNOWN",
      retention: studioRow?.average_retention_percent ?? "UNKNOWN",
    };
  });
}

export async function buildTikTokFeedbackContext(input) {
  const lessons = Array.isArray(input.lessons) ? input.lessons : [];
  const experiments = Array.isArray(input.experiments) ? input.experiments : [];
  const analyses = Array.isArray(input.analyses) ? input.analyses : [];
  const hypotheses = Array.isArray(input.hypotheses) ? input.hypotheses : [];
  const latest = latestAnalyses(analyses);
  const classified = classifyLessons(lessons, latest, input.topic);
  const experimentsById = new Map(experiments.map((row) => [row.id, row]));
  const rejectedSignatures = new Set();
  for (const lesson of classified.avoidance) {
    for (const id of lesson.experiment_ids) {
      const experiment = experimentsById.get(id);
      if (experiment && latest.get(id)?.conclusion === "FAIL") {
        rejectedSignatures.add(experimentSignature(experiment));
      }
    }
  }
  for (const hypothesis of hypotheses) {
    if (hypothesis.status === "REJECTED" && MATERIAL_FIELDS.includes(hypothesis.changed_variable) &&
        object(hypothesis.constants)) rejectedSignatures.add(experimentSignature(hypothesis));
  }

  let primary = null;
  for (const lesson of classified.positive) {
    const candidates = lesson.experiment_ids.map((id) => ({
      experiment: experimentsById.get(id), analysis: latest.get(id), lesson,
    })).filter(({ experiment, analysis }) => experiment && analysis?.conclusion === "PASS" &&
      ["ANALYZED", "CLOSED"].includes(experiment.status) &&
      MATERIAL_FIELDS.includes(experiment.changed_variable) && object(experiment.constants) &&
      validSuccessMetrics(experiment.success_metrics) && !rejectedSignatures.has(experimentSignature(experiment)))
      .sort((left, right) => timestamp(right.analysis.created_at) - timestamp(left.analysis.created_at) ||
        String(left.experiment.id).localeCompare(String(right.experiment.id)));
    if (candidates.length) {
      primary = candidates[0];
      break;
    }
  }

  const framework = eligibleFramework(input.framework);
  const ownerPreference = selectedOwnerPreferences(Array.isArray(input.ideas) ? input.ideas : []);
  const evidenceVideoIds = sortedDistinctIds([
    ...classified.positive.flatMap((lesson) => Array.isArray(lesson.videos_used) ? lesson.videos_used : []),
    ...classified.avoidance.flatMap((lesson) => Array.isArray(lesson.videos_used) ? lesson.videos_used : []),
  ]).slice(0, 20);
  const metrics = metricFacts(evidenceVideoIds,
    Array.isArray(input.snapshots) ? input.snapshots : [],
    Array.isArray(input.studio_metrics) ? input.studio_metrics : []);
  const recentResults = [...experiments].filter((row) => ["PASS", "FAIL"].includes(row.result))
    .sort((left, right) => timestamp(right.updated_at ?? right.created_at) -
      timestamp(left.updated_at ?? left.created_at) || String(left.id).localeCompare(String(right.id)))
    .slice(0, 10).map((row) => ({
      experiment_id: row.id,
      result: row.result,
      changed_variable: row.changed_variable,
    }));
  const recentCreativeSignatures = (Array.isArray(input.ideas) ? input.ideas : [])
    .filter((row) => row.target_platform === "tiktok" &&
      (row.decided_at || row.feedback_batch_key) && row.animal && row.hook)
    .sort((left, right) => timestamp(right.decided_at ?? right.created_at) -
      timestamp(left.decided_at ?? left.created_at) || String(left.id).localeCompare(String(right.id)))
    .slice(0, 20).map((row) => ({
      idea_id: row.id,
      changed_variable: row.changed_variable ?? "UNKNOWN",
      idea_pattern: row.idea_pattern ?? ideaPattern(row.animal, row.hook),
    }));
  const limitations = [];
  if (!classified.positive.length) limitations.push("NO_ELIGIBLE_POSITIVE_LESSON");
  if (!primary) limitations.push("NO_ELIGIBLE_PRIMARY_EXPERIMENT");
  if (!framework) limitations.push("NO_ELIGIBLE_CURRENT_PROMPT_FRAMEWORK");
  if (metrics.some((row) => row.views === "UNKNOWN")) limitations.push("CURRENT_API_METRICS_PARTIAL");
  if (metrics.some((row) => row.retention === "UNKNOWN")) limitations.push("STUDIO_METRICS_PARTIAL");

  const stableOwnPerformance = {
    source_type: "OWN_PERFORMANCE",
    selected_lessons: classified.positive.map((lesson) => ({
      lesson_id: lesson.id, lesson: lesson.lesson, category: lesson.category,
      status: lesson.status, confidence: lesson.confidence,
      conclusive_evidence: lesson.experiment_ids.map((id) => ({
        experiment_id: id,
        experiment_status: experimentsById.get(id)?.status ?? "UNKNOWN",
        latest_analysis_id: latest.get(id)?.id ?? null,
        latest_conclusion: latest.get(id)?.conclusion ?? "UNKNOWN",
      })).filter((item) => item.latest_conclusion === "PASS"),
    })),
    avoided_lessons: classified.avoidance.map((lesson) => ({
      lesson_id: lesson.id, lesson: lesson.lesson, category: lesson.category,
      status: lesson.status, confidence: lesson.confidence,
      conclusive_evidence: lesson.experiment_ids.map((id) => ({
        experiment_id: id,
        experiment_status: experimentsById.get(id)?.status ?? "UNKNOWN",
        latest_analysis_id: latest.get(id)?.id ?? null,
        latest_conclusion: latest.get(id)?.conclusion ?? "UNKNOWN",
      })).filter((item) => item.latest_conclusion === "FAIL"),
    })),
    primary: primary ? {
      lesson_id: primary.lesson.id,
      experiment_id: primary.experiment.id,
      analysis_id: primary.analysis.id,
      changed_variable: primary.experiment.changed_variable,
      constants: primary.experiment.constants,
      success_metrics: primary.experiment.success_metrics,
    } : null,
    prompt_framework: framework ? {
      id: framework.id,
      version_label: framework.version_label,
      status: framework.status,
      rule_ids: framework.prompt_framework_rules.map((rule) => rule.id),
    } : null,
  };
  const hypothesisKey = primary && framework
    ? await sha256Hex(canonicalJson({
      context_version: FEEDBACK_CONTEXT_VERSION,
      platform: "tiktok",
      own_performance: stableOwnPerformance,
    }))
    : null;
  const contextHash = await sha256Hex(canonicalJson({
    context_version: FEEDBACK_CONTEXT_VERSION,
    hypothesis_key: hypothesisKey,
    metrics,
    owner_preference_ids: [
      ...ownerPreference.approved.map((row) => row.idea_id),
      ...ownerPreference.rejected.map((row) => row.idea_id),
    ],
    recent_creative_signatures: recentCreativeSignatures,
  }));
  const metricProvenance = {
    api_snapshot_ids: sortedDistinctIds(metrics.map((row) => row.api_snapshot_id)),
    studio_metric_ids: sortedDistinctIds(metrics.map((row) => row.studio_metric_id)),
  };
  const expectedEffect = primary
    ? `${primary.experiment.success_metrics.direction} ` +
      `${primary.experiment.success_metrics.primary_metric} by at least ` +
      `${primary.experiment.success_metrics.mde} at ${primary.experiment.success_metrics.checkpoint}`
    : null;
  return {
    context_version: FEEDBACK_CONTEXT_VERSION,
    platform: "tiktok",
    outcome: primary && framework ? "HYPOTHESIS" : "NO_STRONG_HYPOTHESIS",
    hypothesis_key: hypothesisKey,
    context_hash: contextHash,
    OWN_PERFORMANCE: {
      ...stableOwnPerformance,
      current_metrics: metrics,
      recent_results: recentResults,
      metric_provenance: metricProvenance,
    },
    OWNER_PREFERENCE: ownerPreference,
    recent_creative_signatures: recentCreativeSignatures,
    limitations: [...new Set(limitations)],
    hypothesis_candidate: primary && framework ? {
      statement: `Проверить следующий TikTok-креатив по lesson ${primary.lesson.id}, ` +
        `изменяя только ${primary.experiment.changed_variable}.`,
      changed_variable: primary.experiment.changed_variable,
      constants: primary.experiment.constants,
      expected_effect: expectedEffect,
      rationale: `OWN_PERFORMANCE lesson=${primary.lesson.id}; experiment=${primary.experiment.id}; ` +
        `analysis=${primary.analysis.id}`,
      evidence: [{
        source_type: "OWN_PERFORMANCE",
        lesson_ids: classified.positive.map((lesson) => lesson.id),
        avoided_lesson_ids: classified.avoidance.map((lesson) => lesson.id),
        experiment_id: primary.experiment.id,
        analysis_id: primary.analysis.id,
      }],
    } : null,
  };
}

export function formatTikTokFeedbackPromptContext(context) {
  const own = context.outcome === "HYPOTHESIS"
    ? context.OWN_PERFORMANCE
    : { source_type: "OWN_PERFORMANCE", outcome: "NO_STRONG_HYPOTHESIS",
      limitations: context.limitations };
  return [
    "POST-04 STRUCTURED TIKTOK CONTEXT. Keep evidence types separate.",
    `OWN_PERFORMANCE=${canonicalJson(own)}`,
    `OWNER_PREFERENCE=${canonicalJson(context.OWNER_PREFERENCE)}`,
    context.hypothesis_candidate
      ? `NEXT_HYPOTHESIS=${canonicalJson(context.hypothesis_candidate)}`
      : "NEXT_HYPOTHESIS=NO_STRONG_HYPOTHESIS",
    "Use rejected patterns only as avoidance. Owner rejection is not performance FAIL.",
    "Every idea must explain why_this_idea. Do not start production; owner chooses.",
  ].join("\n");
}

export function validateTikTokCandidates(candidates, context) {
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 5) {
    throw new Error("invalid_candidate_count");
  }
  const changedVariable = context.hypothesis_candidate?.changed_variable ?? null;
  const recent = new Set((context.recent_creative_signatures ?? []).map((row) =>
    `${row.changed_variable}|${row.idea_pattern}`));
  const legacyPatterns = new Set((context.recent_creative_signatures ?? [])
    .filter((row) => row.changed_variable === "UNKNOWN")
    .map((row) => row.idea_pattern));
  const batch = new Set();
  return candidates.map((candidate) => {
    if (!object(candidate)) throw new Error("invalid_candidate");
    const required = ["slug", "animal", "hook", "line", "prompt", "why_this_idea"];
    for (const field of required) {
      if (typeof candidate[field] !== "string" || !candidate[field].trim()) {
        throw new Error(`invalid_candidate_${field}`);
      }
    }
    const pattern = ideaPattern(candidate.animal, candidate.hook);
    const signature = `${changedVariable ?? "BASELINE"}|${pattern}`;
    if (batch.has(signature) || legacyPatterns.has(pattern) ||
        (changedVariable && recent.has(signature))) {
      throw new Error("duplicate_candidate_pattern");
    }
    batch.add(signature);
    return {
      slug: candidate.slug.trim(),
      animal: candidate.animal.trim(),
      hook: candidate.hook.trim(),
      line: candidate.line.trim(),
      prompt: candidate.prompt.trim(),
      why_this_idea: candidate.why_this_idea.trim(),
      idea_pattern: pattern,
    };
  });
}
