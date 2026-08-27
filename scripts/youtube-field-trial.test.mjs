import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  TARGET_PLATFORMS,
  YOUTUBE_REFERENCE_LIBRARY,
  buildYoutubeApprovedFallback,
  fetchYoutubeTrendCandidates,
  formatTrendContext,
  normalizeTargetPlatform,
  platformLabel,
  selectYoutubeExperimentSet,
  trustedIdeaMetadata,
  youtubeFacts,
} from '../supabase/functions/_shared/youtube-trend.mjs';

const root = new URL('..', import.meta.url);
const source = (relative) => readFileSync(new URL(relative, root), 'utf8');

test('platform selector accepts only TikTok and YouTube Shorts', () => {
  assert.equal(normalizeTargetPlatform('youtube_shorts'), TARGET_PLATFORMS.YOUTUBE_SHORTS);
  assert.equal(normalizeTargetPlatform('tiktok'), TARGET_PLATFORMS.TIKTOK);
  assert.equal(normalizeTargetPlatform('instagram'), TARGET_PLATFORMS.TIKTOK);
  assert.equal(platformLabel('youtube_shorts'), 'YouTube Shorts');
});

test('bounded V0.1 registry contains the four Controller-approved causal patterns', () => {
  assert.deepEqual(
    YOUTUBE_REFERENCE_LIBRARY.map((reference) => reference.causal_pattern.pattern_class),
    [
      'SAME_PROP_SUDDEN_PHYSICAL_DESTRUCTION',
      'DEADPAN_RESPONSE_TO_OPPOSITE_PROPERTY',
      'VARIATION_BECOMES_ESCALATION_AND_PAYOFF',
      'CHARACTER_SEARCHES_AND_RESPONDS_TO_EXTERNAL_EFFECT',
    ],
  );
  assert.equal(new Set(YOUTUBE_REFERENCE_LIBRARY.map((reference) => reference.reference_id)).size, 4);
  for (const reference of YOUTUBE_REFERENCE_LIBRARY) {
    assert.ok(reference.causal_pattern.viewer_prediction);
    assert.ok(reference.causal_pattern.violation_class);
    assert.ok(reference.causal_pattern.payoff_class);
    assert.ok(reference.critical_fidelity_constraints.length >= 3);
  }
});

test('YouTube FACT snapshot computes VPH and leaves unsupported baseline UNKNOWN', () => {
  const facts = youtubeFacts({
    id: YOUTUBE_REFERENCE_LIBRARY[0].reference_id,
    snippet: {
      title: 'Observed title', channelTitle: 'Observed channel', publishedAt: '2026-08-25T00:00:00Z',
    },
    contentDetails: { duration: 'PT10S' },
    statistics: { viewCount: '12000', likeCount: '500', commentCount: '100' },
  }, YOUTUBE_REFERENCE_LIBRARY[0], new Date('2026-08-25T12:00:00Z'));
  assert.equal(facts.reference_vph, 1000);
  assert.equal(facts.reference_duration_seconds, 10);
  assert.equal(facts.reference_channel_baseline_views, null);
  assert.equal(facts.reference_outlier_ratio, null);
  assert.deepEqual(facts.unknown_fields, ['reference_channel_baseline_views', 'reference_outlier_ratio']);
});

test('first YouTube experiment set is four references plus one control', () => {
  const candidates = YOUTUBE_REFERENCE_LIBRARY.map((reference) => ({
    reference_source_id: reference.reference_id,
  }));
  const set = selectYoutubeExperimentSet(candidates, 5);
  assert.equal(set.length, 5);
  assert.equal(set[4].reference_source_id, 'CONTROL');
  const fallback = buildYoutubeApprovedFallback(set);
  assert.equal(fallback.length, 5);
  assert.deepEqual(fallback.map((idea) => idea.reference_id), set.map((item) => item.reference_source_id));
  assert.equal(new Set(fallback.map((idea) => idea.slug)).size, 5);
});

test('trusted metadata separates reference inference from card-visible fields', () => {
  const candidate = {
    reference_source_id: 'ref', reference_source_url: 'https://example.test/ref',
    reference_title: 'title', reference_published_at: '2026-08-25T00:00:00Z',
    reference_views: 100, reference_vph: 10, reference_snapshot_at: '2026-08-25T10:00:00Z',
    reference_channel_baseline_views: null, reference_outlier_ratio: null,
    causal_pattern: { pattern_class: 'TEST', viewer_prediction: 'prediction' },
    payoff_class: 'PAYOFF', critical_fidelity_constraints: ['preserve order'],
  };
  const metadata = trustedIdeaMetadata(candidate);
  assert.equal(metadata.trend_signal, 'reference-driven');
  assert.equal(metadata.reference_channel_baseline_views, null);
  assert.equal(metadata.reference_outlier_ratio, null);
  const context = formatTrendContext(candidate);
  assert.match(context, /FACT:/);
  assert.match(context, /INFERENCE/);
  assert.match(context, /UNKNOWN:/);
  assert.match(context, /DO NOT COPY/);
});

test('production Telegram wiring keeps existing buttons and does not call Veo in self route', () => {
  const suggest = source('supabase/functions/suggest-ideas/index.ts');
  for (const button of ['🖐 Сделаю сама', '💸 Сгенерируй', '🔄 Другое', '🗑 Мимо']) {
    assert.ok(suggest.includes(button));
  }
  assert.match(suggest, /fetchYoutubeTrendCandidates/);
  assert.match(suggest, /targetPlatform === TARGET_PLATFORMS\.YOUTUBE_SHORTS/);
  assert.match(suggest, /ideas = buildYoutubeApprovedFallback\(experimentSet\)/);
  assert.match(suggest, /ideaSource = "controller-approved-v0\.1"/);

  const ideaButton = source('supabase/functions/idea-button/index.ts');
  const selfStart = ideaButton.indexOf('if (action === "self")', ideaButton.indexOf('// Промт по идее'));
  const paidStart = ideaButton.indexOf('if (action === "pay")', selfStart);
  const selfRoute = ideaButton.slice(selfStart, paidStart);
  assert.match(selfRoute, /claude_tasks/);
  assert.match(selfRoute, /idea_id: idea\.id/);
  assert.match(selfRoute, /trustedTaskContext/);
  assert.doesNotMatch(selfRoute, /veo-start|запустить\(/);
});

test('final prompt is returned by the existing Telegram command and persisted to the selected idea', () => {
  const duty = source('scripts/dezhurny.mjs');
  const tasks = source('scripts/задания.mjs');
  assert.match(duty, /промпт <файл\.json> --task <id>/);
  assert.match(tasks, /<pre>\$\{экран\(компакт\)\}<\/pre>/);
  assert.match(tasks, /video_ideas\?id=eq\.\$\{task\.idea_id\}/);
  assert.match(tasks, /generated_prompt_at/);
  const promptBranch = tasks.slice(tasks.indexOf("команда === 'промпт'"));
  assert.match(promptBranch, /const taskFlag = аргументы\.indexOf\('--task'\)/);
  assert.match(promptBranch, /const taskId = taskFlag >= 0/);
});

test('returned-video review carries causal advisory without taking owner authority', () => {
  const review = source('supabase/functions/video-from-bot/index.ts');
  assert.match(review, /causal_pattern_preserved/);
  assert.match(review, /advisory signal/);
  assert.match(review, /causal_pattern_review/);

  const webhook = source('supabase/functions/telegram-webhook/index.ts');
  const watcher = source('scripts/watch-videos.mjs');
  const ownerButtons = `${webhook}\n${watcher}`;
  assert.match(ownerButtons, /✅ Годится/);
  assert.match(ownerButtons, /✏️ Не годится/);
  assert.match(ownerButtons, /🔁 Переписывай сам/);
  assert.match(ownerButtons, /🔊 Поправь звук/);
  assert.match(ownerButtons, /✅ Всё равно беру/);
  assert.match(webhook, /ready: true, owner_accepted_at/);
});

test('acceptance is synchronized only after title input or title selection', () => {
  const webhook = source('supabase/functions/telegram-webhook/index.ts');
  const acceptWrites = [...webhook.matchAll(/ready: true, owner_accepted_at/g)];
  assert.equal(acceptWrites.length, 3);
  const vidOkStart = webhook.indexOf('await admin.from("profiles").update({', webhook.indexOf('что === "ok"'));
  const titlePromptEnd = webhook.indexOf('await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`', vidOkStart);
  assert.doesNotMatch(webhook.slice(vidOkStart, titlePromptEnd), /ready:\s*true/);

  const legacy = source('supabase/functions/idea-button/index.ts');
  assert.match(legacy, /data\.startsWith\("cap:"\)/);
  const legacyCaptionPick = legacy.slice(
    legacy.indexOf('if (что === "pick")'),
    legacy.indexOf('if (что === "more")'),
  );
  assert.match(legacyCaptionPick, /ready: true/);
  assert.match(legacyCaptionPick, /owner_accepted_at: new Date\(\)\.toISOString\(\)/);
});

test('rework carries trusted causal metadata and post-processing does not overwrite target', () => {
  const webhook = source('supabase/functions/telegram-webhook/index.ts');
  const watcher = source('scripts/watch-videos.mjs');
  assert.match(webhook, /trustedVideoContext/);
  assert.match(webhook, /idea_id: ролик\?\.idea_id/);
  assert.match(watcher, /TRUSTED INTERNAL METADATA: target_platform=youtube_shorts/);
  const postProcessPatch = watcher.slice(
    watcher.indexOf('body: JSON.stringify({', watcher.indexOf('videos/${ролик.id}-titry.mp4')),
    watcher.indexOf('console.log(\'готово, во «Входящих» уже с титрами.\')'),
  );
  assert.match(postProcessPatch, /video_url/);
  assert.match(postProcessPatch, /polished_at/);
  assert.doesNotMatch(postProcessPatch, /target_platform\s*:/);
});

test('channels and scheduler remain Telegram-specific; no YouTube uploader is claimed', () => {
  const core = source('supabase/migrations/20260719000002_core_schema.sql');
  const sender = source('supabase/functions/process-scheduler/send-post.ts');
  assert.match(core, /telegram_chat_id text not null/);
  assert.match(core, /type in \('private', 'channel', 'group'\)/);
  assert.match(sender, /api\.telegram\.org/);
  assert.doesNotMatch(sender, /youtube|googleapis/i);
});

test('migration preserves old rows as TikTok and adds field-trial tracking', () => {
  const migration = source('supabase/migrations/20260825000001_youtube_field_trial_v01.sql');
  assert.match(migration, /target_platform text not null default 'tiktok'/);
  for (const field of [
    'reference_source_id', 'reference_published_at', 'reference_views', 'reference_vph',
    'causal_pattern', 'idea_id', 'owner_accepted_at', 'published_at',
    'resulting_views_checkpoints',
  ]) assert.ok(migration.includes(field));
});

test('live read-only YouTube Data API returns all accepted references', {
  skip: !process.env.YOUTUBE_API_KEY,
}, async () => {
  const candidates = await fetchYoutubeTrendCandidates({ apiKey: process.env.YOUTUBE_API_KEY });
  assert.equal(candidates.length, 4);
  for (const candidate of candidates) {
    assert.match(candidate.reference_source_url, /^https:\/\/www\.youtube\.com\/shorts\//);
    assert.ok(candidate.reference_snapshot_at);
    assert.notEqual(candidate.reference_title, 'UNKNOWN');
  }
});
