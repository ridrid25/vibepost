import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LESSON_EFFECTIVE_POLICY,
  LESSON_EFFECTIVE_POLICY_VERSION,
  canonicalLessonEffectiveJson,
  compareLessonEffectiveStates,
  evaluateLessonEffectiveStrength,
  evaluateLessonsForFeedback,
  lessonProofContractHash,
  resolveStoredLessonDecision,
} from "../supabase/functions/_shared/lesson-effective-weight.mjs";
import { buildTikTokFeedbackContext } from "../supabase/functions/_shared/tiktok-feedback-context.mjs";
import { buildExperimentProof } from "../supabase/functions/_shared/creative-mutation-lineage.mjs";

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const creative = (value) => `creative-${String(value).padStart(64, "0")}`;
const EVALUATION_AT = "2026-09-01T00:00:00Z";
const FRESH_DATES = ["2026-08-25T00:00:00Z", "2026-08-26T00:00:00Z", "2026-08-27T00:00:00Z"];
const STALE_DATES = ["2026-01-10T00:00:00Z", "2026-01-11T00:00:00Z", "2026-01-12T00:00:00Z"];

const tiktokVector = (hook = "after", changes = {}) => ({
  topic: "finance",
  content_format: "sketch",
  duration_bin: "short",
  character_id: "fox",
  visual_style_id: "quiet-editorial",
  hook_type: hook,
  pacing_profile: "fast",
  punch_type: "reversal",
  loop_type: "visual-return",
  camera_profile: "static-close",
  prompt_framework_version: "PF-v1",
  ...changes,
});

const youtubeVector = (framework = "PF-v2", changes = {}) => ({
  causal_pattern_class: "expectation-violation",
  payoff_class: "visual-reversal",
  prompt_framework_version: framework,
  fidelity_constraints_hash: "a".repeat(64),
  ...changes,
});

function branch({
  index,
  conclusion = "PASS",
  at = FRESH_DATES[index % FRESH_DATES.length],
  platform = "tiktok",
  changedVariable = "hook_type",
  parentValue = "before",
  childValue = "after",
  vectorChanges = {},
  root = null,
  mutationId = null,
  rootMutationId = null,
  confidence = "HIGH",
}) {
  const rootCreative = root ?? creative(1000 + index * 2);
  const childCreative = creative(1001 + index * 2);
  const rootMutation = {
    id: rootMutationId ?? uuid(1000 + index * 2),
    child_creative_id: rootCreative,
    parent_creative_id: null,
    changed_variable: null,
    mutation_kind: "NEW_CONCEPT",
  };
  const mutation = {
    id: mutationId ?? uuid(1001 + index * 2),
    child_creative_id: childCreative,
    parent_creative_id: rootCreative,
    changed_variable: changedVariable,
    mutation_kind: "CONTROLLED_MUTATION",
    source_hypothesis_id: uuid(6000 + index),
    prior_evidence_experiment_id: null,
  };
  const schema = platform === "tiktok" ? "tiktok_v1" : "youtube_v1";
  const base = platform === "tiktok"
    ? tiktokVector(childValue, vectorChanges)
    : youtubeVector(childValue, vectorChanges);
  const parent = { ...base, [changedVariable]: parentValue };
  const child = { ...base, [changedVariable]: childValue };
  const schemaFields = Object.keys(child);
  const constants = Object.fromEntries(Object.entries(child).filter(([key]) => key !== changedVariable));
  const materialDiff = {
    schema_version: 1,
    changed_material_variables: [changedVariable],
    unchanged_material_variables: schemaFields.filter((key) => key !== changedVariable),
    unknown_comparisons: [],
    limitations: [],
  };
  const experiment = {
    id: uuid(2000 + index),
    platform,
    creative_mutation_id: mutation.id,
    hypothesis_id: mutation.source_hypothesis_id,
    control_creative_id: platform === "youtube_shorts" ? rootCreative : null,
    variant_creative_id: platform === "youtube_shorts" ? childCreative : null,
    lineage_material_schema: schema,
    lineage_parent_material_vector: parent,
    lineage_child_material_vector: child,
    lineage_constants_snapshot: constants,
    lineage_material_diff: materialDiff,
    lineage_contract_hash: lessonProofContractHash(canonicalLessonEffectiveJson({
      material_schema: schema, parent_material_vector: parent, child_material_vector: child,
      constants_snapshot: constants, material_diff: materialDiff,
    })),
    changed_variable: changedVariable,
    constants,
    success_metrics: { primary_metric: "like_rate", direction: "increase", checkpoint: "24h", mde: 0.02 },
    hypothesis: `${changedVariable} improves performance`,
    status: "ANALYZED",
    result: conclusion,
    created_at: at,
    updated_at: at,
  };
  const analysis = {
    id: uuid(3000 + index),
    experiment_id: experiment.id,
    platform,
    conclusion,
    confidence,
    created_at: at,
  };
  return { rootMutation, mutation, experiment, analysis, rootCreative, childCreative };
}

function sharedTransitionCrossPlatform({ tiktokConclusion = "PASS", youtubeConclusion = "FAIL" } = {}) {
  const tiktok = branch({ index: 700, platform: "tiktok", conclusion: tiktokConclusion,
    changedVariable: "prompt_framework_version", parentValue: "PF-v1", childValue: "PF-v2" });
  const youtube = branch({ index: 701, platform: "youtube_shorts", conclusion: youtubeConclusion,
    changedVariable: "prompt_framework_version", parentValue: "PF-v1", childValue: "PF-v2" });
  return {
    tiktok: { experiment: tiktok.experiment, analysis: tiktok.analysis },
    youtube: { experiment: youtube.experiment, analysis: youtube.analysis },
    mutations: [tiktok.rootMutation, tiktok.mutation, youtube.rootMutation, youtube.mutation],
  };
}

function lesson({ id = 1, status = "CONFIRMED", category = "WINNING_PATTERN",
  platform = "tiktok", experimentIds = [] } = {}) {
  return {
    id: uuid(id), source_platform: platform, lesson: "Structured mechanism lesson",
    status, category, confidence: status === "CONFIRMED" ? "HIGH" : "MEDIUM",
    evidence: experimentIds.map((experiment_id) => ({ experiment_id })),
    applicable_topics: [], videos_used: [], created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function dataset(branches, lessonRow, extra = {}) {
  return {
    lesson: lessonRow,
    experiments: branches.map((row) => row.experiment),
    analyses: branches.map((row) => row.analysis),
    mutations: branches.flatMap((row) => [row.rootMutation, row.mutation]),
    target_platform: lessonRow.source_platform,
    current_context: lessonRow.source_platform === "tiktok" ? tiktokVector() : youtubeVector(),
    evaluation_at: EVALUATION_AT,
    ...extra,
  };
}

test("policy version and inclusive freshness boundaries are frozen", () => {
  assert.equal(LESSON_EFFECTIVE_POLICY_VERSION, "LESSON_EFFECTIVE_WEIGHT_V1");
  assert.deepEqual(LESSON_EFFECTIVE_POLICY.freshness_seconds,
    { FRESH: 2592000, AGING: 7776000, STALE: 15552000 });
});

test("synchronous proof hash is byte-identical to accepted POST-09 proof builder", async () => {
  const parent = tiktokVector("before");
  const child = tiktokVector("after");
  const constants = Object.fromEntries(Object.entries(parent).filter(([key]) => key !== "hook_type"));
  const proof = await buildExperimentProof({ schema: "tiktok_v1", parent_material_vector: parent,
    child_material_vector: child, changed_variable: "hook_type", experiment_constants: constants });
  assert.equal(lessonProofContractHash(canonicalLessonEffectiveJson({
    material_schema: proof.material_schema, parent_material_vector: proof.parent_material_vector,
    child_material_vector: proof.child_material_vector, constants_snapshot: proof.constants_snapshot,
    material_diff: proof.material_diff,
  })), proof.contract_hash);
});

test("fresh CONFIRMED with three separate roots is VERY_HIGH", () => {
  const rows = [0, 1, 2].map((index) => branch({ index }));
  const row = lesson({ experimentIds: rows.map((item) => item.experiment.id) });
  const result = evaluateLessonEffectiveStrength(dataset(rows, row));
  assert.equal(result.canonical_status, "CONFIRMED");
  assert.equal(result.effective_strength, "VERY_HIGH");
  assert.equal(result.freshness_bucket, "FRESH");
  assert.equal(result.independent_confirmation_count, 3);
  assert.equal(result.lineage_independence, "HIGH");
  assert.equal(result.context_match, "EXACT");
});

test("fresh SUPPORTED outranks stale CONFIRMED without mutating either status", () => {
  const fresh = [10, 11, 12].map((index, offset) => branch({ index, at: FRESH_DATES[offset], childValue: "fresh" }));
  const old = [20, 21, 22].map((index, offset) => branch({ index, at: STALE_DATES[offset], childValue: "legacy" }));
  const supported = lesson({ id: 2, status: "SUPPORTED", experimentIds: fresh.map((row) => row.experiment.id) });
  const confirmed = lesson({ id: 3, status: "CONFIRMED", experimentIds: old.map((row) => row.experiment.id) });
  const all = [...fresh, ...old];
  const input = {
    lessons: [confirmed, supported], experiments: all.map((row) => row.experiment),
    analyses: all.map((row) => row.analysis), mutations: all.flatMap((row) => [row.rootMutation, row.mutation]),
    target_platform: "tiktok", current_context: tiktokVector("fresh"), evaluation_at: EVALUATION_AT,
  };
  const result = evaluateLessonsForFeedback(input);
  const byId = new Map(result.states.map((state) => [state.lesson_id, state]));
  assert.equal(byId.get(confirmed.id).canonical_status, "CONFIRMED");
  assert.equal(byId.get(supported.id).canonical_status, "SUPPORTED");
  assert.ok(compareLessonEffectiveStates(byId.get(supported.id), byId.get(confirmed.id)) < 0);
  assert.equal(result.positive[0].lesson_id, supported.id);
});

test("same-root repetitions count as one independent group", () => {
  const first = branch({ index: 30 });
  const rows = [first, ...[31, 32].map((index, offset) => {
    const row = branch({ index, root: first.rootCreative, rootMutationId: first.rootMutation.id });
    row.rootMutation = first.rootMutation;
    return row;
  })];
  const row = lesson({ id: 4, experimentIds: rows.map((item) => item.experiment.id) });
  const result = evaluateLessonEffectiveStrength(dataset(rows, row));
  assert.equal(result.independent_confirmation_count, 1);
  assert.equal(result.lineage_independence, "LOW");
  assert.notEqual(result.effective_strength, "VERY_HIGH");
});

test("different mechanism fingerprints are evaluated separately and never inflate roots", () => {
  const rows = [0, 1, 2].map((offset) => branch({ index: 33 + offset, childValue: `after-${offset}` }));
  const row = lesson({ id: 40, experimentIds: rows.map((item) => item.experiment.id) });
  const result = evaluateLessonEffectiveStrength(dataset(rows, row));
  assert.equal(Object.hasOwn(result, "evaluated_mechanism_count"), false);
  assert.equal(result.independent_confirmation_count, 1);
  assert.notEqual(result.effective_strength, "VERY_HIGH");
  assert.ok(result.limitations.includes("MULTIPLE_LESSON_MECHANISMS:3"));
});

test("foreign-platform direct link cannot bypass the shared-transition matcher", () => {
  const own = branch({ index: 36 });
  const foreign = branch({ index: 37, platform: "youtube_shorts", conclusion: "FAIL",
    changedVariable: "prompt_framework_version", parentValue: "PF-a", childValue: "PF-b" });
  const row = lesson({ id: 41, experimentIds: [own.experiment.id, foreign.experiment.id] });
  const result = evaluateLessonEffectiveStrength(dataset([own, foreign], row));
  assert.equal(result.contradiction_state, "NO_CONTRADICTION");
  assert.deepEqual(result.contradictory_experiment_ids, []);
});

test("legacy/unbound evidence contributes no fabricated independent roots", () => {
  const experiment = { id: uuid(9001), platform: "tiktok", result: "PASS", status: "ANALYZED" };
  const analysis = { id: uuid(9002), experiment_id: experiment.id, platform: "tiktok",
    conclusion: "PASS", confidence: "HIGH", created_at: FRESH_DATES[0] };
  const row = lesson({ id: 5, experimentIds: [experiment.id] });
  const result = evaluateLessonEffectiveStrength({ lesson: row, experiments: [experiment], analyses: [analysis],
    mutations: [], target_platform: "tiktok", current_context: {}, evaluation_at: EVALUATION_AT });
  assert.equal(result.independent_confirmation_count, 0);
  assert.equal(result.lineage_independence, "UNKNOWN");
  assert.ok(result.limitations.includes("LEGACY_UNLINKED_OR_INCOMPLETE_LINEAGE"));
});

test("direct opposition makes effective strength CONFLICTED and offers a controlled retest", () => {
  const support = [40, 41, 42].map((index, offset) => branch({ index, at: STALE_DATES[offset] }));
  const fails = [43, 44].map((index, offset) => branch({ index, conclusion: "FAIL", at: FRESH_DATES[offset] }));
  const row = lesson({ id: 6, experimentIds: support.map((item) => item.experiment.id) });
  const result = evaluateLessonEffectiveStrength(dataset([...support, ...fails], row));
  assert.equal(result.contradiction_state, "DIRECT_CONTRADICTION");
  assert.equal(result.effective_strength, "CONFLICTED");
  assert.equal(result.canonical_status, "CONFIRMED");
  assert.equal(result.controlled_retest.action, "CONTROLLED_RETEST");
  assert.equal(result.controlled_retest.changed_variable, "hook_type");
});

test("one contextual mismatch is not promoted to direct contradiction", () => {
  const support = [50, 51, 52].map((index) => branch({ index }));
  const fail = branch({ index: 53, conclusion: "FAIL", vectorChanges: { pacing_profile: "slow" } });
  const row = lesson({ id: 7, experimentIds: support.map((item) => item.experiment.id) });
  const result = evaluateLessonEffectiveStrength(dataset([...support, fail], row));
  assert.equal(result.contradiction_state, "CONTEXTUAL_CONTRADICTION");
  assert.notEqual(result.effective_strength, "CONFLICTED");
});

test("LOW-confidence opposition is WEAK and INCONCLUSIVE is insufficient", () => {
  const support = [60, 61, 62].map((index) => branch({ index }));
  const low = branch({ index: 63, conclusion: "FAIL", confidence: "LOW" });
  const row = lesson({ id: 8, experimentIds: support.map((item) => item.experiment.id) });
  assert.equal(evaluateLessonEffectiveStrength(dataset([...support, low], row)).contradiction_state,
    "WEAK_CONTRADICTION");
  const inconclusive = branch({ index: 64, conclusion: "INCONCLUSIVE" });
  assert.equal(evaluateLessonEffectiveStrength(dataset([...support, inconclusive], row)).contradiction_state,
    "INSUFFICIENT_EVIDENCE");
});

test("TikTok support plus exact YouTube opposition is PLATFORM_CONTRADICTION, not global rejection", () => {
  const cross = sharedTransitionCrossPlatform();
  const row = lesson({ id: 9, experimentIds: [cross.tiktok.experiment.id] });
  const result = evaluateLessonEffectiveStrength({
    lesson: row,
    experiments: [cross.tiktok.experiment, cross.youtube.experiment],
    analyses: [cross.tiktok.analysis, cross.youtube.analysis],
    mutations: cross.mutations,
    target_platform: "tiktok",
    current_context: tiktokVector("after", { prompt_framework_version: "PF-v2" }),
    evaluation_at: EVALUATION_AT,
  });
  assert.equal(result.contradiction_state, "PLATFORM_CONTRADICTION");
  assert.equal(result.canonical_status, "CONFIRMED");
  assert.notEqual(result.effective_strength, "CONFLICTED");
  assert.equal(result.platform_scope, "TIKTOK_ONLY");
  assert.ok(result.limitations.includes("CROSS_PLATFORM_NO_SHARED_CONTEXT"));
});

test("cross-platform scope requires exact same-direction bound evidence", () => {
  const cross = sharedTransitionCrossPlatform({ youtubeConclusion: "PASS" });
  const row = lesson({ id: 10, experimentIds: [cross.tiktok.experiment.id] });
  const result = evaluateLessonEffectiveStrength({
    lesson: row, experiments: [cross.tiktok.experiment, cross.youtube.experiment],
    analyses: [cross.tiktok.analysis, cross.youtube.analysis], mutations: cross.mutations,
    target_platform: "tiktok", current_context: tiktokVector("after", { prompt_framework_version: "PF-v2" }),
    evaluation_at: EVALUATION_AT,
  });
  assert.equal(result.platform_scope, "CROSS_PLATFORM");
  const youtubeTarget = evaluateLessonEffectiveStrength({
    lesson: row, experiments: [cross.tiktok.experiment, cross.youtube.experiment],
    analyses: [cross.tiktok.analysis, cross.youtube.analysis], mutations: cross.mutations,
    target_platform: "youtube_shorts", current_context: youtubeVector("PF-v2"), evaluation_at: EVALUATION_AT,
  });
  assert.equal(youtubeTarget.selection_role, "INACTIVE");
});

test("recent REJECTED stays strong avoidance; very-stale REJECTED becomes inactive WEAK", () => {
  const fresh = [70, 71, 72].map((index) => branch({ index, conclusion: "FAIL" }));
  const old = [73, 74, 75].map((index, offset) => branch({ index, conclusion: "FAIL", at: STALE_DATES[offset] }));
  const freshLesson = lesson({ id: 11, status: "REJECTED", category: "FAILED_PATTERN",
    experimentIds: fresh.map((row) => row.experiment.id) });
  const staleLesson = lesson({ id: 12, status: "REJECTED", category: "FAILED_PATTERN",
    experimentIds: old.map((row) => row.experiment.id) });
  const freshResult = evaluateLessonEffectiveStrength(dataset(fresh, freshLesson));
  const staleResult = evaluateLessonEffectiveStrength(dataset(old, staleLesson));
  assert.ok(["HIGH", "VERY_HIGH"].includes(freshResult.effective_strength));
  assert.equal(freshResult.selection_role, "AVOIDANCE");
  assert.equal(staleResult.effective_strength, "WEAK");
  assert.equal(staleResult.selection_role, "INACTIVE");
  assert.equal(staleResult.controlled_retest.action, "CONTROLLED_RETEST");
});

test("invalid evaluation time rejects; corrupt and future evidence fail closed", () => {
  const row = branch({ index: 80 });
  const item = lesson({ id: 13, experimentIds: [row.experiment.id] });
  assert.throws(() => evaluateLessonEffectiveStrength({ ...dataset([row], item), evaluation_at: "bad" }),
    /evaluation_at/);
  for (const created_at of ["2026-02-30T00:00:00Z", "2026-09-02T00:00:00Z"]) {
    const changed = { ...row, analysis: { ...row.analysis, created_at } };
    const result = evaluateLessonEffectiveStrength(dataset([changed], item));
    assert.equal(result.effective_strength, "UNKNOWN");
    assert.equal(result.freshness_bucket, "UNKNOWN");
  }
});

test("invalid unrelated analysis is not attached to another lesson", () => {
  const rows = [81, 82, 83].map((index) => branch({ index }));
  const unrelated = branch({ index: 84, childValue: "unrelated" });
  unrelated.analysis = { ...unrelated.analysis, created_at: "2026-09-02T00:00:00Z" };
  const row = lesson({ id: 42, experimentIds: rows.map((item) => item.experiment.id) });
  const result = evaluateLessonEffectiveStrength(dataset([...rows, unrelated], row));
  assert.ok(!result.limitations.some((value) => value.includes(unrelated.experiment.id)));
});

test("incomplete immutable proof is fail-closed and never falls back to experiment constants", () => {
  const complete = branch({ index: 85 });
  const experiment = { ...complete.experiment };
  delete experiment.lineage_material_diff;
  delete experiment.lineage_contract_hash;
  experiment.constants = { attacker_controlled: "value" };
  const changed = { ...complete, experiment };
  const row = lesson({ id: 43, experimentIds: [experiment.id] });
  const result = evaluateLessonEffectiveStrength(dataset([changed], row));
  assert.equal(result.effective_strength, "UNKNOWN");
  assert.ok(result.limitations.includes(`INCOMPLETE_LINEAGE_PROOF:${experiment.id}`));
  assert.ok(result.limitations.includes("LEGACY_UNLINKED_OR_INCOMPLETE_LINEAGE"));
});

test("tampered proof hash or source-hypothesis binding is rejected", () => {
  for (const mode of ["hash", "binding"]) {
    const complete = branch({ index: mode === "hash" ? 86 : 87 });
    if (mode === "hash") complete.experiment.lineage_contract_hash = "0".repeat(64);
    else complete.mutation.source_hypothesis_id = uuid(999999);
    const row = lesson({ id: mode === "hash" ? 44 : 45, experimentIds: [complete.experiment.id] });
    const result = evaluateLessonEffectiveStrength(dataset([complete], row));
    assert.equal(result.effective_strength, "UNKNOWN");
    assert.ok(result.limitations.includes(`INCOMPLETE_LINEAGE_PROOF:${complete.experiment.id}`));
  }
});

test("relevant complete proof without analysis has explicit limitation", () => {
  const complete = branch({ index: 88 });
  const row = lesson({ id: 46, experimentIds: [complete.experiment.id] });
  const result = evaluateLessonEffectiveStrength({ ...dataset([complete], row), analyses: [] });
  assert.equal(result.effective_strength, "UNKNOWN");
  assert.ok(result.limitations.includes(`AUTHORITATIVE_ANALYSIS_MISSING:${complete.experiment.id}`));
});

test("same explicit input is byte-deterministic and never mutates historical rows", () => {
  const rows = [90, 91, 92].map((index) => branch({ index }));
  const row = lesson({ id: 14, experimentIds: rows.map((item) => item.experiment.id) });
  const input = dataset(rows, row);
  const before = structuredClone(input);
  const first = evaluateLessonEffectiveStrength(input);
  const second = evaluateLessonEffectiveStrength(input);
  assert.equal(canonicalLessonEffectiveJson(first), canonicalLessonEffectiveJson(second));
  assert.deepEqual(input, before);
  assert.equal(row.status, "CONFIRMED");
});

function tiktokBuilderFixture(branches, lessons) {
  return {
    lessons,
    experiments: branches.map((row) => row.experiment),
    analyses: branches.map((row) => row.analysis),
    mutations: branches.flatMap((row) => [row.rootMutation, row.mutation]),
    hypotheses: [],
    framework: {
      id: uuid(9500), version_label: "PF-v1", status: "STANDARD", is_current: true,
      prompt_framework_rules: [{ id: uuid(9501), status: "STANDARD", confidence: "HIGH",
        updated_at: FRESH_DATES[0] }],
    },
    ideas: [{ id: uuid(9600), target_platform: "tiktok", status: "done", route: "self",
      decided_at: "2025-01-01T00:00:00Z", created_at: "2025-01-01T00:00:00Z",
      animal: "Fox", hook: "Hook", changed_variable: "hook_type", idea_pattern: "fox|hook" }],
    snapshots: [], studio_metrics: [], evaluation_at: EVALUATION_AT,
    current_context: tiktokVector(),
  };
}

test("E2E 1: fresh three-root lesson enters TikTok feedback with versioned effective provenance", async () => {
  const rows = [100, 101, 102].map((index) => branch({ index }));
  const row = lesson({ id: 15, experimentIds: rows.map((item) => item.experiment.id) });
  const context = await buildTikTokFeedbackContext(tiktokBuilderFixture(rows, [row]));
  assert.equal(context.outcome, "HYPOTHESIS");
  assert.equal(context.OWN_PERFORMANCE.selected_lessons[0].effective_evidence.effective_strength, "VERY_HIGH");
  assert.equal(context.OWN_PERFORMANCE.lesson_effective_policy_version, LESSON_EFFECTIVE_POLICY_VERSION);
  assert.equal(context.hypothesis_candidate.evidence[0].policy_version, LESSON_EFFECTIVE_POLICY_VERSION);
  assert.equal(context.OWNER_PREFERENCE.approved[0].idea_id, uuid(9600));
});

test("E2E 2: stale CONFIRMED plus independent FAIL stays canonical and becomes controlled retest", async () => {
  const support = [110, 111, 112].map((index, offset) => branch({ index, at: STALE_DATES[offset] }));
  const fails = [113, 114].map((index, offset) => branch({ index, conclusion: "FAIL", at: FRESH_DATES[offset] }));
  const row = lesson({ id: 16, experimentIds: support.map((item) => item.experiment.id) });
  const context = await buildTikTokFeedbackContext(tiktokBuilderFixture([...support, ...fails], [row]));
  const state = context.OWN_PERFORMANCE.lesson_effective_states.find((item) => item.lesson_id === row.id);
  assert.equal(state.canonical_status, "CONFIRMED");
  assert.equal(state.effective_strength, "CONFLICTED");
  assert.equal(context.OWN_PERFORMANCE.selected_lessons.length, 0);
  assert.equal(context.controlled_retests[0].action, "CONTROLLED_RETEST");
});

test("E2E 3: platform conflict is preserved while target support remains platform-specific", () => {
  const cross = sharedTransitionCrossPlatform();
  const row = lesson({ id: 17, experimentIds: [cross.tiktok.experiment.id] });
  const result = evaluateLessonsForFeedback({
    lessons: [row], experiments: [cross.tiktok.experiment, cross.youtube.experiment],
    analyses: [cross.tiktok.analysis, cross.youtube.analysis], mutations: cross.mutations,
    target_platform: "tiktok", current_context: tiktokVector("after", { prompt_framework_version: "PF-v2" }),
    evaluation_at: EVALUATION_AT,
  });
  assert.equal(result.states[0].contradiction_state, "PLATFORM_CONTRADICTION");
  assert.deepEqual(result.states[0].supporting_experiment_ids, [cross.tiktok.experiment.id]);
  assert.deepEqual(result.states[0].contradictory_experiment_ids, [cross.youtube.experiment.id]);
});

test("selection provenance resolves a persisted replay snapshot and prompt pointers", async () => {
  const rows = [120, 121, 122].map((index) => branch({ index }));
  const row = lesson({ id: 18, experimentIds: rows.map((item) => item.experiment.id) });
  const context = await buildTikTokFeedbackContext(tiktokBuilderFixture(rows, [row]));
  const hypothesis = {
    id: uuid(9800), feedback_context: { platform: context.platform, OWN_PERFORMANCE: context.OWN_PERFORMANCE },
  };
  const batchKey = "b".repeat(64);
  const pointers = {
    target_platform: "tiktok", hypothesis_id: hypothesis.id,
    feedback_batch_key: batchKey, youtube_feedback_batch_key: null,
    feedback_context_hash: context.context_hash, youtube_feedback_context_hash: null,
    selected_lesson_ids: context.OWN_PERFORMANCE.selected_lessons.map((item) => item.lesson_id),
    avoided_lesson_ids: [],
  };
  const ideas = [{ id: uuid(9801), ...pointers }, { id: uuid(9802), ...pointers }];
  const stored = resolveStoredLessonDecision({ ideas, hypotheses: [hypothesis],
    platform: "tiktok", batch_key: batchKey });
  const promptPointer = {
    hypothesis_id: stored.hypothesis_id,
    feedback_context_hash: stored.feedback_context_hash,
    selected_lesson_ids: stored.selected_lesson_ids,
    avoided_lesson_ids: stored.avoided_lesson_ids,
  };
  assert.equal(stored.evaluation_at, EVALUATION_AT);
  assert.equal(stored.lesson_effective_policy_version, LESSON_EFFECTIVE_POLICY_VERSION);
  assert.equal(stored.feedback_context.OWN_PERFORMANCE.lesson_effective_states[0].policy_version,
    LESSON_EFFECTIVE_POLICY_VERSION);
  assert.deepEqual(promptPointer.selected_lesson_ids, pointers.selected_lesson_ids);
  assert.equal(promptPointer.feedback_context_hash, context.context_hash);
});

test("YouTube market-only and mixed replay preserve accepted null-hypothesis semantics", () => {
  const batchKey = "c".repeat(64);
  const contextHash = "d".repeat(64);
  const base = { target_platform: "youtube_shorts", youtube_feedback_batch_key: batchKey,
    feedback_batch_key: null, youtube_feedback_context_hash: contextHash,
    feedback_context_hash: null, selected_lesson_ids: [], avoided_lesson_ids: [] };
  const marketOnly = resolveStoredLessonDecision({ ideas: [{ id: uuid(9901), ...base,
    hypothesis_id: null, evidence_mode: "MARKET_REFERENCE_ONLY" }], hypotheses: [],
  platform: "youtube_shorts", batch_key: batchKey });
  assert.equal(marketOnly.hypothesis_id, null);
  assert.deepEqual(marketOnly.limitations, ["MARKET_REFERENCE_ONLY_REPLAY"]);
  const hypothesis = { id: uuid(9902), feedback_context: { OWN_PERFORMANCE: {
    lesson_effective_policy_version: LESSON_EFFECTIVE_POLICY_VERSION, evaluation_at: EVALUATION_AT,
  } } };
  const own = { id: uuid(9903), ...base, hypothesis_id: hypothesis.id,
    evidence_mode: "OWN_PERFORMANCE_BOUND", selected_lesson_ids: [uuid(15)] };
  const mixed = resolveStoredLessonDecision({ ideas: [own, { id: uuid(9904), ...base,
    hypothesis_id: null, evidence_mode: "MARKET_REFERENCE_ONLY" }], hypotheses: [hypothesis],
  platform: "youtube_shorts", batch_key: batchKey });
  assert.equal(mixed.hypothesis_id, hypothesis.id);
  assert.ok(mixed.limitations.includes("MIXED_MARKET_AND_OWN_REPLAY"));
});

test("owner preference does not decay and market evidence is outside the evaluator", async () => {
  const rows = [130, 131, 132].map((index) => branch({ index }));
  const row = lesson({ id: 19, experimentIds: rows.map((item) => item.experiment.id) });
  const market = { MARKET_REFERENCE: [{ id: "MR-1", captured_at: "2020-01-01T00:00:00Z" }] };
  const before = structuredClone(market);
  const context = await buildTikTokFeedbackContext(tiktokBuilderFixture(rows, [row]));
  assert.equal(context.OWNER_PREFERENCE.approved.length, 1);
  assert.deepEqual(market, before);
  assert.ok(!canonicalLessonEffectiveJson(context.OWN_PERFORMANCE).includes("MARKET_REFERENCE"));
});

test("implementation is compute-on-read and loads owner-scoped full evidence without a new store", () => {
  const evaluator = readFileSync("supabase/functions/_shared/lesson-effective-weight.mjs", "utf8");
  const suggest = readFileSync("supabase/functions/suggest-ideas/index.ts", "utf8");
  const market = readFileSync("supabase/functions/tiktok-market-reference/index.ts", "utf8");
  const combined = `${evaluator}\n${suggest}\n${market}`;
  assert.doesNotMatch(combined, /create table|lesson_scores_v2|effective_lesson_state/i);
  assert.match(suggest, /from\("creative_mutations"\)[\s\S]*eq\("user_id", userId\)/);
  assert.match(suggest, /from\("experiments"\)[\s\S]*eq\("user_id", userId\)/);
  assert.match(suggest, /lesson_effective_states/);
  assert.match(market, /evaluation_at: new Date\(\)\.toISOString\(\)/);
});

test("market persistence compatibility reuses the accepted RPC and permits one immutable enrichment", () => {
  const sql = readFileSync("supabase/migrations/20260901000001_lesson_effective_weight_v1.sql", "utf8");
  assert.doesNotMatch(sql, /create\s+table|drop\s+table|delete\s+from|truncate/i);
  assert.match(sql, /rename to persist_tiktok_market_feedback_batch_pre_post10/i);
  assert.match(sql, /post10_legacy_market_context/);
  assert.match(sql, /LESSON_EFFECTIVE_WEIGHT_V1/);
  assert.match(sql, /app\.post10_effective_context_upgrade/);
  assert.match(sql, /old\.feedback_context is not distinct from[\s\S]*post10_legacy_market_context/i);
  assert.match(sql, /persist_tiktok_market_feedback_batch_pre_post10\(/i);
  assert.match(sql, /feedback_context=p_market_context/i);
  assert.match(sql, /revoke execute[\s\S]*from public,anon,authenticated/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
});
