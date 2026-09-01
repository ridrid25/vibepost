export const LESSON_EFFECTIVE_POLICY_VERSION = "LESSON_EFFECTIVE_WEIGHT_V1";

export const LESSON_EFFECTIVE_POLICY = Object.freeze({
  policy_version: LESSON_EFFECTIVE_POLICY_VERSION,
  freshness_seconds: Object.freeze({
    FRESH: 30 * 24 * 60 * 60,
    AGING: 90 * 24 * 60 * 60,
    STALE: 180 * 24 * 60 * 60,
  }),
});

export const LESSON_MATERIAL_SCHEMAS = Object.freeze({
  tiktok_v1: Object.freeze([
    "topic", "content_format", "duration_bin", "character_id", "visual_style_id",
    "hook_type", "pacing_profile", "punch_type", "loop_type", "camera_profile",
    "prompt_framework_version",
  ]),
  youtube_v1: Object.freeze([
    "causal_pattern_class", "payoff_class", "prompt_framework_version",
    "fidelity_constraints_hash",
  ]),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATIVE_ID = /^creative-[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;
const PLATFORMS = new Set(["tiktok", "youtube_shorts"]);
const POSITIVE_CATEGORIES = new Set(["CONFIRMED_LESSON", "WINNING_PATTERN"]);
const STRENGTH_ORDER = Object.freeze({
  UNKNOWN: 0, CONFLICTED: 1, WEAK: 2, LOW: 3, MEDIUM: 4, HIGH: 5, VERY_HIGH: 6,
});
const CONTEXT_ORDER = Object.freeze({
  CONFLICTING: 0, UNKNOWN: 1, WEAK: 2, COMPATIBLE: 3, EXACT: 4,
});
const FRESHNESS_ORDER = Object.freeze({
  UNKNOWN: 0, VERY_STALE: 1, STALE: 2, AGING: 3, FRESH: 4,
});
const INDEPENDENCE_ORDER = Object.freeze({ UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 });
const STATUS_ORDER = Object.freeze({ HYPOTHESIS: 0, REJECTED: 1, SUPPORTED: 2, CONFIRMED: 3 });
const CONTRADICTION_ORDER = Object.freeze({
  NO_CONTRADICTION: 0,
  INSUFFICIENT_EVIDENCE: 1,
  WEAK_CONTRADICTION: 2,
  CONTEXTUAL_CONTRADICTION: 3,
  PLATFORM_CONTRADICTION: 4,
  DIRECT_CONTRADICTION: 5,
});
const LEVELS = Object.freeze(["WEAK", "LOW", "MEDIUM", "HIGH", "VERY_HIGH"]);

export class LessonEffectiveWeightError extends Error {
  constructor(message, code = "LESSON_EFFECTIVE_WEIGHT_INVALID") {
    super(message);
    this.name = "LessonEffectiveWeightError";
    this.code = code;
  }
}

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256HexSync(text) {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const constants = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const words = new Uint32Array(64);
  const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + constants[index] + words[index]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    hash[0]=(hash[0]+a)>>>0; hash[1]=(hash[1]+b)>>>0; hash[2]=(hash[2]+c)>>>0;
    hash[3]=(hash[3]+d)>>>0; hash[4]=(hash[4]+e)>>>0; hash[5]=(hash[5]+f)>>>0;
    hash[6]=(hash[6]+g)>>>0; hash[7]=(hash[7]+h)>>>0;
  }
  return hash.map((value) => value.toString(16).padStart(8, "0")).join("");
}

function validRfc3339(value) {
  if (typeof value !== "string") return false;
  const match = RFC3339.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value));
}

function parseEvaluationAt(value) {
  if (!validRfc3339(value)) {
    throw new LessonEffectiveWeightError("evaluation_at must be exact RFC3339", "LESSON_EVALUATION_AT_INVALID");
  }
  return Date.parse(value);
}

function validMaterialValue(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    value.normalize("NFC") === value && !CONTROL.test(value) &&
    value === value.replace(/^ +| +$/gu, "");
}

function knownMaterialValue(value) {
  return validMaterialValue(value) && value !== "UNKNOWN";
}

function sortedIds(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && UUID.test(value)))].sort();
}

function linkedExperimentIds(lesson, bindings) {
  const ids = (Array.isArray(lesson?.evidence) ? lesson.evidence : [])
    .map((entry) => record(entry) ? entry.experiment_id : null);
  for (const binding of bindings ?? []) {
    if (binding?.lesson_id === lesson?.id) ids.push(binding.experiment_id);
  }
  return sortedIds(ids);
}

function authoritativeAnalyses(rows, evaluationMs) {
  const grouped = new Map();
  for (const row of rows ?? []) {
    if (!UUID.test(String(row?.experiment_id ?? ""))) continue;
    const group = grouped.get(row.experiment_id) ?? [];
    group.push(row);
    grouped.set(row.experiment_id, group);
  }
  const latest = new Map();
  const invalid = new Set();
  for (const [experimentId, group] of grouped) {
    if (group.some((row) => !validRfc3339(row.created_at) || Date.parse(row.created_at) > evaluationMs)) {
      invalid.add(experimentId);
      continue;
    }
    const sorted = [...group].sort((left, right) =>
      Date.parse(right.created_at) - Date.parse(left.created_at) ||
      String(left.id).localeCompare(String(right.id)));
    latest.set(experimentId, { row: sorted[0], at_ms: Date.parse(sorted[0].created_at) });
  }
  return { latest, invalid };
}

function proofForExperiment(experiment, mutationById) {
  if (!record(experiment) || !UUID.test(String(experiment.creative_mutation_id ?? ""))) return null;
  const schema = experiment.lineage_material_schema;
  const fields = LESSON_MATERIAL_SCHEMAS[schema];
  const changed = experiment.changed_variable;
  const parent = experiment.lineage_parent_material_vector;
  const child = experiment.lineage_child_material_vector;
  const constants = experiment.lineage_constants_snapshot;
  const materialDiff = experiment.lineage_material_diff;
  const mutation = mutationById.get(experiment.creative_mutation_id);
  if (!fields || !fields.includes(changed) || !record(parent) || !record(child) || !record(constants) ||
      !record(materialDiff) || !mutation || mutation.changed_variable !== changed ||
      mutation.mutation_kind !== "CONTROLLED_MUTATION" ||
      !UUID.test(String(mutation.source_hypothesis_id ?? "")) ||
      mutation.source_hypothesis_id !== experiment.hypothesis_id ||
      mutation.prior_evidence_experiment_id === experiment.id ||
      !HEX64.test(String(experiment.lineage_contract_hash ?? ""))) return null;
  const platform = experiment.platform;
  if (!PLATFORMS.has(platform) ||
      (platform === "tiktok" && schema !== "tiktok_v1") ||
      (platform === "youtube_shorts" && schema !== "youtube_v1")) return null;
  if (platform === "youtube_shorts" &&
      (mutation.child_creative_id !== experiment.variant_creative_id ||
        (mutation.parent_creative_id ?? null) !== (experiment.control_creative_id ?? null))) return null;
  if (canonicalJson(Object.keys(parent).sort()) !== canonicalJson([...fields].sort()) ||
      canonicalJson(Object.keys(child).sort()) !== canonicalJson([...fields].sort()) ||
      !fields.every((field) => validMaterialValue(parent[field]) && validMaterialValue(child[field]))) return null;
  const changedFields = [];
  const unchangedFields = [];
  const unknownFields = [];
  for (const field of fields) {
    if (parent[field] === "UNKNOWN" || child[field] === "UNKNOWN") unknownFields.push(field);
    else if (parent[field] === child[field]) unchangedFields.push(field);
    else changedFields.push(field);
  }
  const expectedDiff = {
    schema_version: 1,
    changed_material_variables: changedFields,
    unchanged_material_variables: unchangedFields,
    unknown_comparisons: unknownFields,
    limitations: unknownFields.length ? ["unknown_material_comparisons"] : [],
  };
  const expectedConstants = Object.fromEntries(fields.filter((field) => field !== changed)
    .map((field) => [field, parent[field]]));
  if (changedFields.length !== 1 || changedFields[0] !== changed || unknownFields.length !== 0 ||
      canonicalJson(materialDiff) !== canonicalJson(expectedDiff) ||
      canonicalJson(constants) !== canonicalJson(expectedConstants) ||
      canonicalJson(experiment.constants) !== canonicalJson(expectedConstants) ||
      !knownMaterialValue(parent[changed]) || !knownMaterialValue(child[changed]) ||
      parent[changed] === child[changed]) return null;
  const proofContract = { material_schema: schema, parent_material_vector: parent,
    child_material_vector: child, constants_snapshot: constants, material_diff: expectedDiff };
  if (sha256HexSync(canonicalJson(proofContract)) !== experiment.lineage_contract_hash) return null;
  return {
    experiment_id: experiment.id,
    creative_mutation_id: experiment.creative_mutation_id,
    platform,
    schema,
    changed_variable: changed,
    parent_vector: parent,
    child_vector: child,
    constants,
    transition_fingerprint: canonicalJson({
      changed_variable: changed,
      parent_value: parent[changed],
      child_value: child[changed],
    }),
    fingerprint: canonicalJson({
      platform,
      lineage_material_schema: schema,
      changed_variable: changed,
      parent_value: parent[changed],
      child_value: child[changed],
    }),
  };
}

function rootForProof(proof, mutationById, mutationByChild) {
  let mutation = mutationById.get(proof?.creative_mutation_id);
  if (!mutation || !CREATIVE_ID.test(String(mutation.child_creative_id ?? ""))) return null;
  const seen = new Set();
  let root = mutation.child_creative_id;
  for (let depth = 0; depth < 128; depth += 1) {
    if (seen.has(mutation.child_creative_id)) return null;
    seen.add(mutation.child_creative_id);
    if (!mutation.parent_creative_id) return root;
    if (!CREATIVE_ID.test(mutation.parent_creative_id)) return null;
    root = mutation.parent_creative_id;
    const parent = mutationByChild.get(root);
    if (!parent) return root;
    mutation = parent;
  }
  return null;
}

function contextComparison(currentContext, proof) {
  if (!record(currentContext) || !proof) return "UNKNOWN";
  const fields = LESSON_MATERIAL_SCHEMAS[proof.schema].filter((field) => field !== proof.changed_variable);
  let compared = 0;
  let equal = 0;
  let mismatched = 0;
  let known = 0;
  for (const field of fields) {
    const evidenceValue = proof.child_vector[field];
    if (!knownMaterialValue(evidenceValue)) continue;
    known += 1;
    const requested = currentContext[field];
    if (!knownMaterialValue(requested)) continue;
    compared += 1;
    if (requested === evidenceValue) equal += 1;
    else mismatched += 1;
  }
  if (compared === 0) return "UNKNOWN";
  if (mismatched === 0) return compared === known ? "EXACT" : "COMPATIBLE";
  if (mismatched === 1 && equal >= 1) return "WEAK";
  return "CONFLICTING";
}

function proofContextComparison(left, right) {
  if (!left || !right) return "UNKNOWN";
  const leftFields = new Set(LESSON_MATERIAL_SCHEMAS[left.schema] ?? []);
  const fields = (LESSON_MATERIAL_SCHEMAS[right.schema] ?? [])
    .filter((field) => leftFields.has(field) && field !== left.changed_variable && field !== right.changed_variable);
  let compared = 0;
  let equal = 0;
  let mismatched = 0;
  let known = 0;
  for (const field of fields) {
    const leftValue = left.child_vector[field];
    const rightValue = right.child_vector[field];
    if (!knownMaterialValue(leftValue) || !knownMaterialValue(rightValue)) continue;
    known += 1;
    compared += 1;
    if (leftValue === rightValue) equal += 1;
    else mismatched += 1;
  }
  if (compared === 0) return "UNKNOWN";
  if (mismatched === 0) return compared === known ? "EXACT" : "COMPATIBLE";
  if (mismatched === 1 && equal >= 1) return "WEAK";
  return "CONFLICTING";
}

function crossPlatformMatch(left, right) {
  if (!left || !right || left.platform === right.platform ||
      left.transition_fingerprint !== right.transition_fingerprint ||
      left.changed_variable !== right.changed_variable) return false;
  return (LESSON_MATERIAL_SCHEMAS[left.schema] ?? []).includes(left.changed_variable) &&
    (LESSON_MATERIAL_SCHEMAS[right.schema] ?? []).includes(right.changed_variable);
}

function expectedConclusion(lesson) {
  if (lesson?.status === "REJECTED" && lesson?.category === "FAILED_PATTERN") return "FAIL";
  if (["CONFIRMED", "SUPPORTED", "HYPOTHESIS"].includes(lesson?.status) &&
      (POSITIVE_CATEGORIES.has(lesson?.category) || lesson?.category === "HYPOTHESIS")) return "PASS";
  return null;
}

function freshnessBucket(lastSupportMs, evaluationMs) {
  if (!Number.isFinite(lastSupportMs)) return "UNKNOWN";
  const age = Math.floor((evaluationMs - lastSupportMs) / 1000);
  if (age < 0) return "UNKNOWN";
  if (age <= LESSON_EFFECTIVE_POLICY.freshness_seconds.FRESH) return "FRESH";
  if (age <= LESSON_EFFECTIVE_POLICY.freshness_seconds.AGING) return "AGING";
  if (age <= LESSON_EFFECTIVE_POLICY.freshness_seconds.STALE) return "STALE";
  return "VERY_STALE";
}

function independenceBucket(count) {
  if (count >= 3) return "HIGH";
  if (count === 2) return "MEDIUM";
  if (count === 1) return "LOW";
  return "UNKNOWN";
}

function lowerLevel(value, steps) {
  const index = LEVELS.indexOf(value);
  return index < 0 ? "UNKNOWN" : LEVELS[Math.max(0, index - steps)];
}

function capLevel(value, cap) {
  const index = LEVELS.indexOf(value);
  const capIndex = LEVELS.indexOf(cap);
  return index < 0 || capIndex < 0 ? "UNKNOWN" : LEVELS[Math.min(index, capIndex)];
}

function platformScope(platforms) {
  if (platforms.has("tiktok") && platforms.has("youtube_shorts")) return "CROSS_PLATFORM";
  if (platforms.has("tiktok")) return "TIKTOK_ONLY";
  if (platforms.has("youtube_shorts")) return "YOUTUBE_ONLY";
  return "UNKNOWN";
}

function experimentEntry(experiment, analysisEntry, proof, root, matchKind, referenceProof) {
  return {
    experiment,
    analysis: analysisEntry.row,
    at_ms: analysisEntry.at_ms,
    proof,
    root,
    match_kind: matchKind,
    reference_proof: referenceProof,
  };
}

function classifyContradiction(entry) {
  if (entry.analysis.conclusion === "INCONCLUSIVE") return "INSUFFICIENT_EVIDENCE";
  const comparison = proofContextComparison(entry.reference_proof, entry.proof);
  if (entry.analysis.confidence === "LOW" || !entry.root) {
    return "WEAK_CONTRADICTION";
  }
  if (entry.match_kind === "CROSS_PLATFORM") {
    return ["WEAK", "CONFLICTING"].includes(comparison)
      ? "WEAK_CONTRADICTION" : "PLATFORM_CONTRADICTION";
  }
  if (comparison === "UNKNOWN") return "WEAK_CONTRADICTION";
  if (["EXACT", "COMPATIBLE"].includes(comparison)) return "DIRECT_CONTRADICTION";
  return "CONTEXTUAL_CONTRADICTION";
}

function contradictionState(entries) {
  let selected = "NO_CONTRADICTION";
  for (const entry of entries) {
    const value = classifyContradiction(entry);
    if (CONTRADICTION_ORDER[value] > CONTRADICTION_ORDER[selected]) selected = value;
  }
  return selected;
}

function effectiveStrength({ lesson, sameDirectionRoots, freshness, contextMatch, contradiction, hasSupport }) {
  if (!hasSupport) return "UNKNOWN";
  const base = { CONFIRMED: "HIGH", SUPPORTED: "MEDIUM", REJECTED: "HIGH", HYPOTHESIS: "LOW" }[lesson.status];
  if (!base) return "UNKNOWN";
  let value = base;
  if (sameDirectionRoots >= 3) value = LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(value) + 1)];
  else if (sameDirectionRoots === 1) value = capLevel(value, "MEDIUM");
  else if (sameDirectionRoots === 0) value = capLevel(value, "LOW");
  value = freshness === "FRESH" ? value
    : freshness === "AGING" ? lowerLevel(value, 1)
      : freshness === "STALE" ? lowerLevel(value, 2)
        : freshness === "VERY_STALE" ? lowerLevel(value, 3)
          : capLevel(value, "WEAK");
  if (lesson.status === "REJECTED" && freshness === "VERY_STALE") value = capLevel(value, "WEAK");
  if (["WEAK", "UNKNOWN"].includes(contextMatch)) value = capLevel(value, "LOW");
  if (contextMatch === "CONFLICTING") value = capLevel(value, "WEAK");
  if (contradiction === "DIRECT_CONTRADICTION") return "CONFLICTED";
  if (contradiction === "PLATFORM_CONTRADICTION") value = capLevel(value, "MEDIUM");
  if (["CONTEXTUAL_CONTRADICTION", "WEAK_CONTRADICTION"].includes(contradiction)) {
    value = capLevel(value, "LOW");
  }
  return value;
}

function controlledRetest({ lesson, targetPlatform, strength, freshness, sameDirection, opposing, limitations }) {
  const eligible = strength === "CONFLICTED" ||
    (["CONFIRMED", "REJECTED"].includes(lesson.status) && ["STALE", "VERY_STALE"].includes(freshness));
  if (!eligible) return null;
  const complete = sameDirection.filter((entry) => entry.proof && entry.experiment.platform === targetPlatform);
  const variables = [...new Set(complete.map((entry) => entry.proof.changed_variable))];
  if (complete.length === 0) {
    limitations.push("CONTROLLED_RETEST_PROOF_INCOMPLETE");
    return null;
  }
  if (variables.length !== 1) {
    limitations.push("CONTROLLED_RETEST_MULTIPLE_VARIABLES");
    return null;
  }
  const representative = [...complete].sort((left, right) =>
    right.at_ms - left.at_ms || String(left.experiment.id).localeCompare(String(right.experiment.id)))[0];
  return {
    action: "CONTROLLED_RETEST",
    target_platform: targetPlatform,
    source_lesson_id: lesson.id,
    changed_variable: variables[0],
    constants: representative.proof.constants,
    supporting_experiment_ids: sortedIds(sameDirection.map((entry) => entry.experiment.id)),
    contradictory_experiment_ids: sortedIds(opposing.filter((entry) =>
      entry.analysis.conclusion !== "INCONCLUSIVE").map((entry) => entry.experiment.id)),
    retest_reason: strength === "CONFLICTED" ? "CURRENT_EVIDENCE_CONFLICTED" : `HISTORICAL_${freshness}`,
    policy_version: LESSON_EFFECTIVE_POLICY_VERSION,
    limitations: [...new Set(limitations)].sort(),
  };
}

function stateForMechanism({ lesson, sourcePlatform, targetPlatform, currentContext, evaluationAt,
  evaluationMs, expected, opposite, referenceProof, matched, limitations }) {
  const sameDirectionAll = matched.filter((entry) => entry.analysis.conclusion === expected);
  const sameDirection = sameDirectionAll.filter((entry) => entry.experiment.platform === targetPlatform);
  const opposing = matched.filter((entry) =>
    entry.analysis.conclusion === opposite || entry.analysis.conclusion === "INCONCLUSIVE");
  const passRoots = new Set(matched.filter((entry) => entry.experiment.platform === targetPlatform &&
      entry.analysis.conclusion === "PASS" && entry.root).map((entry) => entry.root));
  const failRoots = new Set(matched.filter((entry) => entry.experiment.platform === targetPlatform &&
      entry.analysis.conclusion === "FAIL" && entry.root).map((entry) => entry.root));
  const sameDirectionRoots = expected === "PASS" ? passRoots.size : expected === "FAIL" ? failRoots.size : 0;
  const lineageIndependence = independenceBucket(sameDirectionRoots);
  const contextRows = sameDirection.filter((entry) => entry.proof).map((entry) => ({
    value: contextComparison(currentContext, entry.proof), entry,
  })).sort((left, right) =>
    (CONTEXT_ORDER[right.value] ?? -1) - (CONTEXT_ORDER[left.value] ?? -1) ||
    right.entry.at_ms - left.entry.at_ms ||
    String(left.entry.experiment.id).localeCompare(String(right.entry.experiment.id)));
  const contextMatch = contextRows[0]?.value ?? "UNKNOWN";
  for (const row of contextRows.slice(1)) {
    if (row.value !== contextMatch) limitations.push(`LOWER_CONTEXT_MATCH:${row.entry.experiment.id}:${row.value}`);
  }
  for (const entry of matched.filter((item) => item.match_kind === "CROSS_PLATFORM")) {
    if (proofContextComparison(entry.reference_proof, entry.proof) === "UNKNOWN") {
      limitations.push("CROSS_PLATFORM_NO_SHARED_CONTEXT");
    }
  }
  const lastSupportMs = sameDirection.length ? Math.max(...sameDirection.map((entry) => entry.at_ms)) : NaN;
  const conclusiveOpposing = opposing.filter((entry) => entry.analysis.conclusion === opposite);
  const lastContradictedMs = conclusiveOpposing.length
    ? Math.max(...conclusiveOpposing.map((entry) => entry.at_ms)) : NaN;
  const freshness = freshnessBucket(lastSupportMs, evaluationMs);
  const contradiction = contradictionState(opposing);
  const strength = expected && referenceProof
    ? effectiveStrength({ lesson, sameDirectionRoots, freshness, contextMatch,
      contradiction, hasSupport: sameDirection.length > 0 })
    : "UNKNOWN";
  const supportPlatforms = new Set(sameDirectionAll.filter((entry) => entry.proof && entry.root)
    .map((entry) => entry.experiment.platform));
  const scope = platformScope(supportPlatforms);
  const ageSeconds = Number.isFinite(lastSupportMs) ? Math.floor((evaluationMs - lastSupportMs) / 1000) : "UNKNOWN";
  const recentContradictions = conclusiveOpposing.filter((entry) =>
    evaluationMs - entry.at_ms <= LESSON_EFFECTIVE_POLICY.freshness_seconds.AGING * 1000).length;
  const canonicalStatus = lesson.status ?? "UNKNOWN";
  const reasons = [`POLICY_${LESSON_EFFECTIVE_POLICY_VERSION}`, `CANONICAL_${canonicalStatus}`,
    `INDEPENDENCE_${lineageIndependence}`, `FRESHNESS_${freshness}`,
    `CONTEXT_${contextMatch}`, `CONTRADICTION_${contradiction}`, `EFFECTIVE_${strength}`];
  const positive = POSITIVE_CATEGORIES.has(lesson.category) && ["CONFIRMED", "SUPPORTED"].includes(canonicalStatus);
  const avoidance = lesson.category === "FAILED_PATTERN" && canonicalStatus === "REJECTED";
  const active = (STRENGTH_ORDER[strength] ?? 0) >= STRENGTH_ORDER.LOW &&
    contextMatch !== "CONFLICTING" && contradiction !== "DIRECT_CONTRADICTION" &&
    sourcePlatform === targetPlatform;
  const selectionRole = active && positive ? "POSITIVE" : active && avoidance ? "AVOIDANCE" : "INACTIVE";
  const retest = controlledRetest({ lesson, targetPlatform, strength, freshness,
    sameDirection, opposing, limitations });
  return {
    lesson_id: lesson.id,
    canonical_status: canonicalStatus,
    source_platform: sourcePlatform,
    platform_scope: scope,
    effective_strength: strength,
    freshness_bucket: freshness,
    age_since_last_support_seconds: ageSeconds,
    independent_confirmation_count: passRoots.size,
    independent_failure_count: failRoots.size,
    lineage_independence: lineageIndependence,
    context_match: contextMatch,
    contradiction_state: contradiction,
    recent_contradiction_count: recentContradictions,
    supporting_experiment_ids: sortedIds(sameDirection.map((entry) => entry.experiment.id)),
    supporting_evidence: [...sameDirection].sort((left, right) =>
      String(left.experiment.id).localeCompare(String(right.experiment.id))).map((entry) => ({
      experiment_id: entry.experiment.id,
      analysis_id: entry.analysis.id,
      conclusion: entry.analysis.conclusion,
      platform: entry.experiment.platform,
      evidence_at: entry.analysis.created_at,
    })),
    cross_platform_supporting_experiment_ids: sortedIds(sameDirectionAll
      .filter((entry) => entry.experiment.platform !== targetPlatform)
      .map((entry) => entry.experiment.id)),
    contradictory_experiment_ids: sortedIds(conclusiveOpposing.map((entry) => entry.experiment.id)),
    contradictory_evidence: [...conclusiveOpposing].sort((left, right) =>
      String(left.experiment.id).localeCompare(String(right.experiment.id))).map((entry) => ({
      experiment_id: entry.experiment.id,
      analysis_id: entry.analysis.id,
      conclusion: entry.analysis.conclusion,
      platform: entry.experiment.platform,
      evidence_at: entry.analysis.created_at,
    })),
    last_supported_at: Number.isFinite(lastSupportMs)
      ? sameDirection.find((entry) => entry.at_ms === lastSupportMs).analysis.created_at : "UNKNOWN",
    last_contradicted_at: Number.isFinite(lastContradictedMs)
      ? conclusiveOpposing.find((entry) => entry.at_ms === lastContradictedMs).analysis.created_at : "UNKNOWN",
    evidence_diversity: {
      platforms: [...supportPlatforms].sort(), independent_roots: sameDirectionRoots,
      matched_experiments: matched.length,
    },
    mechanism_fingerprint: referenceProof?.fingerprint ?? "UNKNOWN",
    policy_version: LESSON_EFFECTIVE_POLICY_VERSION,
    evaluation_at: evaluationAt,
    selection_role: selectionRole,
    controlled_retest: retest,
    reasons,
    limitations: [...new Set(limitations)].sort(),
  };
}

export function evaluateLessonEffectiveStrength({
  lesson, experiments = [], analyses = [], mutations = [], lesson_bindings = [],
  target_platform, current_context = {}, evaluation_at,
}) {
  const evaluationMs = parseEvaluationAt(evaluation_at);
  if (!record(lesson) || !UUID.test(String(lesson.id ?? "")) || !PLATFORMS.has(target_platform)) {
    throw new LessonEffectiveWeightError("lesson and target platform required");
  }
  const expected = expectedConclusion(lesson);
  const opposite = expected === "PASS" ? "FAIL" : expected === "FAIL" ? "PASS" : null;
  const sourcePlatform = PLATFORMS.has(lesson.source_platform) ? lesson.source_platform : "UNKNOWN";
  const baseLimitations = [];
  if (sourcePlatform === "UNKNOWN") baseLimitations.push("LESSON_SOURCE_PLATFORM_INVALID");
  if (!expected) baseLimitations.push("LESSON_CANONICAL_CONTRACT_INVALID");
  const linkedIds = new Set(linkedExperimentIds(lesson, lesson_bindings));
  if (linkedIds.size === 0) baseLimitations.push("LESSON_EVIDENCE_MISSING");
  const experimentById = new Map(experiments.filter((row) => UUID.test(String(row?.id ?? "")))
    .map((row) => [row.id, row]));
  const mutationById = new Map(mutations.filter((row) => UUID.test(String(row?.id ?? "")))
    .map((row) => [row.id, row]));
  const mutationByChild = new Map(mutations.filter((row) => CREATIVE_ID.test(String(row?.child_creative_id ?? "")))
    .map((row) => [row.child_creative_id, row]));
  const { latest, invalid } = authoritativeAnalyses(analyses, evaluationMs);
  const proofByExperiment = new Map();
  const rootByExperiment = new Map();
  for (const experiment of experimentById.values()) {
    const proof = proofForExperiment(experiment, mutationById);
    if (!proof) {
      if (linkedIds.has(experiment.id)) baseLimitations.push(`INCOMPLETE_LINEAGE_PROOF:${experiment.id}`);
      continue;
    }
    proofByExperiment.set(experiment.id, proof);
    const root = rootForProof(proof, mutationById, mutationByChild);
    if (root) rootByExperiment.set(experiment.id, root);
    else if (linkedIds.has(experiment.id)) baseLimitations.push(`LINEAGE_UNKNOWN:${experiment.id}`);
  }
  const linkedTargetProofs = [...linkedIds].map((id) => ({
    experiment: experimentById.get(id), proof: proofByExperiment.get(id),
  })).filter(({ experiment, proof }) => proof && experiment?.platform === target_platform &&
    sourcePlatform === target_platform);
  const references = [...new Map(linkedTargetProofs.map(({ proof }) => [proof.fingerprint, proof])).values()]
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  if (references.length === 0) baseLimitations.push("LEGACY_UNLINKED_OR_INCOMPLETE_LINEAGE");

  const states = [];
  for (const referenceProof of references) {
    const limitations = [...baseLimitations];
    const matched = [];
    for (const experiment of experimentById.values()) {
      const proof = proofByExperiment.get(experiment.id) ?? null;
      let matchKind = null;
      if (proof?.fingerprint === referenceProof.fingerprint) matchKind = "SAME_PLATFORM";
      else if (crossPlatformMatch(referenceProof, proof)) matchKind = "CROSS_PLATFORM";
      if (!matchKind) continue;
      if (invalid.has(experiment.id)) {
        limitations.push(`INVALID_OR_FUTURE_ANALYSIS:${experiment.id}`);
        continue;
      }
      const analysisEntry = latest.get(experiment.id);
      if (!analysisEntry) {
        limitations.push(`AUTHORITATIVE_ANALYSIS_MISSING:${experiment.id}`);
        continue;
      }
      if (analysisEntry.row.platform !== experiment.platform ||
          (experiment.result && ["PASS", "FAIL", "INCONCLUSIVE"].includes(experiment.result) &&
            experiment.result !== analysisEntry.row.conclusion)) {
        limitations.push(`RESULT_ANALYSIS_MISMATCH:${experiment.id}`);
        continue;
      }
      matched.push(experimentEntry(experiment, analysisEntry, proof,
        rootByExperiment.get(experiment.id) ?? null, matchKind, referenceProof));
    }
    states.push(stateForMechanism({ lesson, sourcePlatform, targetPlatform: target_platform,
      currentContext: current_context, evaluationAt: evaluation_at, evaluationMs, expected, opposite,
      referenceProof, matched, limitations }));
  }

  if (states.length === 0) {
    for (const id of linkedIds) {
      if (invalid.has(id)) baseLimitations.push(`INVALID_OR_FUTURE_ANALYSIS:${id}`);
    }
    return stateForMechanism({ lesson, sourcePlatform, targetPlatform: target_platform,
      currentContext: current_context, evaluationAt: evaluation_at, evaluationMs, expected, opposite,
      referenceProof: null, matched: [], limitations: baseLimitations });
  }
  const changedVariables = new Set(references.map((proof) => proof.changed_variable));
  if (states.length > 1) {
    for (const state of states) state.limitations.push(`MULTIPLE_LESSON_MECHANISMS:${states.length}`);
  }
  if (changedVariables.size > 1) {
    for (const state of states) state.limitations.push("MULTIPLE_CHANGED_VARIABLES");
  }
  states.sort((left, right) => compareLessonEffectiveStates(left, right) ||
    left.mechanism_fingerprint.localeCompare(right.mechanism_fingerprint));
  const selected = states[0];
  selected.limitations = [...new Set(selected.limitations)].sort();
  return selected;
}

export function compareLessonEffectiveStates(left, right) {
  return (STRENGTH_ORDER[right.effective_strength] ?? -1) -
      (STRENGTH_ORDER[left.effective_strength] ?? -1) ||
    (CONTEXT_ORDER[right.context_match] ?? -1) - (CONTEXT_ORDER[left.context_match] ?? -1) ||
    (FRESHNESS_ORDER[right.freshness_bucket] ?? -1) -
      (FRESHNESS_ORDER[left.freshness_bucket] ?? -1) ||
    (INDEPENDENCE_ORDER[right.lineage_independence] ?? -1) -
      (INDEPENDENCE_ORDER[left.lineage_independence] ?? -1) ||
    (STATUS_ORDER[right.canonical_status] ?? -1) - (STATUS_ORDER[left.canonical_status] ?? -1) ||
    String(right.last_supported_at ?? "").localeCompare(String(left.last_supported_at ?? "")) ||
    String(left.lesson_id).localeCompare(String(right.lesson_id));
}

export function evaluateLessonsForFeedback(input) {
  const states = (input.lessons ?? []).map((lesson) => evaluateLessonEffectiveStrength({ ...input, lesson }));
  return {
    policy_version: LESSON_EFFECTIVE_POLICY_VERSION,
    evaluation_at: input.evaluation_at,
    states: states.sort((left, right) => String(left.lesson_id).localeCompare(String(right.lesson_id))),
    positive: states.filter((state) => state.selection_role === "POSITIVE").sort(compareLessonEffectiveStates),
    avoidance: states.filter((state) => state.selection_role === "AVOIDANCE").sort(compareLessonEffectiveStates),
    controlled_retests: states.filter((state) => state.controlled_retest)
      .sort(compareLessonEffectiveStates).map((state) => state.controlled_retest),
  };
}

export function resolveStoredLessonDecision({ ideas = [], hypotheses = [], platform, batch_key }) {
  if (!PLATFORMS.has(platform) || !HEX64.test(String(batch_key ?? "")) || !Array.isArray(ideas) ||
      ideas.length === 0) throw new LessonEffectiveWeightError("stored decision identity invalid",
    "LESSON_STORED_DECISION_INVALID");
  const batchField = platform === "tiktok" ? "feedback_batch_key" : "youtube_feedback_batch_key";
  const hashField = platform === "tiktok" ? "feedback_context_hash" : "youtube_feedback_context_hash";
  const rows = [...ideas].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  if (rows.some((row) => row?.[batchField] !== batch_key || row?.target_platform !== platform)) {
    throw new LessonEffectiveWeightError("stored decision batch conflict", "LESSON_STORED_DECISION_CONFLICT");
  }
  const contextHashes = [...new Set(rows.map((row) => row[hashField]))];
  if (contextHashes.length !== 1 || !HEX64.test(String(contextHashes[0] ?? ""))) {
    throw new LessonEffectiveWeightError("stored decision pointers conflict", "LESSON_STORED_DECISION_CONFLICT");
  }
  const ownRows = platform === "youtube_shorts"
    ? rows.filter((row) => row.evidence_mode === "OWN_PERFORMANCE_BOUND" || row.hypothesis_id !== null)
    : rows;
  const marketOnlyRows = platform === "youtube_shorts" ? rows.filter((row) => !ownRows.includes(row)) : [];
  if (marketOnlyRows.some((row) => row.hypothesis_id !== null ||
      (row.evidence_mode !== null && row.evidence_mode !== "MARKET_REFERENCE_ONLY"))) {
    throw new LessonEffectiveWeightError("stored market-only row invalid", "LESSON_STORED_DECISION_CONFLICT");
  }
  if (ownRows.length === 0) return {
    batch_key,
    hypothesis_id: null,
    feedback_context_hash: contextHashes[0],
    selected_lesson_ids: [],
    avoided_lesson_ids: [],
    feedback_context: null,
    lesson_effective_policy_version: "NO_EFFECTIVE_SNAPSHOT",
    evaluation_at: "UNKNOWN",
    limitations: ["MARKET_REFERENCE_ONLY_REPLAY"],
  };
  const hypothesisIds = [...new Set(ownRows.map((row) => row.hypothesis_id))];
  const selectedPointers = [...new Set(ownRows.map((row) => canonicalJson(row.selected_lesson_ids ?? [])))];
  const avoidedPointers = [...new Set(ownRows.map((row) => canonicalJson(row.avoided_lesson_ids ?? [])))];
  if (hypothesisIds.length !== 1 || !UUID.test(String(hypothesisIds[0] ?? "")) ||
      selectedPointers.length !== 1 || avoidedPointers.length !== 1) {
    throw new LessonEffectiveWeightError("stored decision pointers conflict", "LESSON_STORED_DECISION_CONFLICT");
  }
  const hypothesis = hypotheses.find((row) => row?.id === hypothesisIds[0]);
  if (!hypothesis || !record(hypothesis.feedback_context)) {
    throw new LessonEffectiveWeightError("stored decision snapshot missing", "LESSON_STORED_SNAPSHOT_MISSING");
  }
  const effectiveRoot = hypothesis.feedback_context.OWN_PERFORMANCE;
  const policyVersion = record(effectiveRoot) &&
      effectiveRoot.lesson_effective_policy_version === LESSON_EFFECTIVE_POLICY_VERSION
    ? LESSON_EFFECTIVE_POLICY_VERSION : "LEGACY_UNKNOWN";
  return {
    batch_key,
    hypothesis_id: hypothesisIds[0],
    feedback_context_hash: contextHashes[0],
    selected_lesson_ids: JSON.parse(selectedPointers[0]),
    avoided_lesson_ids: JSON.parse(avoidedPointers[0]),
    feedback_context: hypothesis.feedback_context,
    lesson_effective_policy_version: policyVersion,
    evaluation_at: policyVersion === LESSON_EFFECTIVE_POLICY_VERSION
      ? effectiveRoot.evaluation_at : "UNKNOWN",
    limitations: [
      ...(policyVersion === LESSON_EFFECTIVE_POLICY_VERSION ? [] : ["LEGACY_DECISION_SNAPSHOT"]),
      ...(marketOnlyRows.length ? ["MIXED_MARKET_AND_OWN_REPLAY"] : []),
    ],
  };
}

export {
  canonicalJson as canonicalLessonEffectiveJson,
  validRfc3339 as validLessonEvidenceTimestamp,
  sha256HexSync as lessonProofContractHash,
};
