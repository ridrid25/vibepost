import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CreativeMutationGraph,
  MATERIAL_SCHEMAS,
  MutationContractError,
  buildExperimentProof,
  buildMutationAttribution,
  diffMaterialVectors,
  metricDelta,
  shouldCreateCreativeChild,
  validateMaterialVector,
  validateMutationDeclaration,
} from "../supabase/functions/_shared/creative-mutation-lineage.mjs";

const user = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const creative = (char) => `creative-${char.repeat(64)}`;
const A = creative("a");
const B = creative("b");
const C = creative("c");
const D = creative("d");

function vector(schema, changes = {}) {
  return Object.fromEntries(MATERIAL_SCHEMAS[schema].map((key) => [key, changes[key] ?? `base_${key}`]));
}

function controlled(child = B, parent = A, changed = "hook_type") {
  return {
    child_creative_id: child,
    parent_creative_id: parent,
    mutation_kind: "CONTROLLED_MUTATION",
    changed_variable: changed,
    mutation_reason: "Test one material change",
    source_hypothesis_id: uuid(10),
    prior_evidence_experiment_id: null,
  };
}

function graph(...ids) {
  const result = new CreativeMutationGraph();
  for (const id of ids) result.addCreative(id, user);
  return result;
}

test("NEW_CONCEPT accepts no parent and derives ROOT", () => {
  const g = graph(A);
  g.register(user, { ...controlled(A, null, null), mutation_kind: "NEW_CONCEPT",
    mutation_reason: null, source_hypothesis_id: null });
  assert.equal(g.status(user, A), "ROOT");
});

test("CONTROLLED_MUTATION requires a canonical parent", () => {
  assert.throws(() => validateMutationDeclaration({ ...controlled(), parent_creative_id: null }),
    MutationContractError);
});

test("self-parent is rejected", () => {
  assert.throws(() => validateMutationDeclaration(controlled(A, A)), /self parent forbidden/);
});

test("cycle is rejected", () => {
  const g = graph(A, B);
  g.register(user, controlled(B, A));
  assert.throws(() => g.register(user, controlled(A, B)), /cycle forbidden/);
});

test("cross-user parent is rejected", () => {
  const g = graph(B); g.addCreative(A, other);
  assert.throws(() => g.register(user, controlled(B, A)), /cross-owner/);
});

test("branching preserves two distinct children", () => {
  const g = graph(A, B, C);
  g.register(user, controlled(B, A));
  g.register(user, controlled(C, A, "pacing_profile"));
  assert.deepEqual(g.children(user, A).map((row) => row.child_creative_id), [B, C]);
});

test("multi-generation ancestors, descendants and chain are deterministic", () => {
  const g = graph(A, B, C, D);
  g.register(user, controlled(B, A));
  g.register(user, controlled(C, B, "payoff_class"));
  g.register(user, controlled(D, C, "camera_profile"));
  assert.deepEqual(g.ancestors(user, D), [C, B, A]);
  assert.deepEqual(g.descendants(user, A), [B, C, D]);
  assert.deepEqual(g.chain(user, D), [A, B, C, D]);
});

test("one changed variable produces a complete proof", async () => {
  const parent = vector("tiktok_v1");
  const child = { ...parent, hook_type: "new_hook" };
  const constants = { ...parent }; delete constants.hook_type;
  const proof = await buildExperimentProof({ schema: "tiktok_v1", parent_material_vector: parent,
    child_material_vector: child, changed_variable: "hook_type", experiment_constants: constants });
  assert.deepEqual(proof.material_diff.changed_material_variables, ["hook_type"]);
  assert.match(proof.contract_hash, /^[0-9a-f]{64}$/);
});

test("two material changes fail closed", async () => {
  const parent = vector("tiktok_v1");
  const child = { ...parent, hook_type: "new_hook", pacing_profile: "fast" };
  const constants = { ...parent }; delete constants.hook_type;
  await assert.rejects(buildExperimentProof({ schema: "tiktok_v1", parent_material_vector: parent,
    child_material_vector: child, changed_variable: "hook_type", experiment_constants: constants }),
  /one material variable required/);
});

test("constants snapshot is computed and caller mismatch is rejected", async () => {
  const parent = vector("youtube_v1");
  const child = { ...parent, payoff_class: "SURPRISE" };
  await assert.rejects(buildExperimentProof({ schema: "youtube_v1", parent_material_vector: parent,
    child_material_vector: child, changed_variable: "payoff_class", experiment_constants: {} }),
  /constants mismatch/);
});

test("UNKNOWN comparison is preserved, never treated as equality", () => {
  const parent = vector("tiktok_v1", { camera_profile: "UNKNOWN" });
  const child = vector("tiktok_v1", { camera_profile: "LOCKED" });
  assert.deepEqual(diffMaterialVectors("tiktok_v1", parent, child).unknown_comparisons, ["camera_profile"]);
});

test("material values reject trimming, controls and implicit NFC normalization", () => {
  for (const bad of [" padded", "bad\nvalue", "e\u0301"]) {
    assert.throws(() => validateMaterialVector("youtube_v1", vector("youtube_v1", { payoff_class: bad })),
      MutationContractError);
  }
});

test("experiment-lineage mismatch is rejected", () => {
  assert.throws(() => buildMutationAttribution({ mutation: { id: uuid(1), changed_variable: "hook_type" },
    experiment: { id: uuid(2), creative_mutation_id: uuid(3), changed_variable: "hook_type" } }),
  /experiment lineage mismatch/);
});

test("TikTok mutation attribution reuses comparable existing result", () => {
  const mutation = { id: uuid(1), parent_creative_id: A, child_creative_id: B, changed_variable: "hook_type" };
  const experiment = { id: uuid(2), creative_mutation_id: mutation.id, changed_variable: "hook_type",
    lineage_constants_snapshot: { pacing_profile: "steady" }, platform: "tiktok",
    success_metrics: { primary_metric: "like_rate", checkpoint: "24h" } };
  const analysis = { experiment_id: experiment.id, platform: "tiktok", checkpoint: "24h",
    conclusion: "PASS", confidence: "MEDIUM", metrics: { primary_metric: "like_rate",
      control_rate: 0.1, variant_rate: 0.15 }, metric_sources: { like_rate: "api" }, limitations: [] };
  const result = buildMutationAttribution({ mutation, experiment, analysis });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.metric_delta.relative_delta_pct, 49.999999999999986);
});

test("YouTube mutation attribution requires concrete snapshot provenance", () => {
  const mutation = { id: uuid(1), parent_creative_id: A, child_creative_id: B, changed_variable: "payoff_class" };
  const experiment = { id: uuid(2), creative_mutation_id: mutation.id, changed_variable: "payoff_class",
    lineage_constants_snapshot: {}, platform: "youtube_shorts",
    success_metrics: { primary_metric: "like_rate", checkpoint: "24h" } };
  const analysis = { experiment_id: experiment.id, platform: "youtube_shorts", checkpoint: "24h",
    conclusion: "FAIL", confidence: "MEDIUM", actual: { control_rate: 0.2, variant_rate: 0.1 },
    metric_sources: { store: "published_shorts_stats", control_snapshot: { short_id: uuid(3), polled_at: "2026-08-31T00:00:00Z" },
      variant_snapshot: { short_id: uuid(4), polled_at: "2026-08-31T00:00:00Z" } }, limitations: [] };
  assert.equal(buildMutationAttribution({ mutation, experiment, analysis }).metric_delta.absolute_delta, -0.1);
});

test("missing metric becomes UNKNOWN", () => {
  const mutation = { id: uuid(1), parent_creative_id: A, child_creative_id: B, changed_variable: "hook_type" };
  const experiment = { id: uuid(2), creative_mutation_id: mutation.id, changed_variable: "hook_type",
    lineage_constants_snapshot: {}, platform: "tiktok", success_metrics: { primary_metric: "share_rate", checkpoint: "24h" } };
  const analysis = { experiment_id: experiment.id, platform: "tiktok", checkpoint: "24h",
    metrics: {}, metric_sources: {}, conclusion: "INCONCLUSIVE", confidence: "LOW" };
  assert.equal(buildMutationAttribution({ mutation, experiment, analysis }).control_metrics, "UNKNOWN");
});

test("zero denominator preserves relative delta UNKNOWN", () => {
  assert.deepEqual(metricDelta(0, 0.2), { absolute_delta: 0.2, relative_delta_pct: "UNKNOWN" });
});

test("market reference and owner preference identifiers cannot be parents", () => {
  for (const parent of ["market-reference-1", "preference-1"]) {
    assert.throws(() => validateMutationDeclaration(controlled(B, parent)), /parent must be a canonical/);
  }
});

test("controlled mutation rejects variables outside accepted material vocabularies", () => {
  assert.throws(() => validateMutationDeclaration(controlled(B, A, "invented_variable")),
    /unknown canonical material variable/);
});

test("render retry and typo revision do not create a child", () => {
  assert.equal(shouldCreateCreativeChild("RENDER_EXPORT_RETRY"), false);
  assert.equal(shouldCreateCreativeChild("TYPO_OR_SERIALIZATION_ONLY"), false);
  assert.equal(shouldCreateCreativeChild("MATERIAL_CREATIVE_INTENT"), true);
});

test("idempotent exact replay returns the original relation", () => {
  const g = graph(A, B);
  const first = g.register(user, controlled());
  assert.equal(g.register(user, controlled()), first);
  assert.throws(() => g.register(user, { ...controlled(), mutation_reason: "Different" }), /replay/);
});

test("historical creative remains LEGACY_UNLINKED without guessed backfill", () => {
  assert.equal(graph(A).status(user, A), "LEGACY_UNLINKED");
});

test("in-memory graph scopes equal creative IDs by tenant", () => {
  const g = new CreativeMutationGraph();
  g.addCreative(A, user); g.addCreative(B, user);
  g.addCreative(A, other); g.addCreative(B, other);
  g.register(user, controlled(B, A));
  g.register(other, controlled(B, A));
  assert.equal(g.children(user, A).length, 1);
  assert.equal(g.children(other, A).length, 1);
  assert.notEqual(g.children(user, A)[0].id, g.children(other, A)[0].id);
});

test("SQL is additive, owner scoped, append-only and has no guessed backfill", () => {
  const sql = readFileSync("supabase/migrations/20260831000006_creative_mutation_lineage.sql", "utf8");
  assert.match(sql, /create table public\.creative_mutations/);
  assert.match(sql, /creative_mutations_owner_read/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /MUTATION_HISTORY_IMMUTABLE/);
  assert.match(sql, /LEGACY_UNLINKED/);
  assert.doesNotMatch(sql, /similarity\s*\(|levenshtein|title.*date|prompt.*similar/i);
  assert.doesNotMatch(sql, /update public\.creative_identity_map|delete from public\.creative_identity_map/i);
});

test("SQL stores one canonical relation and per-experiment platform proof", () => {
  const sql = readFileSync("supabase/migrations/20260831000006_creative_mutation_lineage.sql", "utf8");
  assert.match(sql, /unique \(user_id, child_creative_id\)/);
  assert.match(sql, /add column creative_mutation_id uuid/);
  assert.match(sql, /lineage_constants_snapshot jsonb/);
  assert.match(sql, /lineage_contract_hash text/);
  assert.match(sql, /creative_identity_map_id_user_creative_unique/);
});

test("SQL service-only binding and direct lineage update denial are explicit", () => {
  const sql = readFileSync("supabase/migrations/20260831000006_creative_mutation_lineage.sql", "utf8");
  const bindingGrants = sql.slice(sql.indexOf("revoke execute on function public.bind_experiment_creative_mutation"),
    sql.indexOf("revoke execute on function public.get_creative_parent"));
  assert.match(sql, /auth\.role\(\) <> 'service_role'/);
  assert.match(sql, /revoke update on public\.experiments from authenticated/);
  assert.match(bindingGrants, /grant execute on function public\.bind_experiment_creative_mutation[\s\S]*to service_role/);
  assert.doesNotMatch(bindingGrants, /to authenticated/);
});

test("empty or malformed metric provenance stays UNKNOWN in JS attribution", () => {
  const mutation = { id: uuid(1), parent_creative_id: A, child_creative_id: B, changed_variable: "hook_type" };
  const experiment = { id: uuid(2), creative_mutation_id: mutation.id, changed_variable: "hook_type",
    lineage_constants_snapshot: {}, platform: "tiktok", success_metrics: { primary_metric: "like_rate", checkpoint: "24h" } };
  const analysis = { experiment_id: experiment.id, platform: "tiktok", checkpoint: "24h",
    metrics: { primary_metric: "like_rate", control_rate: 0.1, variant_rate: 0.2 },
    metric_sources: { like_rate: "" }, conclusion: "PASS", confidence: "MEDIUM" };
  assert.equal(buildMutationAttribution({ mutation, experiment, analysis }).control_metrics, "UNKNOWN");
  const youtube = { ...experiment, platform: "youtube_shorts", success_metrics: { primary_metric: "like_rate", checkpoint: "24h" } };
  const youtubeAnalysis = { experiment_id: experiment.id, platform: "youtube_shorts", checkpoint: "24h",
    actual: { control_rate: 0.1, variant_rate: 0.2 }, metric_sources: { store: "published_shorts_stats",
      control_snapshot: {}, variant_snapshot: {} }, conclusion: "PASS", confidence: "MEDIUM" };
  assert.equal(buildMutationAttribution({ mutation, experiment: youtube, analysis: youtubeAnalysis }).control_metrics, "UNKNOWN");
  youtubeAnalysis.metric_sources = { store: "published_shorts_stats",
    control_snapshot: { short_id: uuid(3), polled_at: "August 31, 2026" },
    variant_snapshot: { short_id: uuid(4), polled_at: "2026-08-31T00:00:00+00:00" } };
  assert.equal(buildMutationAttribution({ mutation, experiment: youtube, analysis: youtubeAnalysis }).control_metrics, "UNKNOWN");
  youtubeAnalysis.metric_sources.control_snapshot.polled_at = "2026-08-31T00:00:00+00:00";
  assert.notEqual(buildMutationAttribution({ mutation, experiment: youtube, analysis: youtubeAnalysis }).control_metrics, "UNKNOWN");
  youtubeAnalysis.metric_sources.control_snapshot.polled_at = "2026-02-31T00:00:00Z";
  assert.equal(buildMutationAttribution({ mutation, experiment: youtube, analysis: youtubeAnalysis }).control_metrics, "UNKNOWN");
});

test("lesson and creative traversal reuse existing experiments and lessons", () => {
  const sql = readFileSync("supabase/migrations/20260831000006_creative_mutation_lineage.sql", "utf8");
  assert.match(sql, /resolve_lesson_mutation_lineage/);
  assert.match(sql, /resolve_creative_lesson_lineage/);
  assert.match(sql, /jsonb_array_elements\(l\.evidence\)/);
  assert.doesNotMatch(sql, /create table public\.(?:experiments|content_lessons|creative_memory)/i);
});

test("TikTok deterministic E2E: A -> B -> experiment -> attribution -> lesson traversal contract", async () => {
  const g = graph(A, B);
  const mutation = g.register(user, controlled(B, A, "hook_type"));
  const parent = vector("tiktok_v1"); const child = { ...parent, hook_type: "pattern_interrupt" };
  const constants = { ...parent }; delete constants.hook_type;
  const proof = await buildExperimentProof({ schema: "tiktok_v1", parent_material_vector: parent,
    child_material_vector: child, changed_variable: "hook_type", experiment_constants: constants });
  const experiment = { id: uuid(40), creative_mutation_id: mutation.id, changed_variable: "hook_type",
    lineage_constants_snapshot: proof.constants_snapshot, platform: "tiktok",
    success_metrics: { primary_metric: "share_rate", checkpoint: "24h" } };
  const analysis = { experiment_id: experiment.id, platform: "tiktok", checkpoint: "24h",
    conclusion: "PASS", confidence: "MEDIUM", metrics: { primary_metric: "share_rate",
      control_rate: 0.02, variant_rate: 0.03 }, metric_sources: { share_rate: "api" }, limitations: [] };
  const attribution = buildMutationAttribution({ mutation, experiment, analysis });
  const lesson = { evidence: [{ experiment_id: experiment.id }] };
  assert.equal(attribution.changed_variable, "hook_type");
  assert.equal(attribution.verdict, "PASS");
  assert.equal(lesson.evidence[0].experiment_id, attribution.experiment_id);
});

test("YouTube deterministic E2E: X -> Y payoff mutation -> existing verdict attribution", async () => {
  const X = creative("e"); const Y = creative("f"); const g = graph(X, Y);
  const mutation = g.register(user, controlled(Y, X, "payoff_class"));
  const parent = vector("youtube_v1"); const child = { ...parent, payoff_class: "REVERSAL" };
  const constants = { ...parent }; delete constants.payoff_class;
  const proof = await buildExperimentProof({ schema: "youtube_v1", parent_material_vector: parent,
    child_material_vector: child, changed_variable: "payoff_class", experiment_constants: constants });
  const experiment = { id: uuid(50), creative_mutation_id: mutation.id, changed_variable: "payoff_class",
    lineage_constants_snapshot: proof.constants_snapshot, platform: "youtube_shorts",
    success_metrics: { primary_metric: "like_rate", checkpoint: "24h" } };
  const analysis = { experiment_id: experiment.id, platform: "youtube_shorts", checkpoint: "24h",
    conclusion: "FAIL", confidence: "MEDIUM", actual: { control_rate: 0.08, variant_rate: 0.05 },
    metric_sources: { store: "published_shorts_stats",
      control_snapshot: { short_id: uuid(51), polled_at: "2026-08-31T00:00:00Z" },
      variant_snapshot: { short_id: uuid(52), polled_at: "2026-08-31T00:00:00Z" } }, limitations: [] };
  const attribution = buildMutationAttribution({ mutation, experiment, analysis });
  assert.equal(attribution.verdict, "FAIL");
  assert.equal(attribution.metric_delta.relative_delta_pct, -37.5);
});

test("Generator paths and production actions are absent from POST-09 implementation", () => {
  const source = readFileSync("supabase/functions/_shared/creative-mutation-lineage.mjs", "utf8") +
    readFileSync("supabase/migrations/20260831000006_creative_mutation_lineage.sql", "utf8");
  assert.doesNotMatch(source, /\b(?:Gemini|Flow|ffmpeg|Whisper)\b|publish(?:ing)?\s*\(|fetch\s*\(/i);
});
