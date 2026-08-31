import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  YOUTUBE_MATERIAL_FIELDS,
  annotateYoutubeCandidates,
  buildYoutubeFeedbackContext,
  deriveYoutubeMaterialVector,
  evaluateYoutubeExperiment,
  normalizeYoutubeMetricFacts,
  optionalYoutubeCount,
  selectYoutubeCheckpointSnapshot,
  youtubeFeedbackBatchKey,
  youtubeMinimumViews,
} from "../supabase/functions/_shared/youtube-own-learning.mjs";

const root = new URL("..", import.meta.url);
const source = (relative) => readFileSync(new URL(relative, root), "utf8");
const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const creative = (value) => `creative-${String(value).padStart(64, "0")}`;
const iso = (hour) => `2026-08-01T${String(hour).padStart(2, "0")}:00:00Z`;
const vector = (pattern = "PATTERN_A", payoff = "PAYOFF_A") => ({
  causal_pattern_class: pattern,
  payoff_class: payoff,
  prompt_framework_version: "PF-v1",
  fidelity_constraints_hash: "d689229313ee9ce09ddaa5639964cd7bbc21e83d1d0714332c91be239ec1ae72",
});
const constants = (changed = "causal_pattern_class") => Object.fromEntries(
  YOUTUBE_MATERIAL_FIELDS.filter((key) => key !== changed).map((key) => [key, vector()[key]]),
);

function contextFixture() {
  const passIds = [id(11), id(12), id(13)];
  const failIds = [id(21), id(22)];
  const experiments = [
    ...passIds.map((experimentId, index) => ({
      id: experimentId, platform: "youtube_shorts", result: "PASS",
      status: "ANALYZED", confidence: "MEDIUM", updated_at: iso(10 + index),
      hypothesis: "Reference pattern improves likes",
      changed_variable: "causal_pattern_class", constants: constants(),
      success_metrics: { primary_metric: "like_rate", direction: "increase", checkpoint: "24h", mde: 0.01 },
      control_material_vector: vector(), variant_material_vector: vector(`PATTERN_${index + 2}`),
    })),
    ...failIds.map((experimentId, index) => ({
      id: experimentId, platform: "youtube_shorts", result: "FAIL",
      status: "ANALYZED", confidence: "MEDIUM", updated_at: iso(15 + index),
      hypothesis: "Failed pattern", changed_variable: "causal_pattern_class",
      constants: constants(),
      success_metrics: { primary_metric: "like_rate", direction: "increase", checkpoint: "24h", mde: 0.01 },
      control_material_vector: vector(), variant_material_vector: vector("PATTERN_FAILED"),
    })),
    { id: id(99), platform: "tiktok", result: "PASS", updated_at: iso(20) },
  ];
  const analyses = experiments.filter((row) => row.platform === "youtube_shorts").map((row, index) => ({
    id: id(100 + index), user_id: id(1), platform: "youtube_shorts",
    experiment_id: row.id, conclusion: row.result, created_at: iso(18 + index),
  }));
  const lessons = [
    { id: id(31), source_platform: "youtube_shorts", lesson: "Pattern works",
      category: "WINNING_PATTERN", status: "SUPPORTED", confidence: "HIGH",
      updated_at: iso(22), evidence: passIds.slice(0, 2).map((experiment_id) => ({ experiment_id })) },
    { id: id(32), source_platform: "youtube_shorts", lesson: "Avoid failed pattern",
      category: "FAILED_PATTERN", status: "REJECTED", confidence: "MEDIUM",
      updated_at: iso(21), evidence: failIds.map((experiment_id) => ({ experiment_id })) },
    { id: id(33), source_platform: "youtube_shorts", lesson: "Single result",
      category: "HYPOTHESIS", status: "HYPOTHESIS", confidence: "LOW",
      updated_at: iso(23), evidence: [{ experiment_id: passIds[0] }] },
    { id: id(34), source_platform: "tiktok", lesson: "TikTok only",
      category: "WINNING_PATTERN", status: "CONFIRMED", confidence: "HIGH",
      updated_at: iso(23), evidence: passIds.map((experiment_id) => ({ experiment_id })) },
  ];
  return {
    lessons, experiments, analyses, lesson_bindings: [],
    framework: { id: id(50), version_label: "PF-v1", status: "STANDARD", is_current: true,
      prompt_framework_rules: [{ id: id(51), status: "STANDARD", confidence: "HIGH", updated_at: iso(20) }] },
    owner_ideas: [
      { id: id(61), target_platform: "youtube_shorts", status: "done", route: "self", decided_at: iso(22) },
      { id: id(62), target_platform: "youtube_shorts", status: "rejected", route: null, decided_at: iso(21) },
      { id: id(63), target_platform: "tiktok", status: "done", route: "self", decided_at: iso(23) },
    ],
    market_references: [
      { reference_source_id: "MARKET_OK", causal_pattern: { pattern_class: "PATTERN_2" },
        payoff_class: "PAYOFF_A", critical_fidelity_constraints: ["keep order"] },
      { reference_source_id: "MARKET_CONFLICT", causal_pattern: { pattern_class: "PATTERN_FAILED" },
        payoff_class: "PAYOFF_A", critical_fidelity_constraints: ["keep order"] },
    ],
  };
}

test("YouTube counts preserve missing values instead of synthetic zero", () => {
  assert.equal(optionalYoutubeCount(undefined), null);
  assert.equal(optionalYoutubeCount("0"), 0);
  assert.equal(optionalYoutubeCount("bad"), null);
  const facts = normalizeYoutubeMetricFacts({ short_id: id(1), polled_at: iso(1), views: 100, likes: null, comments: 4 });
  assert.equal(facts.likes, "UNKNOWN");
  assert.equal(facts.engagement, "UNKNOWN");
  assert.equal(facts.unsupported.shares, "UNSUPPORTED");
  assert.equal(facts.unsupported.retention, "UNSUPPORTED");
});

test("checkpoint selects nearest existing snapshot without interpolation", () => {
  const selected = selectYoutubeCheckpointSnapshot({ published_at: iso(0), checkpoint: "6h", snapshots: [
    { short_id: id(1), polled_at: "2026-08-01T05:45:00Z" },
    { short_id: id(1), polled_at: "2026-08-01T06:10:00Z" },
  ] });
  assert.equal(selected.snapshot.polled_at, "2026-08-01T06:10:00Z");
  assert.equal(selectYoutubeCheckpointSnapshot({ published_at: iso(0), checkpoint: "24h", snapshots: [] }).snapshot, null);
  assert.equal(selectYoutubeCheckpointSnapshot({ published_at: null, checkpoint: "24h", snapshots: [] }).limitation, "missing_publish_time");
});

test("YouTube sufficiency is derived from canonical mde and not TikTok 400", () => {
  assert.equal(youtubeMinimumViews(0.1), 193);
  assert.equal(youtubeMinimumViews(0), null);
  assert.ok(youtubeMinimumViews(0.02) > 400);
});

test("material provenance requires one exact changed variable and byte-equal constants", async () => {
  const control = await deriveYoutubeMaterialVector({ causal_pattern: { pattern_class: "A" },
    payoff_class: "P", prompt_framework_version: "v1", fidelity_constraints: ["x"] });
  const variant = await deriveYoutubeMaterialVector({ causal_pattern: { pattern_class: "B" },
    payoff_class: "P", prompt_framework_version: "v1", fidelity_constraints: ["x"] });
  const exact = Object.fromEntries(YOUTUBE_MATERIAL_FIELDS.filter((key) => key !== "causal_pattern_class")
    .map((key) => [key, control[key]]));
  const result = evaluateYoutubeExperiment({ control: { views: 100, likes: 10 }, variant: { views: 100, likes: 20 },
    success_metrics: { primary_metric: "like_rate", direction: "increase", checkpoint: "24h", mde: 0.1 },
    control_material: control, variant_material: variant, changed_variable: "causal_pattern_class", constants: exact });
  assert.notEqual(result.limitations?.[0], "one_changed_variable_required");
});

test("JS and SQL share canonical fidelity bytes and reject fabricated vector defaults", async () => {
  const material = await deriveYoutubeMaterialVector({ causal_pattern: { pattern_class: "A" },
    payoff_class: "P", prompt_framework_version: "v1",
    fidelity_constraints: ["keep order", "second"] });
  assert.equal(material.fidelity_constraints_hash,
    "19b8acf039a39a3dcd914325933722aa754d403a4a85e6dcf6d4eb7fd8b8e3db");
  assert.equal(await deriveYoutubeMaterialVector({ causal_pattern: { pattern_class: "A" },
    payoff_class: "P", fidelity_constraints: [] }), null);
  const sql = source("supabase/migrations/20260831000003_youtube_own_learning.sql");
  assert.match(sql, /canonical_jsonb_text\(v_ci\.fidelity_constraints\)/);
  assert.doesNotMatch(sql, /coalesce\(v_ci\.prompt_framework_version,'UNVERSIONED'\)/);
});

test("insufficient sample is INCONCLUSIVE", () => {
  const result = evaluateYoutubeExperiment({ control: { views: 100, likes: 10 }, variant: { views: 100, likes: 30 },
    success_metrics: { primary_metric: "like_rate", direction: "increase", checkpoint: "24h", mde: 0.02 },
    control_material: vector(), variant_material: vector("PATTERN_B"),
    changed_variable: "causal_pattern_class", constants: constants() });
  assert.equal(result.conclusion, "INCONCLUSIVE");
  assert.deepEqual(result.limitations, ["insufficient_youtube_sample"]);
});

test("conclusive PASS uses existing Wilson/Newcombe semantics", () => {
  const result = evaluateYoutubeExperiment({ control: { views: 10000, likes: 800 }, variant: { views: 10000, likes: 1600 },
    success_metrics: { primary_metric: "like_rate", direction: "increase", checkpoint: "24h", mde: 0.02 },
    control_material: vector(), variant_material: vector("PATTERN_B"),
    changed_variable: "causal_pattern_class", constants: constants() });
  assert.equal(result.conclusion, "PASS");
});

test("conclusive FAIL uses available YouTube metric only", () => {
  const result = evaluateYoutubeExperiment({ control: { views: 100000, likes: 10000 }, variant: { views: 100000, likes: 9000 },
    success_metrics: { primary_metric: "like_rate", direction: "increase", checkpoint: "24h", mde: 0.01 },
    control_material: vector(), variant_material: vector("PATTERN_B"),
    changed_variable: "causal_pattern_class", constants: constants() });
  assert.equal(result.conclusion, "FAIL");
});

test("invalid, missing and unsupported verdict inputs fail closed", () => {
  for (const success_metrics of [
    { primary_metric: "share_rate", direction: "increase", checkpoint: "24h", mde: 0.01 },
    { primary_metric: "like_rate", direction: "increase", checkpoint: "24h", minimum_detectable_effect: 0.01 },
    { primary_metric: "like_rate", direction: "increase", checkpoint: "24h", mde: 2 },
  ]) {
    const result = evaluateYoutubeExperiment({ control: {}, variant: {}, success_metrics,
      control_material: vector(), variant_material: vector("B"),
      changed_variable: "causal_pattern_class", constants: constants() });
    assert.equal(result.conclusion, "INCONCLUSIVE");
  }
});

test("existing YouTube lessons and experiments feed the next hypothesis", async () => {
  const context = await buildYoutubeFeedbackContext(contextFixture());
  assert.equal(context.outcome, "HYPOTHESIS");
  assert.deepEqual(context.OWN_PERFORMANCE.selected_lessons.map((row) => row.lesson_id), [id(31)]);
  assert.deepEqual(context.OWN_PERFORMANCE.avoided_lessons.map((row) => row.lesson_id), [id(32)]);
  assert.equal(context.hypothesis_candidate.status, "HYPOTHESIS");
  assert.equal(context.hypothesis_candidate.confidence, "LOW");
  assert.equal(context.hypothesis_candidate.changed_variable, "causal_pattern_class");
});

test("one result never becomes CONFIRMED or active guidance", async () => {
  const data = contextFixture();
  data.lessons = data.lessons.filter((row) => row.id === id(33));
  const context = await buildYoutubeFeedbackContext(data);
  assert.equal(context.outcome, "NO_STRONG_HYPOTHESIS");
  assert.equal(context.OWN_PERFORMANCE.selected_lessons.length, 0);
});

test("recent rejected exact signature blocks the next hypothesis", async () => {
  const data = contextFixture();
  data.hypotheses = [{ status: "REJECTED", changed_variable: "causal_pattern_class",
    constants: constants(), feedback_context: { platform: "youtube_shorts" } }];
  const context = await buildYoutubeFeedbackContext(data);
  assert.equal(context.outcome, "NO_STRONG_HYPOTHESIS");
  assert.equal(context.hypothesis_candidate, null);
});

test("TikTok and legacy rejected hypotheses cannot suppress YouTube evidence", async () => {
  const data = contextFixture();
  data.hypotheses = [
    { status: "REJECTED", changed_variable: "causal_pattern_class", constants: constants(),
      feedback_context: { platform: "tiktok" } },
    { status: "REJECTED", changed_variable: "causal_pattern_class", constants: constants() },
  ];
  assert.equal((await buildYoutubeFeedbackContext(data)).outcome, "HYPOTHESIS");
});

test("MARKET_REFERENCE, OWN_PERFORMANCE and OWNER_PREFERENCE stay separate", async () => {
  const context = await buildYoutubeFeedbackContext(contextFixture());
  assert.equal(context.MARKET_REFERENCE[0].source_type, "MARKET_REFERENCE");
  assert.equal(context.OWN_PERFORMANCE.source_type, "OWN_PERFORMANCE");
  assert.equal(context.OWNER_PREFERENCE.source_type, "OWNER_PREFERENCE");
  assert.deepEqual(context.OWNER_PREFERENCE.approved.map((row) => row.idea_id), [id(61)]);
  assert.deepEqual(context.OWNER_PREFERENCE.rejected.map((row) => row.idea_id), [id(62)]);
  assert.ok(!JSON.stringify(context.OWN_PERFORMANCE).includes(id(62)));
});

test("exact MARKET-vs-OWN pattern conflict is preserved, never semantically guessed", async () => {
  const context = await buildYoutubeFeedbackContext(contextFixture());
  const conflict = context.MARKET_REFERENCE.find((row) => row.reference_id === "MARKET_CONFLICT");
  assert.equal(conflict.pattern_key, "PATTERN:PATTERN_FAILED");
  assert.deepEqual(conflict.conflict, {
    lesson_ids: [id(32)], experiment_ids: [id(21), id(22)],
  });
  assert.equal(context.MARKET_REFERENCE.find((row) => row.reference_id === "MARKET_OK").conflict, null);
});

test("feedback context and batch id are deterministic", async () => {
  const first = await buildYoutubeFeedbackContext(contextFixture());
  const second = await buildYoutubeFeedbackContext(contextFixture());
  assert.equal(first.context_hash, second.context_hash);
  assert.equal(first.hypothesis_key, second.hypothesis_key);
  assert.equal(await youtubeFeedbackBatchKey(id(1), "request:1"), await youtubeFeedbackBatchKey(id(1), "request:1"));
  assert.notEqual(await youtubeFeedbackBatchKey(id(1), "request:1"), await youtubeFeedbackBatchKey(id(1), "request:2"));
});

test("candidate provenance keeps conflicts and owner choice without auto-production", async () => {
  const context = await buildYoutubeFeedbackContext(contextFixture());
  const candidates = await annotateYoutubeCandidates([
    { slug: "ok", reference_id: "MARKET_OK", hook: "H", line: "L", animal: "A" },
    { slug: "conflict", reference_id: "MARKET_CONFLICT", hook: "H2", line: "L2", animal: "B" },
  ], context);
  assert.equal(candidates[0].evidence_mode, "OWN_PERFORMANCE_BOUND");
  assert.equal(candidates[1].evidence_mode, "MARKET_REFERENCE_ONLY");
  assert.equal(candidates[1].idea_confidence, "LOW");
  assert.equal(candidates[1].evidence_conflicts.length, 1);
  assert.deepEqual(candidates[1].selected_lesson_ids, []);
  assert.deepEqual(candidates[1].avoided_lesson_ids, []);
  assert.deepEqual(candidates[1].own_experiment_ids, []);
  assert.ok(candidates.every((row) => row.evidence_roots.MARKET_REFERENCE));
});

test("OWN context carries analysis, publication, snapshot, creative and limitation provenance", async () => {
  const data = contextFixture();
  data.publications = [{ id: id(71), youtube_id: "abcdefghijk", published_at: iso(0) }];
  data.mappings = [{ id: id(72), youtube_short_row_id: id(71), creative_id: creative(9) }];
  data.snapshots = [{ short_id: id(71), polled_at: iso(24), views: 1000, likes: 100, comments: null }];
  data.experiments[0].variant_youtube_short_id = id(71);
  data.experiments[0].variant_creative_id = creative(9);
  data.analyses[0].youtube_short_id = id(71);
  data.analyses[0].youtube_snapshot_polled_at = iso(24);
  data.analyses[0].metric_sources = { store: "published_shorts_stats" };
  data.analyses[0].limitations = ["initial_policy"];
  data.lesson_bindings = [{ lesson_id: id(31), experiment_id: id(11), short_id: id(71),
    snapshot_polled_at: iso(24), identity_map_id: id(72) }];
  const context = await buildYoutubeFeedbackContext(data);
  const evidence = context.OWN_PERFORMANCE.selected_lessons[0].conclusive_evidence[0];
  assert.equal(evidence.latest_analysis_id, id(100));
  assert.equal(evidence.mapped_creative_id, creative(9));
  assert.equal(evidence.publication.external_video_id, "abcdefghijk");
  assert.equal(evidence.snapshot_metrics.likes, 100);
  assert.deepEqual(evidence.limitations, ["initial_policy"]);
});

test("migration reuses existing stores with exclusive platform subjects and no fake TikTok rows", () => {
  const sql = source("supabase/migrations/20260831000003_youtube_own_learning.sql");
  assert.match(sql, /alter table public\.experiments[\s\S]*platform text not null default 'tiktok'/);
  assert.match(sql, /control_youtube_short_id/);
  assert.match(sql, /platform = 'youtube_shorts' and control_video_id is null/);
  assert.match(sql, /content_analysis_subject_check/);
  assert.match(sql, /source_platform text not null default 'tiktok'/);
  assert.match(sql, /content_lesson_youtube_publications/);
  assert.doesNotMatch(sql, /create table public\.youtube_(lessons|experiments|analytics)/);
  assert.doesNotMatch(sql, /insert into public\.videos/);
});

test("snapshot ownership, lesson evidence and promotion are referential and idempotent", () => {
  const sql = source("supabase/migrations/20260831000003_youtube_own_learning.sql");
  assert.match(sql, /foreign key \(short_id, user_id\) references public\.published_shorts \(id, user_id\)/);
  assert.match(sql, /primary key \(lesson_id, experiment_id, short_id, snapshot_polled_at\)/);
  assert.match(sql, /select distinct \(x->>'experiment_id'\)::uuid/);
  assert.match(sql, /on conflict do nothing/);
  assert.match(sql, /youtube_lesson_key/);
  assert.match(sql, /youtube_lesson_evidence_inconsistent/);
  assert.match(sql, /youtube_lesson_promotion_conflict/);
  assert.match(sql, /youtube_experiment_identity_immutable/);
  assert.match(sql, /revoke execute[\s\S]*from public,anon,authenticated/);
});

test("batch replay compares the full immutable contract and locks OWN chains", () => {
  const sql = source("supabase/migrations/20260831000003_youtube_own_learning.sql");
  assert.match(sql, /youtube_batch_contract_hash/);
  assert.match(sql, /'candidates',p_candidates/);
  assert.match(sql, /youtube_hypothesis_replay_conflict/);
  assert.match(sql, /youtube_market_candidate_false_own_provenance/);
  assert.match(sql, /youtube_evidence_roots_conflict/);
  assert.match(sql, /is distinct from 'object'/);
  assert.match(sql, /array\['MARKET_REFERENCE','OWN_PERFORMANCE','OWNER_PREFERENCE'\]::text\[\]/);
  assert.match(sql, /array\['approved','rejected'\]::text\[\]/);
  assert.match(sql, /youtube_owner_preference_conflict/);
  assert.match(sql, /locked_owner_approved/);
  assert.match(sql, /locked_owner_rejected/);
  assert.match(sql, /youtube_experiment_lesson_chain_conflict/);
  assert.match(sql, /for key share/);
});

test("shorts collector is service-only, configured-owner scoped and null-preserving", () => {
  const edge = source("supabase/functions/shorts-stats/index.ts");
  assert.match(edge, /callerIsServiceRole/);
  assert.match(edge, /vibepost_content_brigade_owner/);
  assert.match(edge, /body\.user_id !== ownerId/);
  assert.match(edge, /youtube_publication_owner_conflict/);
  assert.match(edge, /if \(existing\) continue/);
  assert.match(edge, /\.eq\("user_id", ownerId\)/);
  assert.doesNotMatch(edge, /viewCount \?\? 0|likeCount \?\? 0|commentCount \?\? 0/);
  assert.match(edge, /user_id: ownerId/);
});

test("feedback loader paginates cited evidence and separates owner decision classes", () => {
  const suggest = source("supabase/functions/suggest-ideas/index.ts");
  assert.match(suggest, /async function loadYoutubeFeedbackInputs/);
  assert.match(suggest, /collectPages/);
  assert.match(suggest, /inChunks/);
  assert.match(suggest, /citedIds/);
  assert.match(suggest, /\.in\("route", \["self", "paid"\]\)/);
  assert.match(suggest, /\.is\("route", null\)\.eq\("status", "rejected"\)/);
  assert.match(suggest, /\.eq\("status", "REJECTED"\)/);
});

test("Content Brigade extends the existing engine with YouTube adapter actions", () => {
  const brigade = source("supabase/functions/content-brigade/index.ts");
  for (const action of ["record_youtube_experiment", "record_youtube_analysis", "record_youtube_lesson"]) {
    assert.ok(brigade.includes(action));
  }
  assert.match(brigade, /selectYoutubeCheckpointSnapshot/);
  assert.match(brigade, /evaluateYoutubeExperiment/);
  assert.match(brigade, /published_shorts_stats/);
});

test("owner approval remains the only route to prompt work or paid generation", () => {
  const button = source("supabase/functions/idea-button/index.ts");
  assert.match(button, /self: \{ status: "approved", route: "self"/);
  assert.match(button, /pay: \{ status: "approved", route: "paid"/);
  const taskStart = button.indexOf('if (action === "self")', button.indexOf("// Промт по идее"));
  assert.ok(taskStart > button.indexOf("const решение = решения[action]"));
  assert.match(button.slice(taskStart), /claude_tasks/);
  assert.match(button, /OWNER_PREFERENCE \(не performance evidence\)/);
  const mappingGate = button.indexOf('blocked: "youtube_creative_mapping_required"');
  const promptTask = button.indexOf('prompt_task_kind: "SELECTED_PROMPT"');
  assert.ok(mappingGate > 0 && mappingGate < promptTask);
});

test("both accepted prompt modes require canonical YouTube identity and immutable provenance", () => {
  const sql = source("supabase/migrations/20260831000003_youtube_own_learning.sql");
  assert.match(sql, /p_mode not in \('CLAUDE_TASK','OWNER_SELECTED_EXISTING'\)/);
  assert.match(sql, /youtube_creative_mapping_required/);
  assert.match(sql, /v_mapping\.creative_id/);
  assert.match(sql, /owner_selected_at/);
  const tasks = source("scripts/задания.mjs");
  assert.match(tasks, /rpc\/persist_tiktok_prompt_provenance/);
  assert.doesNotMatch(tasks.slice(tasks.indexOf("команда === 'промпт'")), /method: 'PATCH'/);
  const provenance = tasks.indexOf("rpc/persist_tiktok_prompt_provenance");
  const delivery = tasks.indexOf("await бот(экран(шапка)", provenance);
  assert.ok(provenance > 0 && delivery > provenance);
  const button = source("supabase/functions/idea-button/index.ts");
  assert.match(button, /\["tiktok", "youtube_shorts"\]\.includes\(idea\.target_platform\)/);
});

test("deterministic E2E traverses own Short to selected prompt provenance without live writes", async () => {
  const published = { id: id(200), creative_id: creative(1), published_at: iso(0) };
  const controlSnapshot = { short_id: id(199), polled_at: iso(24), views: 10000, likes: 800, comments: 100 };
  const variantSnapshot = { short_id: published.id, polled_at: iso(24), views: 10000, likes: 1600, comments: 120 };
  const verdict = evaluateYoutubeExperiment({ control: controlSnapshot, variant: variantSnapshot,
    success_metrics: { primary_metric: "like_rate", direction: "increase", checkpoint: "24h", mde: 0.02 },
    control_material: vector(), variant_material: vector("PATTERN_2"),
    changed_variable: "causal_pattern_class", constants: constants() });
  assert.equal(verdict.conclusion, "PASS");
  const context = await buildYoutubeFeedbackContext(contextFixture());
  const [candidate] = await annotateYoutubeCandidates([
    { id: id(300), slug: "next", reference_id: "MARKET_OK", hook: "NEXT", line: "LINE", animal: "FOX" },
  ], context);
  const selected = { ...candidate, status: "approved", route: "self", decided_at: iso(23) };
  const existingPost01Mapping = { video_idea_id: selected.id, creative_id: creative(2), source_revision_id: "rev-accepted" };
  const promptRecord = {
    video_idea_id: selected.id, creative_id: existingPost01Mapping.creative_id,
    hypothesis_key: context.hypothesis_key,
    lesson_ids: selected.selected_lesson_ids,
    market_reference_ids: selected.market_reference_ids,
    owner_selected_at: selected.decided_at,
  };
  assert.equal(promptRecord.creative_id, existingPost01Mapping.creative_id);
  assert.equal(promptRecord.lesson_ids[0], id(31));
  assert.deepEqual(promptRecord.market_reference_ids, ["MARKET_OK"]);
  assert.equal(selected.status, "approved");
});

test("POST-05 source never invokes live publishing, paid generation or Generator settings", () => {
  const module = source("supabase/functions/_shared/youtube-own-learning.mjs");
  const migration = source("supabase/migrations/20260831000003_youtube_own_learning.sql");
  assert.doesNotMatch(`${module}\n${migration}`, /youtube\.videos\.insert|uploadType=resumable|veo-start|ffmpeg|whisper/i);
});
