import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildCausalReviewPrompt,
  buildFastReviewPrompt,
  CAUSAL_REVIEW_SCHEMA,
  executeCausalEnrichment,
  FAST_REVIEW_SCHEMA,
  hasCausalPattern,
} from "../supabase/functions/video-from-bot/review-contract.mjs";

const root = new URL("..", import.meta.url);
const current = readFileSync(
  new URL("supabase/functions/video-from-bot/index.ts", root),
  "utf8",
);
const baselineBytes = execFileSync("git", [
  "show",
  "video-from-bot-v21-backup-20260903:supabase/functions/video-from-bot/index.ts",
], { cwd: decodeURIComponent(root.pathname.replace(/^\//, "")) });
const baseline = baselineBytes.toString("utf8");

function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0, `start marker not found: ${start}`);
  assert.ok(to >= 0, `end marker not found: ${end}`);
  return source.slice(from, to + end.length);
}

test("V21 backup is exact, byte-identifiable and rollback-ready", () => {
  assert.equal(
    createHash("sha256").update(baselineBytes).digest("hex"),
    "4568da388105f5d8d11ee613b7b0714166d118ad631841cd823c3739c5514600",
  );
  assert.match(
    readFileSync(
      new URL(
        "supabase/functions/video-from-bot/video-from-bot.v21.backup.txt",
        root,
      ),
      "utf8",
    ),
    /video-from-bot-v21-backup-20260903/,
  );
});

test("FAST review has only owner-facing fields and no causal instructions", () => {
  assert.deepEqual(
    Object.keys(FAST_REVIEW_SCHEMA.properties),
    ["review", "ok", "speech", "tag", "hooks"],
  );
  assert.deepEqual(FAST_REVIEW_SCHEMA.required, [
    "review",
    "ok",
    "speech",
    "tag",
    "hooks",
  ]);
  const prompt = buildFastReviewPrompt({
    targetPlatformLabel: "YouTube Shorts",
    ideaContext: "Задумка была такая. Герой: лиса.",
  });
  assert.match(prompt, /YouTube Shorts/);
  assert.match(prompt, /РЕПЛИКА/);
  assert.match(prompt, /ПЯТЬ ЗАГОЛОВКОВ/);
  assert.doesNotMatch(
    prompt,
    /causal_pattern|causal pattern|TRUSTED ABSTRACT/i,
  );
  const fastFunction = sliceBetween(
    current,
    "async function разобрать(",
    "/** Проверяет только causal pattern",
  );
  assert.match(fastFunction, /temperature:\s*0\.5/);
  assert.doesNotMatch(
    fastFunction,
    /buildCausalReviewPrompt|CAUSAL_REVIEW_SCHEMA/,
  );
});

test("A: causal video sends owner review before scheduling one causal call", async () => {
  let analyzeCalls = 0;
  let persistCalls = 0;
  const result = await executeCausalEnrichment({
    analyze: async () => {
      analyzeCalls++;
      return JSON.stringify({ causal_pattern_preserved: "YES" });
    },
    persist: async (value) => {
      persistCalls++;
      assert.equal(value, "YES");
      return true;
    },
  });
  assert.deepEqual(result, { outcome: "UPDATED", value: "YES" });
  assert.equal(analyzeCalls, 1);
  assert.equal(persistCalls, 1);

  const ownerSend = current.indexOf(
    "const ownerResponse = await ответить(текст)",
  );
  const causalStart = current.indexOf(
    "const causalTask = executeCausalEnrichment",
  );
  const waitUntil = current.indexOf("EdgeRuntime.waitUntil(causalTask)");
  assert.ok(
    ownerSend >= 0 && ownerSend < causalStart && causalStart < waitUntil,
  );
});

test("B: absent or empty causal pattern produces zero secondary calls", async () => {
  let calls = 0;
  for (const pattern of [null, undefined, {}, []]) {
    if (hasCausalPattern(pattern)) {
      calls++;
      await executeCausalEnrichment({
        analyze: async () => ({}),
        persist: async () => true,
      });
    }
  }
  assert.equal(calls, 0);
  assert.equal(hasCausalPattern({ pattern_class: "TEST" }), true);
  assert.match(current, /if \(causalPattern && incomingVideoId\)/);
});

test("C: causal Gemini failure is bounded and does not persist", async () => {
  let persisted = false;
  let failures = 0;
  const result = await executeCausalEnrichment({
    analyze: async () => {
      throw new Error("provider unavailable");
    },
    persist: async () => {
      persisted = true;
      return true;
    },
    onFailure: async () => {
      failures++;
    },
  });
  assert.deepEqual(result, { outcome: "FAILED", value: null });
  assert.equal(persisted, false);
  assert.equal(failures, 1);
});

test("D: stale/reworked target cannot be reported as updated", async () => {
  const result = await executeCausalEnrichment({
    analyze: async () => ({ causal_pattern_preserved: "NO" }),
    persist: async () => false,
  });
  assert.deepEqual(result, { outcome: "STALE", value: "NO" });
  const persistBlock = sliceBetween(
    current,
    "persist: async (value: CausalReview)",
    '.select("id");',
  );
  assert.match(persistBlock, /\.eq\("id", incomingVideoId\)/);
  assert.match(persistBlock, /\.eq\("video_url", videoUrl\)/);
});

test("E: malformed causal response fails bounded and cannot update storage", async () => {
  let persisted = false;
  const result = await executeCausalEnrichment({
    analyze: async () => '{"causal_pattern_preserved":"MAYBE"}',
    persist: async () => {
      persisted = true;
      return true;
    },
  });
  assert.deepEqual(result, { outcome: "FAILED", value: null });
  assert.equal(persisted, false);
  assert.deepEqual(
    CAUSAL_REVIEW_SCHEMA.properties.causal_pattern_preserved.enum,
    ["YES", "NO", "UNCERTAIN"],
  );
});

test("F: Telegram download and Storage upload path are byte-equivalent to V21", () => {
  const start = "const info = await (await fetch(";
  const end =
    'const videoUrl = admin.storage.from("post-photos").getPublicUrl(key).data.publicUrl;';
  assert.equal(
    normalize(sliceBetween(current, start, end)),
    normalize(sliceBetween(baseline, start, end)),
  );
});

test("G: incoming_videos base create/update contract remains intact", () => {
  for (
    const required of [
      "video_url: videoUrl",
      "raw_video_url: videoUrl",
      'status: "new"',
      "review: разбор.review",
      "tag: разбор.tag?.slice(0, 40) || null",
      "ready: false",
    ]
  ) {
    assert.ok(
      current.includes(required),
      `missing incoming field: ${required}`,
    );
  }
  assert.match(
    current,
    /\.insert\([\s\S]*?\)\.select\("id"\)\.maybeSingle\(\)/,
  );
  assert.match(
    current,
    /causal_pattern_review: causalPattern \? null : "UNCERTAIN"/,
  );
  const updateBlock = sliceBetween(
    current,
    'const { error: updateError } = await admin.from("incoming_videos").update({',
    "incomingVideoId = открытая.id;",
  );
  assert.doesNotMatch(updateBlock, /last_activity_at:/);
  assert.match(updateBlock, /if \(updateError\) throw new Error/);
  assert.match(current, /if \(insertError \|\| !inserted\?\.id\)/);
});

test("H: rework lookup, card identity and replacement notice stay unchanged", () => {
  const lookupStart = "if (idea?.id) {";
  const lookupEnd = "открытая = data;\n    }";
  assert.equal(
    normalize(sliceBetween(current, lookupStart, lookupEnd)),
    normalize(sliceBetween(baseline, lookupStart, lookupEnd)),
  );
  for (
    const invariant of [
      '.eq("idea_id", idea.id).in("status", ["new", "rework"])',
      "polished_at: null",
      "rework_at: null",
      "measure_avg: null, measure_worst: null, measure_cuts: null",
      "Переделка принята:",
      "название и описание сохранены, титры перевешу.",
    ]
  ) {
    assert.ok(
      current.includes(invariant),
      `missing rework invariant: ${invariant}`,
    );
  }
});

test("timing logs are bounded and do not include content or credentials", () => {
  for (
    const field of [
      "FAST_REVIEW_MS",
      "TELEGRAM_SEND_MS",
      "CAUSAL_REVIEW_MS",
      "TOTAL_FUNCTION_MS",
    ]
  ) assert.ok(current.includes(field), `missing timing field: ${field}`);
  const timingRegion = current.slice(
    current.indexOf('logTiming("video_from_bot_owner_review"'),
  );
  assert.doesNotMatch(
    timingRegion,
    /prompt:\s|bytes:\s|token:\s|causalPattern:\s|videoUrl:\s/,
  );
});
