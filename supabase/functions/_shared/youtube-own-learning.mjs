import { canonicalJson, sha256Hex } from "./tiktok-feedback-context.mjs";
import {
  LESSON_EFFECTIVE_POLICY_VERSION,
  evaluateLessonsForFeedback,
} from "./lesson-effective-weight.mjs";

export const YOUTUBE_OWN_CONTEXT_VERSION = 2;
export const YOUTUBE_CHECKPOINTS = Object.freeze({
  "1h": { hours: 1, tolerance: 0.5 },
  "6h": { hours: 6, tolerance: 0.5 },
  "24h": { hours: 24, tolerance: 1 },
  "72h": { hours: 72, tolerance: 3 },
  "7d": { hours: 168, tolerance: 12 },
});
export const YOUTUBE_RATE_METRICS = Object.freeze(["like_rate", "comment_rate"]);
export const YOUTUBE_MATERIAL_FIELDS = Object.freeze([
  "causal_pattern_class",
  "payoff_class",
  "prompt_framework_version",
  "fidelity_constraints_hash",
]);
export const YOUTUBE_UNSUPPORTED_METRICS = Object.freeze([
  "shares", "saves", "retention", "completion", "watch_time",
]);

const CONFIDENCE = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function optionalYoutubeCount(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function normalizeYoutubeMetricFacts(snapshot, publication = {}) {
  const views = optionalYoutubeCount(snapshot?.views);
  const likes = optionalYoutubeCount(snapshot?.likes);
  const comments = optionalYoutubeCount(snapshot?.comments);
  const validLikes = likes === null || views === null || likes <= views ? likes : null;
  const validComments = comments === null || views === null || comments <= views ? comments : null;
  const engagement = views && validLikes !== null && validComments !== null
    ? (validLikes + validComments) / views
    : "UNKNOWN";
  return {
    source_type: "OWN_PERFORMANCE",
    metric_source: "youtube",
    snapshot_key: snapshot?.short_id && snapshot?.polled_at
      ? { short_id: snapshot.short_id, polled_at: snapshot.polled_at }
      : null,
    views: views ?? "UNKNOWN",
    likes: validLikes ?? "UNKNOWN",
    comments: validComments ?? "UNKNOWN",
    vph: finite(publication?.vph) ? publication.vph : "UNKNOWN",
    engagement,
    duration: finite(publication?.duration) ? publication.duration : "UNKNOWN",
    published_at: publication?.published_at ?? "UNKNOWN",
    polled_at: snapshot?.polled_at ?? "UNKNOWN",
    unsupported: Object.fromEntries(YOUTUBE_UNSUPPORTED_METRICS.map((key) => [key, "UNSUPPORTED"])),
  };
}

export function selectYoutubeCheckpointSnapshot({ published_at, snapshots = [], checkpoint }) {
  const policy = YOUTUBE_CHECKPOINTS[checkpoint];
  const published = Date.parse(published_at ?? "");
  if (!policy || !Number.isFinite(published)) {
    return { snapshot: null, limitation: !policy ? "unsupported_checkpoint" : "missing_publish_time" };
  }
  const candidates = snapshots.flatMap((snapshot) => {
    const polled = Date.parse(snapshot?.polled_at ?? "");
    if (!Number.isFinite(polled)) return [];
    const age = (polled - published) / 3_600_000;
    const delta = Math.abs(age - policy.hours);
    return delta <= policy.tolerance ? [{ snapshot, delta, polled }] : [];
  }).sort((left, right) => left.delta - right.delta || left.polled - right.polled ||
    String(left.snapshot.short_id).localeCompare(String(right.snapshot.short_id)));
  return candidates.length
    ? { snapshot: candidates[0].snapshot, limitation: null }
    : { snapshot: null, limitation: "no_snapshot_within_checkpoint_tolerance" };
}

export function youtubeMinimumViews(mde) {
  return finite(mde) && mde > 0 && mde <= 1
    ? Math.ceil((1.96 ** 2) / (2 * (mde ** 2)))
    : null;
}

function wilsonInterval(successes, trials) {
  const z = 1.96;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) / trials) + (z * z) / (4 * trials * trials)) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function effectInterval(control, variant) {
  const c = wilsonInterval(control.successes, control.trials);
  const v = wilsonInterval(variant.successes, variant.trials);
  return { lower: v.lower - c.upper, upper: v.upper - c.lower };
}

function validSuccessMetrics(spec) {
  return spec && YOUTUBE_RATE_METRICS.includes(spec.primary_metric) &&
    ["increase", "decrease"].includes(spec.direction) &&
    Object.hasOwn(YOUTUBE_CHECKPOINTS, spec.checkpoint) && finite(spec.mde) &&
    spec.mde > 0 && spec.mde <= 1;
}

function rateInput(facts, metric) {
  const views = optionalYoutubeCount(facts?.views);
  const key = metric === "like_rate" ? "likes" : "comments";
  const successes = optionalYoutubeCount(facts?.[key]);
  return views !== null && views > 0 && successes !== null && successes <= views
    ? { successes, trials: views }
    : null;
}

export async function deriveYoutubeMaterialVector(idea) {
  const pattern = idea?.causal_pattern?.pattern_class ?? idea?.causal_pattern_class ?? null;
  const constraints = Array.isArray(idea?.fidelity_constraints)
    ? idea.fidelity_constraints
    : Array.isArray(idea?.critical_fidelity_constraints) ? idea.critical_fidelity_constraints : null;
  if (!pattern || !idea?.payoff_class || !idea?.prompt_framework_version || !constraints) return null;
  return {
    causal_pattern_class: String(pattern),
    payoff_class: String(idea.payoff_class),
    prompt_framework_version: String(idea.prompt_framework_version),
    fidelity_constraints_hash: await sha256Hex(canonicalJson(constraints)),
  };
}

export function validateYoutubeMaterialChange(control, variant, changedVariable, constants) {
  if (!control || !variant || !YOUTUBE_MATERIAL_FIELDS.includes(changedVariable) ||
      !constants || typeof constants !== "object" || Array.isArray(constants)) {
    return { valid: false, reason: "material_provenance_incomplete" };
  }
  if (YOUTUBE_MATERIAL_FIELDS.some((key) => typeof control[key] !== "string" || typeof variant[key] !== "string")) {
    return { valid: false, reason: "material_vector_incomplete" };
  }
  const differences = YOUTUBE_MATERIAL_FIELDS.filter((key) => control[key] !== variant[key]);
  const expectedConstants = Object.fromEntries(YOUTUBE_MATERIAL_FIELDS
    .filter((key) => key !== changedVariable).map((key) => [key, control[key]]));
  if (differences.length !== 1 || differences[0] !== changedVariable) {
    return { valid: false, reason: "one_changed_variable_required", differences };
  }
  if (canonicalJson(constants) !== canonicalJson(expectedConstants)) {
    return { valid: false, reason: "constants_mismatch", differences };
  }
  return { valid: true, reason: null, differences, expected_constants: expectedConstants };
}

export function evaluateYoutubeExperiment({
  control, variant, success_metrics, control_material, variant_material,
  changed_variable, constants,
}) {
  const limitations = [];
  if (!validSuccessMetrics(success_metrics)) limitations.push("invalid_success_metrics");
  const material = validateYoutubeMaterialChange(
    control_material, variant_material, changed_variable, constants,
  );
  if (!material.valid) limitations.push(material.reason);
  if (limitations.length) return { conclusion: "INCONCLUSIVE", confidence: "LOW", limitations };

  const controlRate = rateInput(control, success_metrics.primary_metric);
  const variantRate = rateInput(variant, success_metrics.primary_metric);
  if (!controlRate || !variantRate) {
    return { conclusion: "INCONCLUSIVE", confidence: "LOW", limitations: ["missing_or_invalid_metric"] };
  }
  const minimum = youtubeMinimumViews(success_metrics.mde);
  if (controlRate.trials < minimum || variantRate.trials < minimum) {
    return {
      conclusion: "INCONCLUSIVE", confidence: "LOW",
      limitations: ["insufficient_youtube_sample"],
      sample_size: { control: controlRate.trials, variant: variantRate.trials, minimum_per_arm: minimum },
    };
  }
  const interval = effectInterval(controlRate, variantRate);
  const mde = success_metrics.mde;
  let conclusion = "INCONCLUSIVE";
  if (success_metrics.direction === "increase") {
    if (interval.lower >= mde) conclusion = "PASS";
    else if (interval.upper < mde) conclusion = "FAIL";
  } else {
    if (interval.upper <= -mde) conclusion = "PASS";
    else if (interval.lower > -mde) conclusion = "FAIL";
  }
  return {
    conclusion,
    confidence: conclusion === "INCONCLUSIVE" ? "LOW" : "MEDIUM",
    limitations: conclusion === "INCONCLUSIVE" ? ["effect_interval_crosses_mde"] : [],
    sample_size: { control: controlRate.trials, variant: variantRate.trials, minimum_per_arm: minimum },
    actual: {
      control_rate: controlRate.successes / controlRate.trials,
      variant_rate: variantRate.successes / variantRate.trials,
      effect_interval: interval,
    },
  };
}

function lessonOrder(a, b) {
  const status = { CONFIRMED: 3, SUPPORTED: 2, REJECTED: 1 };
  return (status[b.status] ?? 0) - (status[a.status] ?? 0) ||
    (CONFIDENCE[b.confidence] ?? 0) - (CONFIDENCE[a.confidence] ?? 0) ||
    String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) ||
    String(a.id).localeCompare(String(b.id));
}

function eligibleFramework(framework) {
  if (!framework?.is_current || !["STANDARD", "SUPPORTED"].includes(framework.status)) return null;
  const rules = (framework.prompt_framework_rules ?? []).filter((row) =>
    ["STANDARD", "SUPPORTED"].includes(row.status)).sort(lessonOrder).slice(0, 20);
  return { id: framework.id, version_label: framework.version_label, rule_ids: rules.map((row) => row.id) };
}

function ownerPreferences(rows) {
  const ordered = [...(rows ?? [])].filter((row) => row.target_platform === "youtube_shorts" && row.decided_at)
    .sort((a, b) => String(b.decided_at).localeCompare(String(a.decided_at)) || String(a.id).localeCompare(String(b.id)));
  const shape = (row) => ({ idea_id: row.id, route: row.route ?? null, decided_at: row.decided_at });
  return {
    source_type: "OWNER_PREFERENCE",
    approved: ordered.filter((row) => ["self", "paid"].includes(row.route) &&
      ["approved", "generating", "done"].includes(row.status)).slice(0, 10).map(shape),
    rejected: ordered.filter((row) => row.route == null && row.status === "rejected").slice(0, 10).map(shape),
  };
}

function patternKey(value) {
  return typeof value === "string" && value.trim() ? `PATTERN:${value.trim()}` : null;
}

export function lowerConflictConfidence(value) {
  return value === "HIGH" ? "MEDIUM" : "LOW";
}

export async function buildYoutubeFeedbackContext(input) {
  const allExperiments = input.experiments ?? [];
  const experiments = allExperiments.filter((row) => row.platform === "youtube_shorts");
  const byExperiment = new Map(experiments.map((row) => [row.id, row]));
  const allAnalyses = input.analyses ?? [];
  const analysesById = new Map(allAnalyses.map((row) => [row.id, row]));
  const bindings = input.lesson_bindings ?? [];
  const publications = new Map((input.publications ?? []).map((row) => [row.id, row]));
  const mappings = new Map((input.mappings ?? []).map((row) => [row.youtube_short_row_id, row]));
  const snapshots = new Map((input.snapshots ?? []).map((row) =>
    [`${row.short_id}|${row.polled_at}`, row]));
  const framework = eligibleFramework(input.framework);
  const lessons = (input.lessons ?? []).filter((row) => row.source_platform === "youtube_shorts");
  const lessonById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const effective = evaluateLessonsForFeedback({
    lessons,
    experiments: allExperiments,
    analyses: allAnalyses,
    mutations: input.mutations ?? [],
    lesson_bindings: bindings,
    target_platform: "youtube_shorts",
    current_context: {
      ...(input.current_context ?? {}),
      ...(framework?.version_label ? { prompt_framework_version: framework.version_label } : {}),
    },
    evaluation_at: input.evaluation_at,
  });
  const shapeLesson = (state) => ({ ...lessonById.get(state.lesson_id),
    experiment_ids: state.supporting_experiment_ids, effective_evidence: state });
  const selected = effective.positive.slice(0, 5).map(shapeLesson);
  const rejected = effective.avoidance.slice(0, 5).map(shapeLesson);
  const rejectedSignatures = new Set((input.hypotheses ?? []).filter((row) =>
    row.status === "REJECTED" && row.feedback_context?.platform === "youtube_shorts")
    .map((row) => canonicalJson({ changed_variable: row.changed_variable, constants: row.constants ?? {} })));
  const primary = selected.flatMap((lesson) => lesson.effective_evidence.supporting_evidence
    .map((evidence) => ({ lesson, experiment: byExperiment.get(evidence.experiment_id), evidence })))
    .find(({ experiment, evidence }) => experiment && evidence.conclusion === "PASS" &&
      validateYoutubeMaterialChange(experiment.control_material_vector, experiment.variant_material_vector,
        experiment.changed_variable, experiment.constants).valid &&
      !rejectedSignatures.has(canonicalJson({
        changed_variable: experiment.changed_variable, constants: experiment.constants,
      }))) ?? null;

  const failedKeys = new Map();
  for (const lesson of rejected) for (const id of lesson.experiment_ids) {
    const experiment = byExperiment.get(id);
    const key = patternKey(experiment?.variant_material_vector?.causal_pattern_class);
    if (key) {
      const entry = failedKeys.get(key) ?? { lesson_ids: [], experiment_ids: [] };
      if (!entry.lesson_ids.includes(lesson.id)) entry.lesson_ids.push(lesson.id);
      if (!entry.experiment_ids.includes(id)) entry.experiment_ids.push(id);
      entry.lesson_ids.sort();
      entry.experiment_ids.sort();
      failedKeys.set(key, entry);
    }
  }
  const market = (input.market_references ?? []).map((reference) => {
    const key = patternKey(reference?.causal_pattern?.pattern_class);
    const conflict = key ? failedKeys.get(key) ?? null : null;
    return {
      source_type: "MARKET_REFERENCE",
      reference_id: reference.reference_source_id ?? reference.reference_id,
      pattern_key: key ?? "UNKNOWN",
      causal_pattern: reference.causal_pattern ?? null,
      payoff_class: reference.payoff_class ?? null,
      fidelity_constraints: reference.critical_fidelity_constraints ?? [],
      conflict,
    };
  });
  const evidenceShape = (lesson) => ({
    lesson_id: lesson.id,
    lesson: lesson.lesson,
    category: lesson.category,
    status: lesson.status,
    confidence: lesson.confidence,
    effective_evidence: lesson.effective_evidence,
    conclusive_evidence: lesson.effective_evidence.supporting_evidence.map((effectiveEvidence) => {
      const experimentId = effectiveEvidence.experiment_id;
      const experiment = byExperiment.get(experimentId);
      const analysis = analysesById.get(effectiveEvidence.analysis_id);
      const binding = (bindings ?? []).find((row) => row.lesson_id === lesson.id &&
        row.experiment_id === experimentId) ?? null;
      const shortId = binding?.short_id ?? analysis?.youtube_short_id ?? null;
      const polledAt = binding?.snapshot_polled_at ?? analysis?.youtube_snapshot_polled_at ?? null;
      const publication = shortId ? publications.get(shortId) : null;
      const mapping = shortId ? mappings.get(shortId) : null;
      const snapshot = shortId && polledAt ? snapshots.get(`${shortId}|${polledAt}`) : null;
      return {
        experiment_id: experimentId,
        latest_analysis_id: analysis?.id ?? "UNKNOWN",
        latest_conclusion: analysis?.conclusion ?? "UNKNOWN",
        control_creative_id: experiment?.control_creative_id ?? "UNKNOWN",
        variant_creative_id: experiment?.variant_creative_id ?? "UNKNOWN",
        control_publication_id: experiment?.control_youtube_short_id ?? "UNKNOWN",
        variant_publication_id: experiment?.variant_youtube_short_id ?? "UNKNOWN",
        snapshot_key: binding ? {
          short_id: binding.short_id, polled_at: binding.snapshot_polled_at,
        } : analysis?.youtube_short_id && analysis?.youtube_snapshot_polled_at ? {
          short_id: analysis.youtube_short_id, polled_at: analysis.youtube_snapshot_polled_at,
        } : "UNKNOWN",
        identity_map_id: mapping?.id ?? "UNKNOWN",
        mapped_creative_id: mapping?.creative_id ?? "UNKNOWN",
        publication: publication ? {
          short_id: publication.id, external_video_id: publication.youtube_id ?? "UNKNOWN",
          published_at: publication.published_at ?? "UNKNOWN",
        } : "UNKNOWN",
        snapshot_metrics: snapshot
          ? normalizeYoutubeMetricFacts(snapshot, publication ?? {}) : "UNKNOWN",
        metric_provenance: analysis?.metric_sources ?? "UNKNOWN",
        limitations: analysis?.limitations ?? [],
        changed_variable: experiment?.changed_variable ?? "UNKNOWN",
        constants: experiment?.constants ?? {},
      };
    }),
  });
  const own = {
    source_type: "OWN_PERFORMANCE",
    lesson_effective_policy_version: LESSON_EFFECTIVE_POLICY_VERSION,
    evaluation_at: input.evaluation_at,
    lesson_effective_states: effective.states,
    controlled_retests: effective.controlled_retests,
    selected_lessons: selected.map(evidenceShape),
    avoided_lessons: rejected.map(evidenceShape),
    recent_results: [...experiments].filter((row) => ["PASS", "FAIL", "INCONCLUSIVE"].includes(row.result))
      .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) || String(a.id).localeCompare(String(b.id)))
      .slice(0, 10).map((row) => ({ experiment_id: row.id, result: row.result })),
    prompt_framework: framework,
    primary: primary ? {
      lesson_id: primary.lesson.id,
      experiment_id: primary.experiment.id,
      changed_variable: primary.experiment.changed_variable,
      constants: primary.experiment.constants,
      control_material_vector: primary.experiment.control_material_vector,
      effective_evidence: primary.lesson.effective_evidence,
    } : null,
  };
  const hypothesis = primary && framework ? {
    statement: primary.experiment.hypothesis,
    changed_variable: primary.experiment.changed_variable,
    constants: primary.experiment.constants,
    expected_effect: `Improve ${primary.experiment.success_metrics.primary_metric} at ${primary.experiment.success_metrics.checkpoint}`,
    evidence: [{ lesson_id: primary.lesson.id, experiment_id: primary.experiment.id,
      analysis_id: primary.evidence.analysis_id, policy_version: LESSON_EFFECTIVE_POLICY_VERSION,
      effective_state: primary.lesson.effective_evidence }],
    status: "HYPOTHESIS",
    confidence: "LOW",
  } : null;
  const stable = {
    context_version: YOUTUBE_OWN_CONTEXT_VERSION,
    platform: "youtube_shorts",
    OWN_PERFORMANCE: own,
    MARKET_REFERENCE: market,
    prompt_framework: framework,
  };
  const hypothesisKey = hypothesis ? await sha256Hex(canonicalJson({ stable, hypothesis })) : null;
  const owner = ownerPreferences(input.owner_ideas ?? input.ideas ?? []);
  const contextHash = await sha256Hex(canonicalJson({ ...stable, OWNER_PREFERENCE: owner }));
  return {
    ...stable,
    OWNER_PREFERENCE: owner,
    outcome: hypothesis ? "HYPOTHESIS" : "NO_STRONG_HYPOTHESIS",
    hypothesis_candidate: hypothesis,
    hypothesis_key: hypothesisKey,
    context_hash: contextHash,
    limitations: hypothesis ? [] : ["no_verified_youtube_own_hypothesis"],
    controlled_retests: effective.controlled_retests,
  };
}

export async function youtubeFeedbackBatchKey(userId, requestId) {
  return await sha256Hex(canonicalJson({ user_id: userId, platform: "youtube_shorts", request_id: requestId }));
}

export async function annotateYoutubeCandidates(candidates, context) {
  return await Promise.all((candidates ?? []).map(async (candidate) => {
    const referenceId = candidate.reference_id ?? candidate.reference_source_id;
    const market = context.MARKET_REFERENCE.find((row) => row.reference_id === referenceId) ?? null;
    const conflict = market?.conflict ?? null;
    const candidateVector = market && context.OWN_PERFORMANCE.prompt_framework
      ? await deriveYoutubeMaterialVector({
        causal_pattern: market.causal_pattern,
        payoff_class: market.payoff_class,
        prompt_framework_version: context.OWN_PERFORMANCE.prompt_framework.version_label,
        fidelity_constraints: market.fidelity_constraints,
      }) : null;
    const primary = context.OWN_PERFORMANCE.primary;
    const exactOwnMutation = context.hypothesis_candidate && primary && candidateVector &&
      validateYoutubeMaterialChange(primary.control_material_vector, candidateVector,
        primary.changed_variable, primary.constants).valid;
    const ownBound = Boolean(exactOwnMutation && !conflict);
    return {
      ...candidate,
      market_reference_ids: referenceId ? [referenceId] : [],
      selected_lesson_ids: ownBound
        ? context.OWN_PERFORMANCE.selected_lessons.map((row) => row.lesson_id) : [],
      avoided_lesson_ids: ownBound
        ? context.OWN_PERFORMANCE.avoided_lessons.map((row) => row.lesson_id) : [],
      own_experiment_ids: ownBound
        ? context.OWN_PERFORMANCE.selected_lessons.flatMap((row) =>
          row.conclusive_evidence.map((entry) => entry.experiment_id)) : [],
      hypothesis_id: null,
      changed_variable: ownBound ? context.hypothesis_candidate.changed_variable : null,
      experiment_constants: ownBound ? context.hypothesis_candidate.constants : null,
      why_this_idea: conflict
        ? `MARKET-vs-OWN conflict preserved for ${market.pattern_key}; controlled re-test only.`
        : "MARKET_REFERENCE and OWN_PERFORMANCE provenance remain separate.",
      idea_confidence: conflict ? lowerConflictConfidence("MEDIUM") : "MEDIUM",
      evidence_conflicts: conflict ? [{ pattern_key: market.pattern_key, ...conflict }] : [],
      evidence_mode: ownBound ? "OWN_PERFORMANCE_BOUND" : "MARKET_REFERENCE_ONLY",
      evidence_roots: {
        MARKET_REFERENCE: referenceId ? [referenceId] : [],
        OWN_PERFORMANCE: ownBound
          ? context.OWN_PERFORMANCE.selected_lessons.map((row) => row.lesson_id) : [],
        OWNER_PREFERENCE: {
          approved: context.OWNER_PREFERENCE.approved.map((row) => row.idea_id),
          rejected: context.OWNER_PREFERENCE.rejected.map((row) => row.idea_id),
        },
      },
    };
  }));
}

export function formatYoutubeFeedbackContext(context) {
  return [
    `MARKET_REFERENCE=${canonicalJson(context.MARKET_REFERENCE)}`,
    `OWN_PERFORMANCE=${canonicalJson(context.OWN_PERFORMANCE)}`,
    `OWNER_PREFERENCE=${canonicalJson(context.OWNER_PREFERENCE)}`,
    `CONFLICT_POLICY=exact PATTERN key; conflict is preserved and confidence lowered`,
  ].join("\n");
}

export { canonicalJson, sha256Hex };
