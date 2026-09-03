import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compactYoutubeHistory,
  normalizeIdeaText,
  validateYoutubeNovelIdeas,
  youtubeIdeaCollision,
} from "../supabase/functions/_shared/youtube-idea-novelty.mjs";

const reference = {
  reference_source_id: "ref-1",
  causal_pattern: { pattern_class: "SAME_PROP_SUDDEN_PHYSICAL_DESTRUCTION" },
};

const fresh = {
  reference_id: "ref-1",
  causal_pattern_class: "SAME_PROP_SUDDEN_PHYSICAL_DESTRUCTION",
  slug: "novaya-ideya",
  animal: "выдра",
  hook: "ЧЕК ТОЧНО ВЫЖИВЕТ?",
  line: "Берегу чек от трат. Касса решила иначе.",
  prompt: "The same receipt is protected twice, then that exact receipt is suddenly shredded.",
};

test("normalization catches punctuation, case and Russian yo differences", () => {
  assert.equal(normalizeIdeaText("  ЁЖ: ПЛАТИТ?! "), "еж платит");
});

test("exact old hook cannot return as a new YouTube idea", () => {
  const collision = youtubeIdeaCollision(
    { ...fresh, slug: "other", hook: "чек точно выживет!!!" },
    [fresh],
  );
  assert.equal(collision, "hook");
});

test("validator preserves trusted reference order", () => {
  const control = {
    reference_id: "CONTROL",
    causal_pattern_class: "CONTROL",
    slug: "control-new",
    animal: "сурок",
    hook: "ЗАРПЛАТА ЕЩЁ ЗДЕСЬ?",
    line: "Зарплата пришла. Я даже не успел поздороваться.",
    prompt: "Current house-format money interview, with no reference-derived mechanism.",
  };
  const result = validateYoutubeNovelIdeas(
    [control, fresh],
    [reference, { reference_source_id: "CONTROL" }],
    [],
  );
  assert.deepEqual(result.map((idea) => idea.reference_id), ["ref-1", "CONTROL"]);
});

test("wrong causal pattern is rejected", () => {
  assert.throws(
    () => validateYoutubeNovelIdeas([{ ...fresh, causal_pattern_class: "OTHER" }], [reference], []),
    /causal_pattern_mismatch/,
  );
});

test("already delivered idea is rejected before Telegram", () => {
  assert.throws(
    () => validateYoutubeNovelIdeas([fresh], [reference], [{ ...fresh }]),
    /youtube_idea_duplicate_/,
  );
});

test("history sent to the model is compacted and de-duplicated", () => {
  const result = compactYoutubeHistory([fresh, { ...fresh }, { ...fresh, hook: "ДРУГОЙ ХУК" }]);
  assert.equal(result.length, 2);
  assert.equal(result[0].concept_prompt, fresh.prompt);
});

test("database trigger is the final concurrent duplicate guard", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/20260903000003_youtube_idea_no_repeat.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /youtube_idea_duplicate/);
  assert.match(sql, /before insert on public\.video_ideas/);
});
