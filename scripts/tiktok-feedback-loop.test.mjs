import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MATERIAL_FIELDS,
  buildTikTokFeedbackContext,
  canonicalJson,
  feedbackBatchKey,
  formatTikTokFeedbackPromptContext,
  ideaPattern,
  normalizeIdeaText,
  validateTikTokCandidates,
} from "../supabase/functions/_shared/tiktok-feedback-context.mjs";

const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const iso = (day) => `2026-08-${String(day).padStart(2, "0")}T00:00:00Z`;

function fixture() {
  const passIds = [id(101), id(102), id(103)];
  const failIds = [id(201), id(202)];
  const experiments = [
    ...passIds.map((experimentId, index) => ({
      id: experimentId,
      changed_variable: index === 2 ? "hook_type" : "content_format",
      constants: index === 2 ? { character_id: "fox", pacing_profile: "fast" } : { family: "money" },
      success_metrics: {
        primary_metric: "share_rate", direction: "increase", checkpoint: "24h", mde: 0.02,
      },
      status: "ANALYZED",
      result: "PASS",
      created_at: iso(10 + index),
      updated_at: iso(20 + index),
    })),
    ...failIds.map((experimentId, index) => ({
      id: experimentId,
      changed_variable: "camera_profile",
      constants: { camera_profile: "static", failed_context: index },
      success_metrics: {
        primary_metric: "like_rate", direction: "increase", checkpoint: "24h", mde: 0.01,
      },
      status: "ANALYZED",
      result: "FAIL",
      created_at: iso(5 + index),
      updated_at: iso(15 + index),
    })),
    {
      id: id(301), changed_variable: "duration_bin", constants: {}, status: "ANALYZED",
      result: "PASS", success_metrics: {
        primary_metric: "like_rate", direction: "increase", checkpoint: "24h", mde: 0.01,
      }, created_at: iso(25), updated_at: iso(25),
    },
    {
      id: id(104), changed_variable: "hook_type", constants: { character_id: "fox" },
      status: "RUNNING", result: "INCONCLUSIVE", success_metrics: {
        primary_metric: "share_rate", direction: "increase", checkpoint: "24h", mde: 0.02,
      }, created_at: iso(26), updated_at: iso(26),
    },
  ];
  const analyses = experiments.map((experiment, index) => ({
    id: id(400 + index),
    experiment_id: experiment.id,
    conclusion: experiment.result,
    created_at: iso(10 + index),
  }));
  const lessons = [
    {
      id: id(1), lesson: "Короткий контрастный хук работает", category: "WINNING_PATTERN",
      status: "CONFIRMED", confidence: "HIGH", updated_at: iso(29),
      applicable_topics: [], videos_used: [id(701)],
      evidence: [...passIds, id(104)].map((experiment_id) => ({ experiment_id })),
    },
    {
      id: id(2), lesson: "Поддержанный формат", category: "CONFIRMED_LESSON",
      status: "SUPPORTED", confidence: "HIGH", updated_at: iso(30),
      applicable_topics: [], videos_used: [id(702)],
      evidence: passIds.slice(0, 2).map((experiment_id) => ({ experiment_id })),
    },
    {
      id: id(3), lesson: "Не использовать неподвижную камеру", category: "FAILED_PATTERN",
      status: "REJECTED", confidence: "MEDIUM", updated_at: iso(28),
      applicable_topics: [], videos_used: [id(703)],
      evidence: failIds.map((experiment_id) => ({ experiment_id })),
    },
    {
      id: id(4), lesson: "Одиночное наблюдение", category: "HYPOTHESIS",
      status: "HYPOTHESIS", confidence: "LOW", updated_at: iso(30),
      applicable_topics: [], evidence: [{ experiment_id: passIds[0] }],
    },
    {
      id: id(5), lesson: "Только ипотека", category: "WINNING_PATTERN",
      status: "SUPPORTED", confidence: "HIGH", updated_at: iso(30),
      applicable_topics: ["ипотека"], evidence: passIds.slice(0, 2).map((experiment_id) => ({ experiment_id })),
    },
    {
      id: id(6), lesson: "Несовместимая категория", category: "FAILED_PATTERN",
      status: "SUPPORTED", confidence: "HIGH", updated_at: iso(30),
      applicable_topics: [], evidence: passIds.slice(0, 2).map((experiment_id) => ({ experiment_id })),
    },
  ];
  const framework = {
    id: id(800), version_label: "PF-v1", status: "STANDARD", is_current: true,
    prompt_framework_rules: [
      { id: id(801), status: "STANDARD", confidence: "HIGH", updated_at: iso(20) },
      { id: id(802), status: "SUPPORTED", confidence: "MEDIUM", updated_at: iso(21) },
      { id: id(803), status: "REJECTED", confidence: "HIGH", updated_at: iso(30) },
    ],
  };
  const ideas = [
    { id: id(901), target_platform: "tiktok", status: "done", route: "self",
      decided_at: iso(30), created_at: iso(20), animal: "Лиса", hook: "ГДЕ ДЕНЬГИ?",
      changed_variable: "hook_type", idea_pattern: ideaPattern("Лиса", "ГДЕ ДЕНЬГИ?") },
    { id: id(902), target_platform: "tiktok", status: "rejected", route: null,
      decided_at: iso(29), created_at: iso(19), animal: "Крот", hook: "СНОВА КРЕДИТ?" },
    { id: id(903), target_platform: "tiktok", status: "new", route: null,
      decided_at: null, created_at: iso(30), animal: "Сова", hook: "НОВЫЙ?" },
    { id: id(904), target_platform: "youtube_shorts", status: "approved", route: "self",
      decided_at: iso(30), created_at: iso(30), animal: "Бобр", hook: "YOUTUBE" },
  ];
  return {
    lessons, experiments, analyses, hypotheses: [], framework, ideas,
    snapshots: [{ id: id(950), video_id: id(701), collected_at: iso(30), source: "api",
      views: 1000, likes: 100, comments: 20, shares: 30 }],
    studio_metrics: [{ id: id(951), video_id: id(701), captured_at: iso(30),
      updated_at: iso(30), source: "manual_tiktok_studio", saves: 40,
      average_retention_percent: null }],
  };
}

function candidates() {
  return [
    { slug: "fox-budget", animal: "Лиса", hook: "БЮДЖЕТ СБЕЖАЛ?", line: "Он просто пошёл искать доход.",
      prompt: "existing tuned production prompt content", why_this_idea: "Uses confirmed hook lesson." },
    { slug: "owl-card", animal: "Сова", hook: "КАРТА ОБИДЕЛАСЬ?", line: "Ей снова урезали лимит.",
      prompt: "second existing tuned production prompt content", why_this_idea: "Keeps constants and varies the hook." },
  ];
}

test("selected lessons use exact category/status/conclusion eligibility and priority", async () => {
  const context = await buildTikTokFeedbackContext(fixture());
  assert.equal(context.outcome, "HYPOTHESIS");
  assert.deepEqual(context.OWN_PERFORMANCE.selected_lessons.map((row) => row.lesson_id), [id(1), id(2)]);
  assert.ok(!context.OWN_PERFORMANCE.selected_lessons.some((row) => [id(4), id(6)].includes(row.lesson_id)));
  assert.equal(context.OWN_PERFORMANCE.selected_lessons[0].lesson, "Короткий контрастный хук работает");
  assert.ok(context.OWN_PERFORMANCE.selected_lessons.every((row) =>
    row.conclusive_evidence.every((evidence) => evidence.latest_conclusion === "PASS")));
  assert.ok(!canonicalJson(context.OWN_PERFORMANCE.selected_lessons).includes(id(104)));
});

test("rejected lessons are separate avoidance evidence and never positive guidance", async () => {
  const context = await buildTikTokFeedbackContext(fixture());
  assert.deepEqual(context.OWN_PERFORMANCE.avoided_lessons.map((row) => row.lesson_id), [id(3)]);
  assert.ok(!context.OWN_PERFORMANCE.selected_lessons.some((row) => row.lesson_id === id(3)));
  assert.ok(context.OWN_PERFORMANCE.avoided_lessons.every((row) =>
    row.conclusive_evidence.every((evidence) => evidence.latest_conclusion === "FAIL")));
  const prompt = formatTikTokFeedbackPromptContext(context);
  assert.match(prompt, /OWN_PERFORMANCE=/);
  assert.match(prompt, /OWNER_PREFERENCE=/);
  assert.match(prompt, /avoidance/);
});

test("no topic excludes topic-specific lessons; exact topic admits them", async () => {
  const withoutTopic = await buildTikTokFeedbackContext(fixture());
  assert.ok(!withoutTopic.OWN_PERFORMANCE.selected_lessons.some((row) => row.lesson_id === id(5)));
  const withTopic = await buildTikTokFeedbackContext({ ...fixture(), topic: " ИПОТЕКА " });
  assert.ok(withTopic.OWN_PERFORMANCE.selected_lessons.some((row) => row.lesson_id === id(5)));
});

test("framework selection keeps only current STANDARD/SUPPORTED rules", async () => {
  const context = await buildTikTokFeedbackContext(fixture());
  assert.deepEqual(context.OWN_PERFORMANCE.prompt_framework.rule_ids, [id(801), id(802)]);
  const noFramework = await buildTikTokFeedbackContext({
    ...fixture(), framework: { ...fixture().framework, status: "UNDER_REVIEW" },
  });
  assert.equal(noFramework.outcome, "NO_STRONG_HYPOTHESIS");
});

test("primary experiment preserves one allowed changed variable and exact constants", async () => {
  const context = await buildTikTokFeedbackContext(fixture());
  assert.equal(context.hypothesis_candidate.changed_variable, "hook_type");
  assert.deepEqual(context.hypothesis_candidate.constants, { character_id: "fox", pacing_profile: "fast" });
  assert.equal(MATERIAL_FIELDS.length, 10);
  assert.ok(!MATERIAL_FIELDS.includes("duration_bin"));
});

test("owner decisions stay separate from performance and advanced statuses remain preferences", async () => {
  const context = await buildTikTokFeedbackContext(fixture());
  assert.deepEqual(context.OWNER_PREFERENCE.approved.map((row) => row.idea_id), [id(901)]);
  assert.deepEqual(context.OWNER_PREFERENCE.rejected.map((row) => row.idea_id), [id(902)]);
  assert.ok(!canonicalJson(context.OWN_PERFORMANCE).includes(id(902)));
});

test("missing metrics stay UNKNOWN and INCONCLUSIVE evidence is not promoted", async () => {
  const data = fixture();
  data.analyses.push({ id: id(499), experiment_id: id(999), conclusion: "INCONCLUSIVE", created_at: iso(30) });
  const context = await buildTikTokFeedbackContext(data);
  const missing = context.OWN_PERFORMANCE.current_metrics.find((row) => row.video_id === id(702));
  assert.equal(missing.views, "UNKNOWN");
  assert.equal(missing.retention, "UNKNOWN");
  assert.ok(!context.OWN_PERFORMANCE.recent_results.some((row) => row.result === "INCONCLUSIVE"));
});

test("hypothesis identity ignores metric refresh while context hash records it", async () => {
  const first = await buildTikTokFeedbackContext(fixture());
  const changed = fixture();
  changed.snapshots[0] = { ...changed.snapshots[0], id: id(952), views: 2500, collected_at: "2026-08-31T01:00:00Z" };
  const second = await buildTikTokFeedbackContext(changed);
  assert.equal(first.hypothesis_key, second.hypothesis_key);
  assert.notEqual(first.context_hash, second.context_hash);
});

test("zero eligible evidence returns NO_STRONG_HYPOTHESIS without invented provenance", async () => {
  const data = fixture();
  data.lessons = data.lessons.filter((lesson) => lesson.status === "HYPOTHESIS");
  const context = await buildTikTokFeedbackContext(data);
  assert.equal(context.outcome, "NO_STRONG_HYPOTHESIS");
  assert.equal(context.hypothesis_key, null);
  assert.equal(context.hypothesis_candidate, null);
});

test("verified rejected signature blocks a repeated hypothesis", async () => {
  const data = fixture();
  data.hypotheses = [{
    id: id(990), status: "REJECTED", changed_variable: "hook_type",
    constants: { character_id: "fox", pacing_profile: "fast" },
  }];
  const context = await buildTikTokFeedbackContext(data);
  assert.equal(context.outcome, "HYPOTHESIS");
  assert.notEqual(context.hypothesis_candidate.changed_variable, "hook_type");
});

test("candidate validation rejects same-batch and recent-history duplicates", async () => {
  const context = await buildTikTokFeedbackContext(fixture());
  const valid = validateTikTokCandidates(candidates(), context);
  assert.equal(valid.length, 2);
  assert.equal(valid[0].idea_pattern, normalizeIdeaText("Лиса") + "|" + normalizeIdeaText("БЮДЖЕТ СБЕЖАЛ?"));
  assert.throws(() => validateTikTokCandidates([candidates()[0], candidates()[0]], context), /duplicate_candidate_pattern/);
  const recentDuplicate = [{ ...candidates()[0], hook: "ГДЕ   ДЕНЬГИ?" }];
  assert.throws(() => validateTikTokCandidates(recentDuplicate, context), /duplicate_candidate_pattern/);
  const legacyOwnerDecision = [{ ...candidates()[0], animal: "Крот", hook: "СНОВА КРЕДИТ?" }];
  assert.throws(() => validateTikTokCandidates(legacyOwnerDecision, context), /duplicate_candidate_pattern/);
});

test("batch replay key is stable and explicit more is distinct", async () => {
  const first = await feedbackBatchKey(id(999), "telegram:callback-1");
  assert.equal(first, await feedbackBatchKey(id(999), "telegram:callback-1"));
  assert.notEqual(first, await feedbackBatchKey(id(999), "telegram:callback-2"));
});

test("migration is additive, owner-scoped, immutable and idempotent", () => {
  const sql = readFileSync("supabase/migrations/20260831000002_tiktok_feedback_loop.sql", "utf8");
  assert.doesNotMatch(sql, /\b(?:drop table|truncate|delete from)\b/i);
  assert.match(sql, /alter column video_id drop not null/i);
  assert.match(sql, /claude_tasks_idea_owner_fk/i);
  assert.match(sql, /video_ideas_feedback_hypothesis_owner_fk/i);
  assert.match(sql, /feedback_provenance_service_owned/i);
  assert.match(sql, /feedback_provenance_immutable/i);
  assert.match(sql, /prompt_provenance_immutable/i);
  assert.match(sql, /video_prompt_records_prepublication_complete_check/i);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /revoke execute[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /feedback_batch_conflict/i);
  assert.match(sql, /'feedback_context', p_feedback_context/i);
  assert.match(sql, /'hypothesis_evidence', p_hypothesis_evidence/i);
  assert.match(sql, /prompt_provenance_conflict/i);
  assert.doesNotMatch(sql, /create table public\.(?:creative_memory|experiments|content_lessons)/i);
});

test("production wiring preserves owner authority and gates paid start on provenance", () => {
  const suggest = readFileSync("supabase/functions/suggest-ideas/index.ts", "utf8");
  assert.match(suggest, /callerIsServiceRole/);
  assert.match(suggest, /vibepost_content_brigade_owner/);
  assert.match(suggest, /buildTikTokFeedbackContext/);
  assert.match(suggest, /persist_tiktok_feedback_batch/);
  assert.match(suggest, /const TIKTOK_SCHEMA/);
  assert.doesNotMatch(suggest, /const СХЕМА/);
  assert.match(suggest, /collectPages/);
  assert.match(suggest, /\.in\("experiment_id", ids\)/);
  assert.match(suggest, /\.in\("video_id", ids\)/);
  assert.doesNotMatch(suggest, /\.not\("error_notify_tg_id", "is", null\)\s*\.limit\(1\)/);

  const buttons = readFileSync("supabase/functions/idea-button/index.ts", "utf8");
  for (const label of ["🖐 Сделаю сама", "💸 Сгенерируй", "🔄 Другое", "🗑 Мимо"]) {
    assert.ok(readFileSync("supabase/functions/suggest-ideas/index.ts", "utf8").includes(label));
  }
  const paid = buttons.slice(buttons.indexOf('if (action === "pay")'));
  assert.ok(paid.indexOf("persist_tiktok_prompt_provenance") < paid.indexOf('запустить("veo-start")'));
  const edit = buttons.slice(buttons.indexOf('if (action === "edit")'), buttons.indexOf('if (action === "more")'));
  assert.doesNotMatch(edit, /from\("claude_tasks"\)/);
  assert.match(edit, /\.select\("id"\)\.maybeSingle\(\)/);
  assert.match(edit, /if \(!edited\)/);
  assert.match(buttons, /prompt_task_kind: "SELECTED_PROMPT"/);
  assert.match(buttons, /onConflict: "user_id,idea_id,prompt_task_kind"/);
  assert.match(buttons, /feedbackEvidenceContext/);
  assert.match(buttons, /selected_lessons/);
  assert.match(buttons, /avoided_patterns/);
});

test("YouTube response contract stays outside TikTok feedback additions", () => {
  const suggest = readFileSync("supabase/functions/suggest-ideas/index.ts", "utf8");
  const rowBlock = suggest.slice(suggest.indexOf("const rows:"), suggest.indexOf("if (previewOnly)"));
  assert.match(rowBlock, /targetPlatform === TARGET_PLATFORMS\.TIKTOK/);
  assert.match(rowBlock, /why_this_idea/);
  const youtubeBranch = suggest.slice(
    suggest.indexOf("if (targetPlatform === TARGET_PLATFORMS.YOUTUBE_SHORTS)"),
    suggest.indexOf("} else {", suggest.indexOf("if (targetPlatform === TARGET_PLATFORMS.YOUTUBE_SHORTS)")),
  );
  assert.doesNotMatch(youtubeBranch, /TIKTOK_SCHEMA|why_this_idea|feedbackContext/);
});

test("prompt save path records TikTok provenance and leaves YouTube path existing", () => {
  const tasks = readFileSync("scripts/задания.mjs", "utf8");
  assert.match(tasks, /persist_tiktok_prompt_provenance/);
  assert.match(tasks, /p_mode: 'CLAUDE_TASK'/);
  assert.match(tasks, /createHash\('sha256'\)/);
  assert.match(tasks, /targetPlatform === 'tiktok'/);
  assert.match(tasks, /video_ideas\?id=eq\.\$\{task\.idea_id\}/);
});

test("fixture E2E reaches an owner-selected prompt record with complete provenance", async () => {
  const context = await buildTikTokFeedbackContext(fixture());
  const generated = validateTikTokCandidates(candidates(), context);
  const hypothesis = {
    id: id(1001), status: "HYPOTHESIS", hypothesis_key: context.hypothesis_key,
    ...context.hypothesis_candidate,
  };
  const idea = {
    id: id(1002), status: "new", hypothesis_id: hypothesis.id,
    selected_lesson_ids: context.OWN_PERFORMANCE.selected_lessons.map((row) => row.lesson_id),
    avoided_lesson_ids: context.OWN_PERFORMANCE.avoided_lessons.map((row) => row.lesson_id),
    changed_variable: hypothesis.changed_variable, constants: hypothesis.constants,
    prompt_framework_id: context.OWN_PERFORMANCE.prompt_framework.id,
    ...generated[0],
  };
  const selected = { ...idea, status: "approved", route: "self", decided_at: iso(31) };
  const promptRecord = {
    id: id(1003), video_idea_id: selected.id, hypothesis_id: selected.hypothesis_id,
    selected_lesson_ids: selected.selected_lesson_ids,
    avoided_lesson_ids: selected.avoided_lesson_ids,
    changed_variable: selected.changed_variable, experiment_constants: selected.constants,
    prompt_framework_id: selected.prompt_framework_id,
  };
  assert.equal(promptRecord.hypothesis_id, hypothesis.id);
  assert.deepEqual(promptRecord.selected_lesson_ids, [id(1), id(2)]);
  assert.deepEqual(promptRecord.avoided_lesson_ids, [id(3)]);
  assert.equal(promptRecord.changed_variable, "hook_type");
  assert.equal(selected.status, "approved");
});
