import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildTikTokMarketIdeaContext,
  formatTikTokMarketIdeaPromptContext,
  marketFeedbackBatchKey,
  validateTikTokMarketCandidates,
} from "../supabase/functions/_shared/tiktok-market-idea.mjs";

const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const hash = (char) => char.repeat(64);
const migrationPath = new URL("../supabase/migrations/20260831000005_tiktok_market_to_idea.sql", import.meta.url);
const suggestPath = new URL("../supabase/functions/suggest-ideas/index.ts", import.meta.url);
const buttonPath = new URL("../supabase/functions/idea-button/index.ts", import.meta.url);
const tasksPath = new URL("./задания.mjs", import.meta.url);

function base({ own = true, confirmed = true, failedHook = false } = {}) {
  const selected = own ? [{
    lesson_id: id(10), status: confirmed ? "CONFIRMED" : "SUPPORTED", confidence: "HIGH",
    conclusive_evidence: [{ experiment_id: id(11), latest_conclusion: "PASS" }],
  }] : [];
  return {
    context_version: 1, platform: "tiktok", context_hash: hash("a"),
    outcome: own ? "HYPOTHESIS" : "NO_STRONG_HYPOTHESIS",
    OWN_PERFORMANCE: {
      source_type: "OWN_PERFORMANCE", selected_lessons: selected,
      avoided_lessons: [{ lesson_id: id(12), status: "REJECTED", confidence: "MEDIUM",
        conclusive_evidence: [{ experiment_id: id(13), latest_conclusion: "FAIL" }] }],
      primary: own ? { lesson_id: id(10), experiment_id: id(11), analysis_id: id(14),
        changed_variable: "hook_type", constants: { pacing_profile: "baseline" } } : null,
      prompt_framework: { id: id(20), version_label: "PF-v1", status: "STANDARD", rule_ids: [] },
      recent_results: failedHook ? [{ experiment_id: id(13), result: "FAIL", changed_variable: "hook_type" }] : [],
      metric_provenance: { api_snapshot_ids: [], studio_metric_ids: [] },
    },
    OWNER_PREFERENCE: {
      source_type: "OWNER_PREFERENCE",
      approved: [{ idea_id: id(21), animal: "Сова", hook: "ГДЕ ДЕНЬГИ?" }],
      rejected: [{ idea_id: id(22), animal: "Крот", hook: "ОПЯТЬ КРЕДИТ?" }],
    },
    recent_creative_signatures: [], limitations: [],
    hypothesis_candidate: own ? {
      statement: "Изменить только hook_type", changed_variable: "hook_type",
      constants: { pacing_profile: "baseline" }, expected_effect: "increase shares",
      rationale: "OWN_PERFORMANCE", evidence: [{ source_type: "OWN_PERFORMANCE", lesson_ids: [id(10)] }],
    } : null,
  };
}

function fields(values = {}) {
  return Object.fromEntries([
    "hook_type", "first_frame_mechanic", "opening_action", "visual_pattern", "content_format",
    "setup", "conflict", "viewer_prediction", "violation", "escalation", "payoff",
    "loop_mechanic", "pacing_profile", "caption_style", "character_role", "camera_pattern",
    "sound_role", "CTA", "reusable_formula", "critical_fidelity_constraints",
  ].map((field) => [field, Object.hasOwn(values, field)
    ? { status: "INFERENCE", value: values[field] } : { status: "UNKNOWN", value: null }]));
}

function reference(number, disposition, updated = number) {
  return { id: id(100 + number), owner_disposition: disposition,
    updated_at: `2026-08-${String(updated).padStart(2, "0")}T00:00:00Z` };
}

function dna(number, referenceId, values, status = "ACCEPTED", version = 1) {
  return {
    id: id(200 + number), market_reference_id: referenceId, evidence_kind: "DNA_INFERENCE",
    analysis_identity: "HUMAN_REVIEW", evidence_version: version,
    created_at: `2026-08-${String(number).padStart(2, "0")}T00:00:00Z`,
    payload: { reviewer_status: status, confidence: "MEDIUM", limitations: [], fields: fields(values) },
  };
}

function marketInput() {
  const take = reference(1, "TAKE", 30);
  const interesting = reference(2, "INTERESTING_MECHANIC", 29);
  const skip = reference(3, "SKIP", 28);
  const dislike = reference(4, "NOT_MY_STYLE", 27);
  return {
    references: [skip, dislike, interesting, take],
    evidence: [
      dna(1, take.id, { hook_type: "обещание с немедленным визуальным нарушением" }),
      dna(2, interesting.id, { hook_type: "вопрос с предметным визуальным ответом" }),
      dna(3, skip.id, { hook_type: "исключённая механика" }),
      dna(4, dislike.id, { hook_type: "нежелательная сухая лекция" }),
    ],
  };
}

function candidates() {
  return [
    { slug: "fox-budget", animal: "Лиса", hook: "БЮДЖЕТ СБЕЖАЛ?",
      line: "Он просто пошёл искать доход.", prompt: "Abstract new visual finance joke.",
      why_this_idea: "Controlled hook test with own evidence.",
      market_mechanic_key: "M1", novelty_status: "MARKET_INSPIRED_TEST" },
    { slug: "owl-card", animal: "Сова", hook: "КАРТА ОБИДЕЛАСЬ?",
      line: "Ей снова урезали лимит.", prompt: "Different abstract finance setup.",
      why_this_idea: "Second controlled hook mutation.",
      market_mechanic_key: "M2", novelty_status: "CONTROLLED_MUTATION" },
    { slug: "bear-tax", animal: "Медведь", hook: "НАЛОГ ПРОСНУЛСЯ?",
      line: "Он зимовал прямо на счёте.", prompt: "New independent finance concept.",
      why_this_idea: "Diversity control candidate.",
      market_mechanic_key: "NONE", novelty_status: "NEW_CONCEPT" },
  ];
}

test("TAKE and INTERESTING_MECHANIC enter the bounded market root", async () => {
  const context = await buildTikTokMarketIdeaContext(base(), marketInput());
  assert.deepEqual(context.MARKET_REFERENCE.references.map((row) => row.key), ["M1", "M2"]);
});

test("SKIP is excluded and NOT_MY_STYLE exists only as owner avoidance", async () => {
  const input = marketInput();
  const context = await buildTikTokMarketIdeaContext(base(), input);
  assert.ok(!JSON.stringify(context.MARKET_REFERENCE).includes(input.references[0].id));
  assert.deepEqual(context.OWNER_PREFERENCE.MARKET_AVOIDANCE.map((row) => row.preference_id),
    [input.references[1].id]);
});

test("DRAFT and REJECTED DNA never become eligible", async () => {
  const draft = reference(5, "TAKE", 31); const rejected = reference(6, "TAKE", 32);
  const input = marketInput(); input.references.push(draft, rejected);
  input.evidence.push(dna(5, draft.id, { hook_type: "draft" }, "DRAFT"));
  input.evidence.push(dna(6, rejected.id, { hook_type: "rejected" }, "REJECTED"));
  const context = await buildTikTokMarketIdeaContext(base(), input);
  assert.ok(!context.MARKET_REFERENCE.references.some((row) => [draft.id, rejected.id].includes(row.market_reference_id)));
});

test("highest accepted DNA and reference ordering are deterministic", async () => {
  const input = marketInput();
  input.evidence.push(dna(7, input.references[3].id, { hook_type: "latest accepted abstraction" }, "ACCEPTED", 2));
  const first = await buildTikTokMarketIdeaContext(base(), input);
  const second = await buildTikTokMarketIdeaContext(base(), { references: [...input.references].reverse(), evidence: [...input.evidence].reverse() });
  assert.equal(first.context_hash, second.context_hash);
  assert.equal(first.MARKET_REFERENCE.references[0].market_dna_id, id(207));
});

test("market-only hypothesis remains HYPOTHESIS with LOW unproven confidence", async () => {
  const context = await buildTikTokMarketIdeaContext(base({ own: false }), marketInput());
  assert.equal(context.outcome, "HYPOTHESIS");
  assert.equal(context.MARKET_REFERENCE.confidence, "LOW");
  assert.equal(context.hypothesis_candidate.expected_effect, "UNKNOWN_UNTIL_OWN_EXPERIMENT");
});

test("current framework is mandatory and absence fails to non-market fallback", async () => {
  const data = base({ own: false }); data.OWN_PERFORMANCE.prompt_framework = null;
  const context = await buildTikTokMarketIdeaContext(data, marketInput());
  assert.equal(context.active, false);
  assert.equal(context.reason, "NO_ELIGIBLE_CURRENT_PROMPT_FRAMEWORK");
});

test("OWN CONFIRMED and SUPPORTED evidence outrank market-only evidence", async () => {
  assert.equal((await buildTikTokMarketIdeaContext(base(), marketInput())).MARKET_REFERENCE.confidence, "HIGH");
  assert.equal((await buildTikTokMarketIdeaContext(base({ confirmed: false }), marketInput())).MARKET_REFERENCE.confidence, "MEDIUM");
  assert.equal((await buildTikTokMarketIdeaContext(base({ own: false }), marketInput())).MARKET_REFERENCE.confidence, "LOW");
});

test("market versus own FAIL is preserved conservatively at variable level", async () => {
  const context = await buildTikTokMarketIdeaContext(base({ failedHook: true }), marketInput());
  assert.ok(context.conflicts.some((item) => item.conflict_type === "MARKET_VARIABLE_OWN_FAIL" &&
    item.resolution === "CONTROLLED_RETEST" && item.limitations.includes("NO_SEMANTIC_VALUE_MATCH")));
});

test("exact owner NOT_MY_STYLE conflict is preserved as AVOID", async () => {
  const input = marketInput();
  input.evidence[3] = dna(4, input.references[1].id,
    { hook_type: "обещание с немедленным визуальным нарушением" });
  const context = await buildTikTokMarketIdeaContext(base(), input);
  assert.ok(context.conflicts.some((item) => item.conflict_type === "OWNER_MARKET_EXACT_CONFLICT" &&
    item.resolution === "AVOID"));
  assert.ok(!context.MARKET_REFERENCE.references.some((row) => row.key === "M1"));
});

test("one material changed variable is preserved and other DNA fields are deferred", async () => {
  const input = marketInput();
  input.evidence[0] = dna(1, input.references[3].id, {
    hook_type: "абстрактный хук", pacing_profile: "ускорение к развязке", payoff: "визуальная инверсия",
  });
  const context = await buildTikTokMarketIdeaContext(base({ own: false }), input);
  assert.equal(context.hypothesis_candidate.changed_variable, "hook_type");
  assert.deepEqual(context.MARKET_REFERENCE.references.flatMap((row) => row.mechanics.map((item) => item.field)),
    ["hook_type", "hook_type"]);
  assert.ok(context.hypothesis_candidate.constants.held_constant_market_fields.includes("pacing_profile"));
  assert.ok(!context.hypothesis_candidate.constants.held_constant_market_fields.includes("hook_type"));
});

test("field priority precedes M1-M5 reference priority", async () => {
  const input = marketInput();
  input.evidence[0] = dna(1, input.references[3].id, { content_format: "короткий предметный диалог" });
  const context = await buildTikTokMarketIdeaContext(base({ own: false }), input);
  assert.equal(context.hypothesis_candidate.changed_variable, "hook_type");
  assert.equal(context.selected_mechanic.key, "M2");
});

test("anti-copy rejects source URLs, creator identity and copy instructions", async () => {
  for (const value of ["https://tiktok.com/@creator/video/1234567890123456789", "@creator hook",
    "Сделай точно как этот ролик", "Make it like this TikTok", "Replicate this TikTok verbatim"]) {
    const input = marketInput(); input.evidence[0] = dna(1, input.references[3].id, { hook_type: value });
    await assert.rejects(buildTikTokMarketIdeaContext(base(), input), /market_mechanic_anti_copy_rejected/);
  }
});

test("generation context contains abstractions but no source identifiers", async () => {
  const context = await buildTikTokMarketIdeaContext(base(), marketInput());
  const prompt = formatTikTokMarketIdeaPromptContext(context);
  assert.match(prompt, /MARKET_REFERENCE/);
  assert.doesNotMatch(prompt, /00000000-|https?:|tiktok\.com|@\w+/i);
});

test("candidate guard rejects source URL and creator identity leakage", async () => {
  const context = await buildTikTokMarketIdeaContext(base(), marketInput());
  const withUrl = candidates(); withUrl[0].prompt = "Use https://tiktok.com/source";
  assert.throws(() => validateTikTokMarketCandidates(withUrl, context), /market_candidate_identity_leak/);
  const withCreator = candidates(); withCreator[0].prompt = "Use @creator identity";
  assert.throws(() => validateTikTokMarketCandidates(withCreator, context), /market_candidate_identity_leak/);
  const copy = candidates(); copy[0].why_this_idea = "Сделай точно как этот TikTok";
  assert.throws(() => validateTikTokMarketCandidates(copy, context), /market_candidate_identity_leak/);
  const englishCopy = candidates(); englishCopy[0].line = "Make it like this TikTok";
  assert.throws(() => validateTikTokMarketCandidates(englishCopy, context), /market_candidate_identity_leak/);
});

test("candidate conflicts match both market key and selected variable", async () => {
  const data = base();
  data.OWN_PERFORMANCE.recent_results = [{
    experiment_id: id(13), result: "FAIL", changed_variable: "camera_profile",
  }];
  const input = marketInput();
  input.evidence[0] = dna(1, input.references[3].id, {
    hook_type: "обещание с визуальным нарушением", camera_pattern: "резкий поворот камеры",
  });
  const context = await buildTikTokMarketIdeaContext(data, input);
  const [candidate] = validateTikTokMarketCandidates(candidates(), context);
  assert.equal(context.hypothesis_candidate.changed_variable, "hook_type");
  assert.deepEqual(candidate.evidence_conflicts, []);
});

test("diversity guard limits one market DNA family to two candidates", async () => {
  const context = await buildTikTokMarketIdeaContext(base(), marketInput());
  const repeated = candidates().map((item) => ({ ...item, market_mechanic_key: "M1" }));
  assert.throws(() => validateTikTokMarketCandidates(repeated, context), /market_candidate_diversity_violation/);
});

test("candidate provenance persists three distinct roots and internal IDs", async () => {
  const context = await buildTikTokMarketIdeaContext(base(), marketInput());
  const [candidate] = validateTikTokMarketCandidates(candidates(), context);
  assert.deepEqual(Object.keys(candidate.evidence_roots).sort(),
    ["MARKET_REFERENCE", "OWNER_PREFERENCE", "OWN_PERFORMANCE"]);
  assert.equal(candidate.market_reference_ids.length, 1);
  assert.equal(candidate.market_dna_ids.length, 1);
  assert.ok(candidate.own_lesson_ids.length > 0);
  assert.ok(candidate.owner_preference_ids.length > 0);
  assert.deepEqual(Object.keys(candidate.evidence_conflicts[0] ?? {}).sort(),
    candidate.evidence_conflicts.length ? ["confidence", "conflict_type", "limitations", "market_dna_ids",
      "market_reference_ids", "own_evidence_ids", "owner_preference_ids", "resolution"] : []);
  assert.deepEqual(validateTikTokMarketCandidates(candidates(), context)[2].evidence_conflicts, []);
});

test("batch key binds the accepted POST-04 key to the market context hash", async () => {
  const one = await marketFeedbackBatchKey(hash("b"), hash("c"));
  const replay = await marketFeedbackBatchKey(hash("b"), hash("c"));
  const changed = await marketFeedbackBatchKey(hash("b"), hash("d"));
  assert.equal(one, replay); assert.notEqual(one, changed);
});

test("production wiring uses the sole existing feedback builder and market-aware wrapper", () => {
  const source = readFileSync(suggestPath, "utf8");
  assert.match(source, /buildTikTokFeedbackContext/);
  assert.match(source, /buildTikTokMarketIdeaContext/);
  assert.match(source, /persist_tiktok_market_feedback_batch/);
  assert.match(source, /marketFeedbackBatchKey/);
  assert.doesNotMatch(source.slice(source.indexOf("async function loadTikTokMarketInputs"),
    source.indexOf("async function loadYoutubeFeedbackInputs")), /\.limit\(5\)/);
});

test("migration adds provenance only and creates no duplicate store", () => {
  const source = readFileSync(migrationPath, "utf8");
  assert.doesNotMatch(source, /create\s+table/i);
  assert.match(source, /alter table public\.video_ideas/i);
  assert.match(source, /market_dna_ids/);
  assert.match(source, /persist_tiktok_market_feedback_batch/);
  assert.match(source, /jsonb_has_exact_keys/);
  assert.match(source, /jsonb_has_exact_keys\(c->'evidence_roots'->'MARKET_REFERENCE'/);
  assert.match(source, /market_api_metric_owner_conflict/);
  assert.match(source, /'api_metric_snapshot_ids'/);
  assert.match(source, /p_hypothesis->'feedback_context' is distinct from p_market_context/);
  assert.doesNotMatch(source, /insert into public\.(?:content_lessons|content_analysis_results|experiments)/i);
});

test("market provenance cannot create a verdict or lesson", () => {
  const source = readFileSync(migrationPath, "utf8");
  assert.doesNotMatch(source, /\b(?:PASS|FAIL|CONFIRMED|SUPPORTED|REJECTED)\b/);
  assert.doesNotMatch(source, /insert into public\.content_lessons/i);
});

test("owner approval remains before both prompt persistence and paid start", () => {
  const source = readFileSync(buttonPath, "utf8");
  const paid = source.slice(source.indexOf('if (action === "pay")'));
  const provenance = paid.indexOf('persist_tiktok_prompt_provenance_v2');
  assert.ok(source.indexOf('decided_at: new Date().toISOString()') < source.indexOf('if (action === "pay")'));
  assert.ok(provenance >= 0 && provenance < paid.indexOf('await запустить("veo-start")'));
});

test("selected owner task uses the fail-closed prompt provenance wrapper", () => {
  const source = readFileSync(tasksPath, "utf8");
  assert.match(source, /rpc\/persist_tiktok_prompt_provenance_v2/);
  assert.ok(source.indexOf("persist_tiktok_prompt_provenance_v2") < source.indexOf("await бот(блок"));
});

test("prompt wrapper preserves internal provenance but rejects source identity", () => {
  const source = readFileSync(migrationPath, "utf8");
  assert.match(source, /market_candidate_identity_leak/);
  assert.match(source, /market_reference_ids/);
  assert.match(source, /market_dna_ids/);
  assert.match(source, /owner_selected_at/);
});

test("deterministic E2E reaches three candidates and simulated selected prompt provenance", async () => {
  const context = await buildTikTokMarketIdeaContext(base({ own: false }), marketInput());
  const generated = validateTikTokMarketCandidates(candidates(), context);
  const selected = { ...generated[0], status: "approved", route: "self",
    decided_at: "2026-08-31T12:00:00Z" };
  const promptRecord = {
    prompt_hash: hash("e"), video_idea_id: id(999), owner_selected_at: selected.decided_at,
    market_reference_ids: selected.market_reference_ids,
    market_dna_ids: selected.market_dna_ids,
    evidence_roots: selected.evidence_roots,
  };
  assert.equal(generated.length, 3);
  assert.equal(context.hypothesis_candidate.changed_variable, "hook_type");
  assert.equal(selected.route, "self");
  assert.deepEqual(promptRecord.market_reference_ids, generated[0].market_reference_ids);
  assert.doesNotMatch(JSON.stringify(generated.map((item) => item.prompt)), /https?:|tiktok\.com|@creator/i);
  assert.ok(!JSON.stringify(context).includes('"conclusion":"PASS"'));
});
