import { canonicalJson, sha256Hex } from "./tiktok-feedback-context.mjs";

export const MUTATION_KINDS = Object.freeze([
  "NEW_CONCEPT",
  "CONTROLLED_MUTATION",
  "MARKET_INSPIRED_TEST",
  "OWNER_REQUESTED_VARIATION",
  "REWORK",
]);

export const MATERIAL_SCHEMAS = Object.freeze({
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
const CANONICAL_MATERIAL_VARIABLES = new Set(Object.values(MATERIAL_SCHEMAS).flat());

const CREATIVE_ID = /^creative-[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

export class MutationContractError extends Error {
  constructor(message, code = "MUTATION_CONTRACT_VIOLATION") {
    super(message);
    this.name = "MutationContractError";
    this.code = code;
  }
}

function fail(message) {
  throw new MutationContractError(message);
}

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function canonicalMaterialValue(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 &&
    value.normalize("NFC") === value && !CONTROL.test(value) &&
    value === value.replace(/^ +| +$/gu, "");
}

export function validateMaterialVector(schema, vector) {
  const fields = MATERIAL_SCHEMAS[schema];
  if (!fields || !record(vector)) fail("unsupported material schema");
  const keys = Object.keys(vector).sort();
  if (canonicalJson(keys) !== canonicalJson([...fields].sort())) fail("material keys mismatch");
  for (const key of fields) {
    if (!canonicalMaterialValue(vector[key])) fail(`non-canonical material value: ${key}`);
  }
  return Object.fromEntries(fields.map((key) => [key, vector[key]]));
}

export function diffMaterialVectors(schema, parentVector, childVector) {
  const parent = validateMaterialVector(schema, parentVector);
  const child = validateMaterialVector(schema, childVector);
  const changed = [];
  const unchanged = [];
  const unknown = [];
  for (const key of MATERIAL_SCHEMAS[schema]) {
    if (parent[key] === "UNKNOWN" || child[key] === "UNKNOWN") unknown.push(key);
    else if (parent[key] === child[key]) unchanged.push(key);
    else changed.push(key);
  }
  return {
    schema_version: 1,
    changed_material_variables: changed,
    unchanged_material_variables: unchanged,
    unknown_comparisons: unknown,
    limitations: unknown.length ? ["unknown_material_comparisons"] : [],
  };
}

function requiresParent(kind) {
  return ["CONTROLLED_MUTATION", "OWNER_REQUESTED_VARIATION", "REWORK"].includes(kind);
}

export function validateMutationDeclaration(declaration) {
  const value = {
    child_creative_id: declaration?.child_creative_id ?? null,
    parent_creative_id: declaration?.parent_creative_id ?? null,
    mutation_kind: declaration?.mutation_kind ?? null,
    changed_variable: declaration?.changed_variable ?? null,
    mutation_reason: declaration?.mutation_reason ?? null,
    source_hypothesis_id: declaration?.source_hypothesis_id ?? null,
    prior_evidence_experiment_id: declaration?.prior_evidence_experiment_id ?? null,
  };
  if (!CREATIVE_ID.test(value.child_creative_id ?? "")) fail("invalid child creative identity");
  if (!MUTATION_KINDS.includes(value.mutation_kind)) fail("invalid mutation kind");
  if (value.parent_creative_id !== null && !CREATIVE_ID.test(value.parent_creative_id)) {
    fail("parent must be a canonical creative identity");
  }
  if (value.parent_creative_id === value.child_creative_id) fail("self parent forbidden");
  if (requiresParent(value.mutation_kind) && !value.parent_creative_id) fail("parent required");
  if (value.mutation_kind === "NEW_CONCEPT" &&
      (value.parent_creative_id || value.changed_variable)) fail("new concept must be a root");
  if (value.mutation_kind === "CONTROLLED_MUTATION" &&
      (!value.changed_variable || !value.source_hypothesis_id)) fail("controlled mutation incomplete");
  if (value.mutation_kind === "CONTROLLED_MUTATION" &&
      !CANONICAL_MATERIAL_VARIABLES.has(value.changed_variable)) fail("unknown canonical material variable");
  if (value.changed_variable !== null &&
      (!canonicalMaterialValue(value.changed_variable) || value.changed_variable === "UNKNOWN")) {
    fail("invalid changed variable");
  }
  if (value.source_hypothesis_id !== null && !UUID.test(value.source_hypothesis_id)) {
    fail("invalid source hypothesis");
  }
  if (value.prior_evidence_experiment_id !== null && !UUID.test(value.prior_evidence_experiment_id)) {
    fail("invalid prior experiment");
  }
  if (value.mutation_reason !== null && !canonicalMaterialValue(value.mutation_reason)) {
    fail("invalid mutation reason");
  }
  return value;
}

export async function buildExperimentProof({
  schema, parent_material_vector, child_material_vector, changed_variable,
  experiment_constants,
}) {
  const parent = validateMaterialVector(schema, parent_material_vector);
  const child = validateMaterialVector(schema, child_material_vector);
  if (!MATERIAL_SCHEMAS[schema].includes(changed_variable)) fail("variable outside platform schema");
  const diff = diffMaterialVectors(schema, parent, child);
  if (diff.changed_material_variables.length !== 1 ||
      diff.changed_material_variables[0] !== changed_variable ||
      diff.unknown_comparisons.length !== 0) fail("one material variable required");
  const constants = Object.fromEntries(MATERIAL_SCHEMAS[schema]
    .filter((key) => key !== changed_variable).map((key) => [key, parent[key]]));
  if (canonicalJson(experiment_constants) !== canonicalJson(constants)) fail("constants mismatch");
  const contract = {
    material_schema: schema,
    parent_material_vector: parent,
    child_material_vector: child,
    constants_snapshot: constants,
    material_diff: diff,
  };
  return { ...contract, contract_hash: await sha256Hex(canonicalJson(contract)) };
}

export function metricDelta(control, variant) {
  if (!Number.isFinite(control) || !Number.isFinite(variant)) {
    return { absolute_delta: "UNKNOWN", relative_delta_pct: "UNKNOWN" };
  }
  return {
    absolute_delta: variant - control,
    relative_delta_pct: control === 0 ? "UNKNOWN" : ((variant - control) / control) * 100,
  };
}

function unknownMetrics(limitation) {
  return {
    control_metrics: "UNKNOWN",
    variant_metrics: "UNKNOWN",
    metric_delta: { absolute_delta: "UNKNOWN", relative_delta_pct: "UNKNOWN" },
    limitations: [limitation],
  };
}

export function buildMutationAttribution({ mutation, experiment, analysis }) {
  if (!mutation || !experiment || experiment.creative_mutation_id !== mutation.id ||
      experiment.changed_variable !== mutation.changed_variable) fail("experiment lineage mismatch");
  const base = {
    parent_creative_id: mutation.parent_creative_id,
    child_creative_id: mutation.child_creative_id,
    experiment_id: experiment.id,
    changed_variable: mutation.changed_variable,
    constants: experiment.lineage_constants_snapshot,
    platform: experiment.platform,
    verdict: analysis?.conclusion ?? experiment.result ?? "UNKNOWN",
    confidence: analysis?.confidence ?? experiment.confidence ?? "LOW",
  };
  const expectedCheckpoint = experiment?.success_metrics?.checkpoint;
  if (!analysis || analysis.experiment_id !== experiment.id ||
      analysis.platform !== experiment.platform || analysis.checkpoint !== expectedCheckpoint) {
    return { ...base, ...unknownMetrics("analysis_checkpoint_or_platform_mismatch") };
  }
  if (experiment.platform === "tiktok") {
    const metric = experiment?.success_metrics?.primary_metric;
    const control = analysis?.metrics?.control_rate;
    const variant = analysis?.metrics?.variant_rate;
    const source = analysis?.metric_sources?.[metric];
    if (analysis?.metrics?.primary_metric !== metric || !Number.isFinite(control) ||
        !Number.isFinite(variant) || control < 0 || control > 1 || variant < 0 || variant > 1 ||
        !["api", "manual_tiktok_studio"].includes(source)) {
      return { ...base, ...unknownMetrics("unsupported_tiktok_metric_provenance") };
    }
    return {
      ...base,
      control_metrics: { [metric]: control },
      variant_metrics: { [metric]: variant },
      metric_delta: metricDelta(control, variant),
      limitations: Array.isArray(analysis.limitations) ? analysis.limitations : [],
    };
  }
  if (experiment.platform === "youtube_shorts") {
    const control = analysis?.actual?.control_rate;
    const variant = analysis?.actual?.variant_rate;
    const sources = analysis?.metric_sources;
    const validSnapshot = (value) => record(value) &&
      canonicalJson(Object.keys(value).sort()) === canonicalJson(["polled_at", "short_id"]) &&
      UUID.test(value.short_id ?? "") && validRfc3339(value.polled_at);
    if (!Number.isFinite(control) || !Number.isFinite(variant) || control < 0 || control > 1 ||
        variant < 0 || variant > 1 || sources?.store !== "published_shorts_stats" ||
        !validSnapshot(sources.control_snapshot) || !validSnapshot(sources.variant_snapshot)) {
      return { ...base, ...unknownMetrics("unsupported_youtube_metric_provenance") };
    }
    const metric = experiment?.success_metrics?.primary_metric ?? "primary_metric";
    return {
      ...base,
      control_metrics: { [metric]: control },
      variant_metrics: { [metric]: variant },
      metric_delta: metricDelta(control, variant),
      limitations: Array.isArray(analysis.limitations) ? analysis.limitations : [],
    };
  }
  return { ...base, ...unknownMetrics("unsupported_platform") };
}

function declarationKey(value) {
  return canonicalJson({
    child_creative_id: value.child_creative_id,
    parent_creative_id: value.parent_creative_id,
    mutation_kind: value.mutation_kind,
    changed_variable: value.changed_variable,
    mutation_reason: value.mutation_reason,
    source_hypothesis_id: value.source_hypothesis_id,
    prior_evidence_experiment_id: value.prior_evidence_experiment_id,
  });
}

export class CreativeMutationGraph {
  #relations = new Map();
  #owners = new Map();

  #key(ownerId, creativeId) {
    return `${ownerId}\u0000${creativeId}`;
  }

  addCreative(creativeId, ownerId) {
    if (!CREATIVE_ID.test(creativeId) || !UUID.test(ownerId)) fail("invalid creative anchor");
    this.#owners.set(this.#key(ownerId, creativeId), true);
  }

  register(ownerId, declaration) {
    const value = validateMutationDeclaration(declaration);
    if (!this.#owners.has(this.#key(ownerId, value.child_creative_id)) ||
        (value.parent_creative_id && !this.#owners.has(this.#key(ownerId, value.parent_creative_id)))) {
      fail("cross-owner or missing creative anchor");
    }
    const relationKey = this.#key(ownerId, value.child_creative_id);
    const existing = this.#relations.get(relationKey);
    if (existing) {
      if (declarationKey(existing) !== declarationKey(value)) fail("conflicting mutation replay");
      return existing;
    }
    if (value.parent_creative_id) {
      let cursor = value.parent_creative_id;
      const visited = new Set();
      for (let depth = 0; cursor && depth < 128; depth += 1) {
        if (cursor === value.child_creative_id || visited.has(cursor)) fail("creative cycle forbidden");
        visited.add(cursor);
        cursor = this.#relations.get(this.#key(ownerId, cursor))?.parent_creative_id ?? null;
      }
      if (cursor) fail("lineage depth exceeded");
    }
    const row = Object.freeze({ id: `mutation-${ownerId}-${value.child_creative_id.slice(9)}`, user_id: ownerId, ...value });
    this.#relations.set(relationKey, row);
    return row;
  }

  parent(ownerId, creativeId) {
    return this.#relations.get(this.#key(ownerId, creativeId))?.parent_creative_id ?? null;
  }

  children(ownerId, creativeId) {
    return [...this.#relations.values()].filter((row) => row.user_id === ownerId && row.parent_creative_id === creativeId)
      .sort((a, b) => a.child_creative_id.localeCompare(b.child_creative_id));
  }

  ancestors(ownerId, creativeId) {
    const result = [];
    let cursor = this.parent(ownerId, creativeId);
    while (cursor && result.length < 128) {
      if (result.includes(cursor)) fail("stored lineage cycle");
      result.push(cursor);
      cursor = this.parent(ownerId, cursor);
    }
    return result;
  }

  descendants(ownerId, creativeId) {
    const result = [];
    const queue = this.children(ownerId, creativeId).map((row) => row.child_creative_id);
    while (queue.length && result.length < 4096) {
      const current = queue.shift();
      if (result.includes(current)) fail("stored lineage cycle");
      result.push(current);
      queue.push(...this.children(ownerId, current).map((row) => row.child_creative_id));
    }
    return result;
  }

  chain(ownerId, creativeId) {
    return [...this.ancestors(ownerId, creativeId)].reverse().concat(creativeId);
  }

  status(ownerId, creativeId, boundExperimentCount = 0) {
    const row = this.#relations.get(this.#key(ownerId, creativeId));
    if (!row) return "LEGACY_UNLINKED";
    if (!row.parent_creative_id) return row.mutation_kind === "NEW_CONCEPT" ? "ROOT" : "DECLARED_UNVERIFIED";
    return boundExperimentCount > 0 ? "VERIFIED" : "DECLARED_UNVERIFIED";
  }
}

export function shouldCreateCreativeChild(changeKind) {
  return changeKind === "MATERIAL_CREATIVE_INTENT";
}
