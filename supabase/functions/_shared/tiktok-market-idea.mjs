import {
  canonicalJson,
  sha256Hex,
  validateTikTokCandidates,
} from "./tiktok-feedback-context.mjs";

export const TIKTOK_MARKET_IDEA_VERSION = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE = new Set(["TAKE", "INTERESTING_MECHANIC"]);
const DNA_MAP = Object.freeze([
  ["hook_type", "hook_type"],
  ["content_format", "content_format"],
  ["pacing_profile", "pacing_profile"],
  ["camera_pattern", "camera_profile"],
  ["payoff", "punch_type"],
  ["loop_mechanic", "loop_type"],
  ["visual_pattern", "visual_style_id"],
  ["character_role", "character_id"],
  ["CTA", "topic"],
]);
const FIELD_PRIORITY = new Map(DNA_MAP.map(([, field], index) => [field, index]));
const SOURCE_IDENTITY = /(?:https?:\/\/|www\.|tiktok\.com|@[\p{L}\p{N}_.-]+|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b\d{15,}\b)/iu;
const COPY_INSTRUCTION = /(?:сдела(?:й|ть)\s+(?:точно\s+)?как|повтори(?:ть)?\s+(?:этот\s+)?(?:ролик|кадр)|(?:клонируй|скопируй)\s+(?:этот\s+)?ролик|дословно|кадр\s*\d|exact\s+(?:caption|script|shot)|copy\s+(?:this|the)|make\s+(?:(?:it|this)\s+)?(?:(?:exactly|just)\s+)?like\s+(?:this|the)\s+tiktok|(?:clone|replicate)\s+(?:this|the)\s+tiktok|verbatim)/iu;

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function time(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function ids(values) {
  return [...new Set((values ?? []).filter((value) => UUID.test(String(value))))].sort();
}

function abstractText(value) {
  const text = String(value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!text || text.length > 500 || SOURCE_IDENTITY.test(text) || COPY_INSTRUCTION.test(text)) {
    throw new Error("market_mechanic_anti_copy_rejected");
  }
  return text;
}

function acceptedDnaByReference(evidence) {
  const ordered = (Array.isArray(evidence) ? evidence : [])
    .filter((row) => row?.evidence_kind === "DNA_INFERENCE" && UUID.test(String(row.id ?? "")) &&
      UUID.test(String(row.market_reference_id ?? "")) && row.analysis_identity === "HUMAN_REVIEW" &&
      row.payload?.reviewer_status === "ACCEPTED" && object(row.payload?.fields))
    .sort((left, right) => Number(right.evidence_version ?? 0) - Number(left.evidence_version ?? 0) ||
      time(right.created_at) - time(left.created_at) || String(left.id).localeCompare(String(right.id)));
  const result = new Map();
  for (const row of ordered) if (!result.has(row.market_reference_id)) result.set(row.market_reference_id, row);
  return result;
}

function mechanicsFor(reference, dna, key) {
  const result = [];
  for (const [dnaField, materialField] of DNA_MAP) {
    const entry = dna.payload.fields[dnaField];
    if (entry?.status !== "INFERENCE") continue;
    result.push({
      key,
      field: materialField,
      value: abstractText(entry.value),
      market_reference_id: reference.id,
      market_dna_id: dna.id,
      confidence: dna.payload.confidence ?? dna.confidence ?? "LOW",
      limitations: Array.isArray(dna.payload.limitations) ? dna.payload.limitations.map(abstractText) : [],
      disposition: reference.owner_disposition,
    });
  }
  return result;
}

function selectedLessons(base) {
  return Array.isArray(base?.OWN_PERFORMANCE?.selected_lessons)
    ? base.OWN_PERFORMANCE.selected_lessons : [];
}

function ownStrength(base) {
  const statuses = selectedLessons(base).map((lesson) => lesson.status);
  if (statuses.includes("CONFIRMED")) return "HIGH";
  if (statuses.includes("SUPPORTED")) return "MEDIUM";
  return "LOW";
}

function ownExperimentIds(base) {
  return ids([
    base?.OWN_PERFORMANCE?.primary?.experiment_id,
    ...selectedLessons(base).flatMap((lesson) => (lesson.conclusive_evidence ?? [])
      .map((entry) => entry.experiment_id)),
    ...(base?.OWN_PERFORMANCE?.avoided_lessons ?? []).flatMap((lesson) =>
      (lesson.conclusive_evidence ?? []).map((entry) => entry.experiment_id)),
  ]);
}

function ownerIdeaIds(base, kind) {
  return ids((base?.OWNER_PREFERENCE?.[kind] ?? []).map((entry) => entry.idea_id));
}

function conflictsFor(base, positiveMechanics, avoidanceMechanics) {
  const conflicts = [];
  const failedVariables = new Map();
  for (const result of base?.OWN_PERFORMANCE?.recent_results ?? []) {
    if (result?.result !== "FAIL" || typeof result.changed_variable !== "string") continue;
    const list = failedVariables.get(result.changed_variable) ?? [];
    if (UUID.test(String(result.experiment_id ?? ""))) list.push(result.experiment_id);
    failedVariables.set(result.changed_variable, list);
  }
  for (const mechanic of positiveMechanics) {
    const failed = ids(failedVariables.get(mechanic.field) ?? []);
    if (failed.length) conflicts.push({
      conflict_type: "MARKET_VARIABLE_OWN_FAIL",
      market_reference_ids: [mechanic.market_reference_id],
      market_dna_ids: [mechanic.market_dna_id],
      own_evidence_ids: failed,
      owner_preference_ids: [],
      resolution: "CONTROLLED_RETEST",
      confidence: "LOW",
      limitations: ["NO_SEMANTIC_VALUE_MATCH"],
      field: mechanic.field,
      market_key: mechanic.key,
    });
    for (const avoidance of avoidanceMechanics) {
      if (avoidance.field !== mechanic.field || avoidance.value !== mechanic.value) continue;
      conflicts.push({
        conflict_type: "OWNER_MARKET_EXACT_CONFLICT",
        market_reference_ids: [mechanic.market_reference_id],
        market_dna_ids: [mechanic.market_dna_id],
        own_evidence_ids: [],
        owner_preference_ids: [avoidance.market_reference_id],
        resolution: "AVOID",
        confidence: "HIGH",
        limitations: [],
        field: mechanic.field,
        market_key: mechanic.key,
      });
    }
  }
  return conflicts.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function generationMechanic(mechanic) {
  return { key: mechanic.key, field: mechanic.field, value: mechanic.value,
    confidence: mechanic.confidence, limitations: mechanic.limitations };
}

export async function marketFeedbackBatchKey(baseBatchKey, marketContextHash) {
  if (!/^[0-9a-f]{64}$/.test(String(baseBatchKey)) || !/^[0-9a-f]{64}$/.test(String(marketContextHash))) {
    throw new Error("market_batch_key_invalid");
  }
  return await sha256Hex(canonicalJson({
    domain: "vibepost:tiktok-market-feedback-batch:v1",
    base_batch_key: baseBatchKey,
    market_context_hash: marketContextHash,
  }));
}

export async function buildTikTokMarketIdeaContext(base, input = {}) {
  if (!object(base) || base.platform !== "tiktok" || !object(base.OWN_PERFORMANCE) ||
      !object(base.OWNER_PREFERENCE) || typeof base.context_hash !== "string") {
    throw new Error("market_base_context_invalid");
  }
  const framework = base.OWN_PERFORMANCE.prompt_framework;
  if (!object(framework) || !UUID.test(String(framework.id ?? "")) ||
      typeof framework.version_label !== "string" || !framework.version_label) {
    return { active: false, outcome: "NO_MARKET_HYPOTHESIS", reason: "NO_ELIGIBLE_CURRENT_PROMPT_FRAMEWORK",
      base_context: base };
  }
  const dnaByReference = acceptedDnaByReference(input.evidence);
  const references = (Array.isArray(input.references) ? input.references : [])
    .filter((row) => UUID.test(String(row?.id ?? "")) && dnaByReference.has(row.id))
    .sort((left, right) => time(right.updated_at) - time(left.updated_at) ||
      String(left.id).localeCompare(String(right.id)));
  const positiveRefs = references.filter((row) => POSITIVE.has(row.owner_disposition)).slice(0, 5);
  const avoidanceRefs = references.filter((row) => row.owner_disposition === "NOT_MY_STYLE").slice(0, 5);
  const positiveMechanics = positiveRefs.flatMap((reference, index) =>
    mechanicsFor(reference, dnaByReference.get(reference.id), `M${index + 1}`))
    .sort((left, right) => (FIELD_PRIORITY.get(left.field) ?? 999) -
      (FIELD_PRIORITY.get(right.field) ?? 999) || left.key.localeCompare(right.key) ||
      left.field.localeCompare(right.field) || left.market_dna_id.localeCompare(right.market_dna_id));
  const avoidanceMechanics = avoidanceRefs.flatMap((reference, index) =>
    mechanicsFor(reference, dnaByReference.get(reference.id), `A${index + 1}`));
  if (!positiveMechanics.length) return { active: false, outcome: "NO_MARKET_HYPOTHESIS",
    reason: "NO_ELIGIBLE_ACCEPTED_MARKET_DNA", base_context: base };

  const conflicts = conflictsFor(base, positiveMechanics, avoidanceMechanics);
  const avoided = new Set(conflicts.filter((entry) => entry.resolution === "AVOID")
    .map((entry) => `${entry.market_key}|${entry.field}`));
  const ownVariable = base.hypothesis_candidate?.changed_variable ?? null;
  const eligible = positiveMechanics.filter((mechanic) => !avoided.has(`${mechanic.key}|${mechanic.field}`) &&
    (!ownVariable || mechanic.field === ownVariable));
  if (!eligible.length) return { active: false, outcome: "NO_MARKET_HYPOTHESIS",
    reason: ownVariable ? "NO_MARKET_MECHANIC_ALIGNED_WITH_OWN_HYPOTHESIS" : "ALL_MARKET_MECHANICS_AVOIDED",
    base_context: base };
  const selected = eligible[0];
  const changedVariable = ownVariable ?? selected.field;
  const activeMechanics = eligible.filter((mechanic) => mechanic.field === changedVariable);
  const deferred = [...new Set(positiveMechanics.filter((mechanic) => mechanic.field !== changedVariable)
    .map((mechanic) => mechanic.field))].sort();
  const constants = ownVariable ? base.hypothesis_candidate.constants : {
    change_policy: "ONE_MATERIAL_VARIABLE",
    prompt_framework_version: framework.version_label,
    held_constant_market_fields: deferred,
  };
  const hypothesis = ownVariable ? {
    ...base.hypothesis_candidate,
    evidence: [...(base.hypothesis_candidate.evidence ?? []), {
      source_type: "MARKET_REFERENCE",
      market_reference_ids: ids(activeMechanics.map((mechanic) => mechanic.market_reference_id)),
      market_dna_ids: ids(activeMechanics.map((mechanic) => mechanic.market_dna_id)),
    }],
    uncertainty: "MARKET_SIGNAL_DOES_NOT_PROVE_ACCOUNT_EFFECT",
  } : {
    statement: `Проверить абстрактную market-механику, изменяя только ${changedVariable}.`,
    changed_variable: changedVariable,
    constants,
    expected_effect: "UNKNOWN_UNTIL_OWN_EXPERIMENT",
    rationale: "MARKET_REFERENCE is a hypothesis source; account effect is unproven.",
    evidence: [{ source_type: "MARKET_REFERENCE",
      market_reference_ids: [selected.market_reference_id], market_dna_ids: [selected.market_dna_id] }],
    uncertainty: "MARKET_ONLY_LOW_CONFIDENCE",
  };
  const marketRoot = {
    source_type: "MARKET_REFERENCE",
    references: positiveRefs.map((reference, index) => ({
      key: `M${index + 1}`,
      market_reference_id: reference.id,
      market_dna_id: dnaByReference.get(reference.id).id,
      disposition: reference.owner_disposition,
      mechanics: activeMechanics.filter((mechanic) => mechanic.key === `M${index + 1}`)
        .map(generationMechanic),
    })).filter((reference) => reference.mechanics.length > 0),
    selected_changed_variable: changedVariable,
    confidence: ownVariable ? ownStrength(base) : "LOW",
    limitations: ["MARKET_SIGNAL_NOT_OWN_ACCOUNT_RESULT"],
  };
  const ownerRoot = {
    ...JSON.parse(JSON.stringify(base.OWNER_PREFERENCE)),
    MARKET_AVOIDANCE: avoidanceRefs.map((reference, index) => ({
      preference_id: reference.id,
      dna_evidence_id: dnaByReference.get(reference.id).id,
      mechanics: avoidanceMechanics.filter((mechanic) => mechanic.key === `A${index + 1}`)
        .map(({ field, value }) => ({ field, value })),
    })),
  };
  const stable = {
    integration_version: TIKTOK_MARKET_IDEA_VERSION,
    platform: "tiktok",
    base_context_hash: base.context_hash,
    OWN_PERFORMANCE: base.OWN_PERFORMANCE,
    OWNER_PREFERENCE: ownerRoot,
    MARKET_REFERENCE: marketRoot,
    conflicts,
    hypothesis_candidate: hypothesis,
  };
  const contextHash = await sha256Hex(canonicalJson(stable));
  const hypothesisKey = await sha256Hex(canonicalJson({
    domain: "vibepost:tiktok-market-hypothesis:v1", context_hash: contextHash,
    changed_variable: changedVariable, constants,
  }));
  return {
    ...stable,
    active: true,
    outcome: "HYPOTHESIS",
    context_hash: contextHash,
    hypothesis_key: hypothesisKey,
    base_context: base,
    eligible_mechanics: activeMechanics,
    selected_mechanic: selected,
  };
}

export function formatTikTokMarketIdeaPromptContext(context) {
  if (!context?.active) return "";
  const market = {
    source_type: "MARKET_REFERENCE",
    references: context.MARKET_REFERENCE.references.map((reference) => ({
      key: reference.key, disposition: reference.disposition, mechanics: reference.mechanics,
    })),
    selected_changed_variable: context.MARKET_REFERENCE.selected_changed_variable,
    confidence: context.MARKET_REFERENCE.confidence,
    limitations: context.MARKET_REFERENCE.limitations,
  };
  const owner = {
    source_type: "OWNER_PREFERENCE",
    approved_constraints: (context.OWNER_PREFERENCE.approved ?? []).map(({ animal, hook }) => ({ animal, hook })),
    rejected_constraints: (context.OWNER_PREFERENCE.rejected ?? []).map(({ animal, hook }) => ({ animal, hook })),
    market_avoidance: (context.OWNER_PREFERENCE.MARKET_AVOIDANCE ?? []).map((entry) => entry.mechanics),
  };
  const visibleConflicts = context.conflicts.map((entry) => ({
    conflict_type: entry.conflict_type, resolution: entry.resolution,
    confidence: entry.confidence, limitations: entry.limitations, field: entry.field,
    market_key: entry.market_key,
  }));
  const result = [
    "POST-08 TIKTOK MARKET CONTEXT. MARKET_REFERENCE is hypothesis input, never own performance.",
    `MARKET_REFERENCE=${canonicalJson(market)}`,
    `OWNER_PREFERENCE_CONSTRAINTS=${canonicalJson(owner)}`,
    `EVIDENCE_CONFLICTS=${canonicalJson(visibleConflicts)}`,
    `ONE_CHANGED_VARIABLE=${context.hypothesis_candidate.changed_variable}`,
    `CONSTANTS=${canonicalJson(context.hypothesis_candidate.constants)}`,
    "Return market_mechanic_key=M1..M5 or NONE and novelty_status=NEW_CONCEPT|CONTROLLED_MUTATION|MARKET_INSPIRED_TEST.",
    "Never include a source URL, creator identity, source caption/transcript, exact shot list, logo, likeness or source audio.",
  ].join("\n");
  if (SOURCE_IDENTITY.test(result)) throw new Error("market_prompt_context_identity_leak");
  return result;
}

export function validateTikTokMarketCandidates(candidates, context) {
  if (!context?.active) throw new Error("market_context_inactive");
  const baseCandidates = validateTikTokCandidates(candidates, {
    ...context.base_context,
    hypothesis_candidate: context.hypothesis_candidate,
  });
  const mechanicsByKey = new Map(context.MARKET_REFERENCE.references.map((entry) => [entry.key, entry]));
  const counts = new Map();
  const result = baseCandidates.map((candidate, index) => {
    const source = candidates[index];
    const key = source.market_mechanic_key;
    const novelty = source.novelty_status;
    if (!(key === "NONE" || mechanicsByKey.has(key))) throw new Error("market_candidate_key_invalid");
    if (!new Set(["NEW_CONCEPT", "CONTROLLED_MUTATION", "MARKET_INSPIRED_TEST"]).has(novelty)) {
      throw new Error("market_candidate_novelty_invalid");
    }
    if (key === "NONE" && novelty !== "NEW_CONCEPT") throw new Error("market_candidate_none_not_new");
    const candidateText = `${candidate.slug}\n${candidate.animal}\n${candidate.hook}\n${candidate.line}\n${candidate.prompt}\n${candidate.why_this_idea}`;
    if (SOURCE_IDENTITY.test(candidateText) || COPY_INSTRUCTION.test(candidateText)) {
      throw new Error("market_candidate_identity_leak");
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (key !== "NONE" && counts.get(key) > 2) throw new Error("market_candidate_diversity_violation");
    const market = key === "NONE" ? null : mechanicsByKey.get(key);
    const marketReferenceIds = market ? [market.market_reference_id] : [];
    const marketDnaIds = market ? [market.market_dna_id] : [];
    const ownLessonIds = ids(selectedLessons(context.base_context).map((lesson) => lesson.lesson_id));
    const avoidedLessonIds = ids((context.base_context.OWN_PERFORMANCE.avoided_lessons ?? [])
      .map((lesson) => lesson.lesson_id));
    const ownExperiments = ownExperimentIds(context.base_context);
    const approved = ownerIdeaIds(context.base_context, "approved");
    const rejected = ownerIdeaIds(context.base_context, "rejected");
    const marketDispositionIds = marketReferenceIds;
    const marketAvoidanceIds = ids((context.OWNER_PREFERENCE.MARKET_AVOIDANCE ?? [])
      .map((entry) => entry.preference_id));
    const ownerPreferenceIds = ids([...approved, ...rejected, ...marketDispositionIds, ...marketAvoidanceIds]);
    const relevantConflicts = key === "NONE" ? [] : context.conflicts
      .filter((entry) => entry.market_key === key &&
        entry.field === context.hypothesis_candidate.changed_variable)
      .map(({ field: _field, market_key: _marketKey, ...entry }) => entry);
    return {
      ...candidate,
      market_mechanic_key: key,
      novelty_status: novelty,
      market_reference_ids: marketReferenceIds,
      market_dna_ids: marketDnaIds,
      own_lesson_ids: ownLessonIds,
      avoided_lesson_ids: avoidedLessonIds,
      own_experiment_ids: ownExperiments,
      owner_preference_ids: ownerPreferenceIds,
      evidence_roots: {
        MARKET_REFERENCE: {
          market_reference_ids: marketReferenceIds,
          market_dna_ids: marketDnaIds,
          mechanics: market ? market.mechanics.map(({ field, value, confidence, limitations }) =>
            ({ field, value, confidence, limitations })) : [],
        },
        OWN_PERFORMANCE: { lesson_ids: ownLessonIds, experiment_ids: ownExperiments },
        OWNER_PREFERENCE: {
          approved_idea_ids: approved,
          rejected_idea_ids: rejected,
          market_disposition_reference_ids: marketDispositionIds,
          market_avoidance_reference_ids: marketAvoidanceIds,
          market_avoidance: (context.OWNER_PREFERENCE.MARKET_AVOIDANCE ?? [])
            .flatMap((entry) => entry.mechanics).map(({ field, value }) => ({ field, value })),
        },
      },
      evidence_conflicts: relevantConflicts,
      idea_confidence: relevantConflicts.some((entry) => entry.confidence === "LOW")
        ? "LOW" : (context.base_context.outcome === "HYPOTHESIS" ? ownStrength(context.base_context) : "LOW"),
      evidence_mode: context.base_context.outcome === "HYPOTHESIS"
        ? "OWN_PERFORMANCE_BOUND" : "MARKET_REFERENCE_ONLY",
      market_context_hash: context.context_hash,
    };
  });
  if (![...counts.keys()].some((key) => key !== "NONE")) throw new Error("market_candidate_required");
  return result;
}
