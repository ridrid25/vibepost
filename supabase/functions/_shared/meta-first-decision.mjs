import { canonicalJson, sha256Hex } from "./meta-readonly.mjs";

export const EVIDENCE_ROOT_ORDER = Object.freeze([
  "META_PERFORMANCE",
  "OWN_ORGANIC_PERFORMANCE",
  "MARKET_REFERENCE",
  "OWNER_PREFERENCE",
  "EXPERT_RESEARCH_EVIDENCE",
]);
export const MATERIAL_KEYS = Object.freeze([
  "topic", "audience", "format", "angle", "hook", "opening", "cta", "visual", "duration",
]);
export const META_POLICY_V1 = Object.freeze({
  version: "meta-experiment-v1",
  minimum_spend: 50,
  minimum_impressions: 5000,
  minimum_ctr_lift: 0.2,
  minimum_downstream_quality_ratio: 0.9,
  poor_downstream_quality_ratio: 0.7,
  high_cpm: 30,
});

export class MetaDecisionError extends Error {
  constructor(code) {
    super(code);
    this.name = "MetaDecisionError";
    this.code = code;
  }
}

function fail(code) {
  throw new MetaDecisionError(code);
}

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("META_DECISION_SCHEMA_INVALID");
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) fail("META_DECISION_SCHEMA_INVALID");
  return value;
}

function known(metric) {
  return metric?.state === "KNOWN" && typeof metric.value === "number" ? metric.value : null;
}

function actionRecord(batch, snapshotId, actionType) {
  if (actionType === null) return null;
  const matches = batch.actions.filter((item) => item.snapshot_id === snapshotId && item.action_type === actionType);
  if (matches.length !== 1 || matches[0].state !== "KNOWN" || matches[0].authoritative !== true) return null;
  return matches[0];
}

function materialDiff(control, variant) {
  exactObject(control, MATERIAL_KEYS);
  exactObject(variant, MATERIAL_KEYS);
  return MATERIAL_KEYS.filter((key) => control[key] !== variant[key]);
}

function rootRow(root, input) {
  const row = exactObject(input, ["availability", "signal", "evidence_refs", "contribution", "limitations"]);
  if (!["KNOWN", "UNKNOWN"].includes(row.availability) || !["SUPPORT", "OPPOSE", "UNKNOWN"].includes(row.signal) || !Array.isArray(row.evidence_refs) || !Array.isArray(row.limitations) || typeof row.contribution !== "string") fail("META_EVIDENCE_ROOT_INVALID");
  if ((row.availability === "UNKNOWN") !== (row.signal === "UNKNOWN")) fail("META_EVIDENCE_ROOT_INVALID");
  if (root === "META_PERFORMANCE") fail("META_EVIDENCE_ROOT_INVALID");
  return { root, availability: row.availability, evidence_refs: [...row.evidence_refs], contribution: row.contribution, limitations: [...row.limitations] };
}

function selectTopic(profile, evaluation, topicCandidates) {
  if (!Array.isArray(topicCandidates) || topicCandidates.length === 0) fail("META_TOPIC_CANDIDATES_INVALID");
  const candidates = topicCandidates.map((value) => {
    const row = exactObject(value, ["topic_key", "audience_key", "angle_key", "relationship", "evidence_roots"]);
    if (!["CURRENT", "ADJACENT", "NEW"].includes(row.relationship)) fail("META_TOPIC_CANDIDATES_INVALID");
    exactObject(row.evidence_roots, EVIDENCE_ROOT_ORDER.slice(1));
    const roots = Object.fromEntries(EVIDENCE_ROOT_ORDER.slice(1).map((root) => [root, { ...rootRow(root, row.evidence_roots[root]), signal: row.evidence_roots[root].signal }]));
    return { ...row, evidence_roots: roots };
  });
  if (new Set(candidates.map((item) => item.topic_key)).size !== candidates.length) fail("META_TOPIC_CANDIDATES_INVALID");
  const current = candidates.find((item) => item.relationship === "CURRENT" && item.topic_key === profile.topic_key);
  if (!current) fail("META_TOPIC_CANDIDATES_INVALID");
  if (evaluation.verdict === "PASS") return { candidate: current, action: "CONTINUE", changedVariable: evaluation.next_changed_variable };
  if (evaluation.verdict === "INCONCLUSIVE") return { candidate: current, action: "RETEST", changedVariable: evaluation.next_changed_variable };
  if (evaluation.next_changed_variable !== "topic") return { candidate: current, action: "MUTATE", changedVariable: evaluation.next_changed_variable };
  const eligible = candidates.filter((item) => item.relationship !== "CURRENT" &&
    item.evidence_roots.OWNER_PREFERENCE.signal === "SUPPORT" &&
    item.evidence_roots.EXPERT_RESEARCH_EVIDENCE.signal === "SUPPORT" &&
    ["OWN_ORGANIC_PERFORMANCE", "MARKET_REFERENCE"].some((root) => item.evidence_roots[root].signal === "SUPPORT"));
  eligible.sort((left, right) => (left.relationship === right.relationship ? left.topic_key.localeCompare(right.topic_key) : left.relationship === "ADJACENT" ? -1 : 1));
  if (eligible.length === 0) return { candidate: current, action: "PAUSE", changedVariable: "topic" };
  return { candidate: eligible[0], action: eligible[0].relationship === "ADJACENT" ? "EXPLORE_ADJACENT" : "NEW_TOPIC", changedVariable: "topic" };
}

function derivedBusinessMetrics(batch, variant, experiment) {
  const conversion = actionRecord(batch, variant.id, experiment.conversion_action_type);
  const revenue = actionRecord(batch, variant.id, experiment.revenue_action_type);
  const spend = known(variant.metrics.spend);
  const conversionMetric = conversion ? { state: "KNOWN", value: conversion.value } : { state: "UNKNOWN", value: null };
  const cpa = conversion && conversion.value > 0 && spend !== null
    ? { state: "KNOWN", value: spend / conversion.value, currency: variant.currency }
    : { state: "UNKNOWN", value: null, currency: null };
  const roas = revenue && revenue.currency === variant.currency && spend !== null && spend > 0
    ? { state: "KNOWN", value: revenue.value / spend, currency: variant.currency }
    : { state: "UNKNOWN", value: null, currency: null };
  return { conversion: conversionMetric, cpa, roas };
}

function inconclusive(reason, context) {
  return {
    verdict: "INCONCLUSIVE",
    confidence: "LOW",
    reason,
    next_changed_variable: context.changed_variable,
    topic_action: "RETEST",
    lesson_text: `Evidence is insufficient for ${context.changed_variable}; preserve the topic and collect a comparable cohort.`,
    copy_instruction: "Do not change copy from this evidence.",
  };
}

function evaluate(control, variant, controlAction, variantAction, context, policy) {
  const sameContext = control.provider_account_id === variant.provider_account_id &&
    control.date_start === variant.date_start && control.date_stop === variant.date_stop &&
    control.currency === variant.currency && control.attribution_setting === variant.attribution_setting &&
    control.cohort_hash === variant.cohort_hash && control.optimization_goal === variant.optimization_goal &&
    control.placement_key === variant.placement_key && control.audience_key === variant.audience_key;
  if (!sameContext) return inconclusive("COHORT_OR_WINDOW_MISMATCH", context);
  if (context.overlap_ambiguity === true) return inconclusive("CUMULATIVE_OVERLAP_AMBIGUOUS", context);
  if (context.mutation_kind === "NEW_CONCEPT") return inconclusive("NEW_CONCEPT_NOT_AB_TEST", context);
  const diff = materialDiff(context.control_material, context.variant_material);
  if (diff.length !== 1 || diff[0] !== context.changed_variable) return inconclusive("ONE_VARIABLE_RULE_FAILED", context);

  const controlSpend = known(control.metrics.spend); const variantSpend = known(variant.metrics.spend);
  const controlImpressions = known(control.metrics.impressions); const variantImpressions = known(variant.metrics.impressions);
  const controlCtr = known(control.metrics.ctr); const variantCtr = known(variant.metrics.ctr);
  const variantCpm = known(variant.metrics.cpm);
  if ([controlSpend, variantSpend, controlImpressions, variantImpressions, controlCtr, variantCtr].includes(null)) return inconclusive("REQUIRED_METRIC_UNKNOWN", context);
  if (controlSpend < policy.minimum_spend || variantSpend < policy.minimum_spend || controlImpressions < policy.minimum_impressions || variantImpressions < policy.minimum_impressions) return inconclusive("DELIVERY_INSUFFICIENT", context);
  if (controlAction === null || variantAction === null) return inconclusive("AUTHORITATIVE_ACTION_UNKNOWN", context);

  const ctrLift = controlCtr === 0 ? null : (variantCtr - controlCtr) / controlCtr;
  const controlClicks = known(control.metrics.clicks); const variantClicks = known(variant.metrics.clicks);
  const controlQuality = controlClicks && controlClicks > 0 ? controlAction / controlClicks : null;
  const variantQuality = variantClicks && variantClicks > 0 ? variantAction / variantClicks : null;
  const qualityRatio = controlQuality && variantQuality !== null ? variantQuality / controlQuality : null;
  if (ctrLift === null || qualityRatio === null) return inconclusive("QUALITY_RATE_UNKNOWN", context);

  if (variantCpm !== null && variantCpm >= policy.high_cpm && ctrLift < policy.minimum_ctr_lift) {
    return { ...inconclusive("AUCTION_OR_AUDIENCE_CONFOUND", context), ctr_lift: ctrLift, downstream_quality_ratio: qualityRatio };
  }
  if (ctrLift >= policy.minimum_ctr_lift && qualityRatio < policy.poor_downstream_quality_ratio) {
    return {
      verdict: "FAIL", confidence: "MEDIUM", reason: "CTR_UP_DOWNSTREAM_QUALITY_DOWN",
      next_changed_variable: "cta", topic_action: "MUTATE",
      lesson_text: "Preserve the successful hook; align the promise and CTA with the downstream action.",
      copy_instruction: "Preserve the hook and change the CTA expectation.",
      ctr_lift: ctrLift, downstream_quality_ratio: qualityRatio,
    };
  }
  if (ctrLift >= policy.minimum_ctr_lift && qualityRatio >= policy.minimum_downstream_quality_ratio) {
    return {
      verdict: "PASS", confidence: "HIGH", reason: "CTR_UP_QUALITY_PRESERVED",
      next_changed_variable: context.changed_variable, topic_action: "CONTINUE",
      lesson_text: "The evidence-led hook improved CTR while downstream quality held; preserve the topic, audience, angle, offer and CTA.",
      copy_instruction: "Open with measurable proof before the process explanation.",
      ctr_lift: ctrLift, downstream_quality_ratio: qualityRatio,
    };
  }
  return {
    verdict: "FAIL", confidence: "MEDIUM", reason: "DECLARED_KPI_NOT_MET",
    next_changed_variable: context.changed_variable, topic_action: "MUTATE",
    lesson_text: `The ${context.changed_variable} mutation did not meet the declared Meta KPI.`,
    copy_instruction: `Test a different ${context.changed_variable} while preserving the constants snapshot.`,
    ctr_lift: ctrLift, downstream_quality_ratio: qualityRatio,
  };
}

export async function buildMetaFirstDecision({ batch, experiment, topic_candidates, policy = META_POLICY_V1 }) {
  exactObject(experiment, ["experiment_id", "control_binding_id", "variant_binding_id", "control_snapshot_id", "variant_snapshot_id", "primary_action_type", "conversion_action_type", "revenue_action_type", "changed_variable", "mutation_kind", "control_material", "variant_material", "overlap_ambiguity"]);
  const controlBinding = batch.bindings.find((item) => item.id === experiment.control_binding_id);
  const variantBinding = batch.bindings.find((item) => item.id === experiment.variant_binding_id);
  const control = batch.snapshots.find((item) => item.id === experiment.control_snapshot_id);
  const variant = batch.snapshots.find((item) => item.id === experiment.variant_snapshot_id);
  if (!controlBinding || !variantBinding || !control || !variant || control.binding_id !== controlBinding.id || variant.binding_id !== variantBinding.id) fail("META_EXPERIMENT_MAPPING_UNKNOWN");

  const controlAction = actionRecord(batch, control.id, experiment.primary_action_type)?.value ?? null;
  const variantAction = actionRecord(batch, variant.id, experiment.primary_action_type)?.value ?? null;
  const evaluation = evaluate(control, variant, controlAction, variantAction, experiment, policy);
  const profile = batch.profiles.find((item) => item.creative_id === variantBinding.creative_id);
  if (!profile) fail("META_PROFILE_UNKNOWN");
  const topicDecision = selectTopic(profile, evaluation, topic_candidates);
  const controlledNext = topicDecision.action !== "NEW_TOPIC" && topicDecision.action !== "EXPLORE_ADJACENT";
  const constants_snapshot = controlledNext
    ? Object.fromEntries(MATERIAL_KEYS.filter((key) => key !== topicDecision.changedVariable).map((key) => [key, experiment.variant_material[key]]))
    : {};
  const metaRoot = {
    root: "META_PERFORMANCE",
    availability: evaluation.verdict === "INCONCLUSIVE" ? "UNKNOWN" : "KNOWN",
    evidence_refs: [experiment.experiment_id, control.id, variant.id],
    contribution: evaluation.reason,
    limitations: evaluation.verdict === "INCONCLUSIVE" ? [evaluation.reason] : [],
  };
  const why = [metaRoot, ...EVIDENCE_ROOT_ORDER.slice(1).map((root) => {
    const { signal: _signal, ...row } = topicDecision.candidate.evidence_roots[root];
    return row;
  })];
  const unknowns = why.filter((row) => row.availability === "UNKNOWN").map((row) => row.root);
  const businessMetrics = derivedBusinessMetrics(batch, variant, experiment);
  const base = {
    schema: "meta-first-decision-v1",
    batch_hash: batch.batch_hash,
    experiment_id: experiment.experiment_id,
    policy_version: policy.version,
    creative_id: variantBinding.creative_id,
    identity_map_id: variantBinding.identity_map_id,
    exact_meta_mapping: {
      provider_account_id: variant.provider_account_id,
      provider_ad_id: variant.provider_ad_id,
      provider_creative_id: variantBinding.provider_creative_id,
      binding_id: variantBinding.id,
      snapshot_id: variant.id,
    },
    verdict: evaluation.verdict,
    confidence: evaluation.confidence,
    evaluation_reason: evaluation.reason,
    metrics: {
      ctr_lift: evaluation.ctr_lift ?? null,
      downstream_quality_ratio: evaluation.downstream_quality_ratio ?? null,
      ...businessMetrics,
    },
    lesson: {
      lesson_key: await sha256Hex(canonicalJson({ experiment_id: experiment.experiment_id, reason: evaluation.reason, instruction: evaluation.copy_instruction })),
      statement: evaluation.lesson_text,
      changed_variable: evaluation.next_changed_variable,
      copy_instruction: evaluation.copy_instruction,
      preserve: Object.keys(constants_snapshot),
    },
    copy_change_contract: {
      source_changed_variable: experiment.changed_variable,
      next_changed_variable: topicDecision.changedVariable,
      control_value: experiment.control_material[experiment.changed_variable],
      variant_value: experiment.variant_material[experiment.changed_variable],
      instruction: evaluation.copy_instruction,
      constants_snapshot,
    },
    next_hypothesis: {
      hypothesis_key: await sha256Hex(canonicalJson({ experiment_id: experiment.experiment_id, topic: topicDecision.candidate.topic_key, changed_variable: topicDecision.changedVariable, action: topicDecision.action })),
      topic_family_key: topicDecision.candidate.topic_key,
      topic_action: topicDecision.action,
      next_topic_candidate: topicDecision.candidate.topic_key,
      audience: topicDecision.candidate.audience_key,
      angle: topicDecision.candidate.angle_key,
      changed_variable: topicDecision.changedVariable,
      mutation_kind: controlledNext ? experiment.mutation_kind : "NEW_CONCEPT",
      statement: topicDecision.action === "CONTINUE" ? "Reuse the evidence-led topic and angle with the proven hook contract." : `Apply ${topicDecision.action} to ${topicDecision.candidate.topic_key} under the separated evidence roots.`,
      expected_effect: topicDecision.action === "CONTINUE" ? "Preserve downstream quality while applying the stronger opening to the next content family." : "Test the declared topic action without treating unknown evidence as zero.",
      constants_snapshot,
    },
    why_this_topic_now: why,
    evidence_summary: why.filter((row) => row.availability === "KNOWN").map((row) => `${row.root}:${row.contribution}`),
    unknowns,
  };
  return { ...base, decision_id: `decision-${await sha256Hex(canonicalJson(base))}` };
}
