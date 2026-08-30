import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildMappingArguments,
  canonicalJson,
  CreativeIdentityError,
  parseStrictJson,
  validatePost01Artifacts,
} from "./lib/creative-identity.mjs";
import { runImport } from "./import-creative-identity.mjs";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const INCOMING_ID = "20000000-0000-4000-8000-000000000002";
const IDEA_ID = "30000000-0000-4000-8000-000000000003";
const TIKTOK_ROW_ID = "40000000-0000-4000-8000-000000000004";
const NOW = "2026-08-31T00:00:00+00:00";
const SCRIPT = "Один принятый текст для ролика.";

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function fixture(prompt = "") {
  const sourceHash = hash(canonicalJson({ body: SCRIPT.normalize("NFC") }));
  const videoInput = {
    slug: "post03-one-creative",
    animal: "",
    topic: "",
    text: SCRIPT,
    hook: "",
    prompt,
    approved: true,
    createdAt: NOW,
    approvedAt: NOW,
  };
  const creativeId = `creative-${hash(canonicalJson({
    domain: "content-factory:creative:v1",
    source_hash: sourceHash,
    source_revision_id: "draft-revision-7",
    source_task_id: "task-post01",
  }))}`;
  const handoffId = `handoff-${hash(canonicalJson({
    creative_id: creativeId,
    domain: "content-factory:handoff:v1",
    handoff_version: 1,
    video_input_hash: hash(canonicalJson(videoInput)),
  }))}`;
  const handoff = {
    handoff_version: 1,
    handoff_id: handoffId,
    creative_id: creativeId,
    source_task_id: "task-post01",
    source_revision_id: "draft-revision-7",
    source_hash: sourceHash,
    created_at: NOW,
    script: SCRIPT,
    video_input: videoInput,
    lineage: {
      source_input_revision_id: "input-revision-3",
      source_input_hash: "1".repeat(64),
      source_package_id: "package-3",
      source_channel: "FEED_TELEGRAM",
    },
  };
  const result = {
    result_version: 1,
    status: "COMPLETED",
    handoff_id: handoffId,
    creative_id: creativeId,
    existing_video_input_id: videoInput.slug,
    final_asset_ref: `sha256:${"2".repeat(64)}`,
    completed_at: NOW,
    source_task_id: handoff.source_task_id,
    source_revision_id: handoff.source_revision_id,
    source_hash: sourceHash,
    source_input_revision_id: handoff.lineage.source_input_revision_id,
    source_input_hash: handoff.lineage.source_input_hash,
    source_package_id: handoff.lineage.source_package_id,
    source_channel: handoff.lineage.source_channel,
    vibepost_draft_ref: `vibepost:incoming_videos:${INCOMING_ID}`,
  };
  return { handoff, result };
}

test("strict POST-01 artifacts produce canonical RPC arguments", () => {
  const { handoff, result } = fixture();
  assert.deepEqual(validatePost01Artifacts(handoff, result), { handoff, result });
  const args = buildMappingArguments({
    handoff, result, userId: USER_ID, platform: "youtube_shorts", videoIdeaId: IDEA_ID,
  });
  assert.equal(args.p_creative_id, handoff.creative_id);
  assert.equal(args.p_handoff_id, handoff.handoff_id);
  assert.equal(args.p_source_hash, handoff.source_hash);
  assert.equal(args.p_incoming_video_id, INCOMING_ID);
  assert.equal(args.p_video_idea_id, IDEA_ID);
  assert.equal(args.p_tiktok_video_row_id, null);
});

test("one creative supports distinct deterministic handoffs", () => {
  const first = fixture("");
  const second = fixture("owner-approved existing prompt");
  assert.equal(first.handoff.creative_id, second.handoff.creative_id);
  assert.notEqual(first.handoff.handoff_id, second.handoff.handoff_id);
  validatePost01Artifacts(first.handoff, first.result);
  validatePost01Artifacts(second.handoff, second.result);
});

test("validator matches Text POST-01 calendar and Python strip vectors", () => {
  const standard = fixture();
  assert.throws(
    () => validatePost01Artifacts({ ...standard.handoff, created_at: "2026-02-30T00:00:00Z" }, standard.result),
    (error) => error instanceof CreativeIdentityError && error.code === "CREATIVE_IDENTITY_SCHEMA_INVALID",
  );

  const script = `\u0085${SCRIPT}\u0085`;
  const videoInput = {
    ...standard.handoff.video_input,
    slug: "post03-unicode-strip",
    text: script,
  };
  const handoff = {
    ...standard.handoff,
    source_task_id: "task-post03-unicode",
    source_revision_id: "draft-revision-10",
    source_hash: "44c84163eee1e1ccbddd9e121df520b955d906050da204e2b4ff6e805d390dc2",
    creative_id: "creative-8ac41c2e7b6ea631b295fac166fcfcfd4f8e39f19de16540d5b8dc71a7b22f52",
    handoff_id: "handoff-8fe4ba03936028269ecdce14ac2166795cd5bdb8283e4af2a5154d0106bd4281",
    script,
    video_input: videoInput,
    lineage: {
      source_input_revision_id: "input-revision-5",
      source_input_hash: "3".repeat(64),
      source_package_id: "package-5",
      source_channel: "FEED_TELEGRAM",
    },
  };
  const result = {
    ...standard.result,
    handoff_id: handoff.handoff_id,
    creative_id: handoff.creative_id,
    existing_video_input_id: videoInput.slug,
    source_task_id: handoff.source_task_id,
    source_revision_id: handoff.source_revision_id,
    source_hash: handoff.source_hash,
    source_input_revision_id: handoff.lineage.source_input_revision_id,
    source_input_hash: handoff.lineage.source_input_hash,
    source_package_id: handoff.lineage.source_package_id,
    source_channel: handoff.lineage.source_channel,
  };
  assert.deepEqual(validatePost01Artifacts(handoff, result), { handoff, result });
});

test("boundary rejects duplicates, unknowns, tampering and guessed identifiers", () => {
  assert.throws(
    () => parseStrictJson('{"handoff_id":"a","handoff_id":"b"}'),
    (error) => error instanceof CreativeIdentityError && error.code === "CREATIVE_IDENTITY_DUPLICATE_FIELD",
  );
  const { handoff, result } = fixture();
  assert.throws(() => validatePost01Artifacts({ ...handoff, extra: true }, result), CreativeIdentityError);
  assert.throws(() => validatePost01Artifacts({ ...handoff, source_hash: "3".repeat(64) }, result), CreativeIdentityError);
  assert.throws(() => validatePost01Artifacts(handoff, { ...result, handoff_id: `handoff-${"4".repeat(64)}` }), CreativeIdentityError);
  assert.throws(() => buildMappingArguments({
    handoff,
    result: { ...result, vibepost_draft_ref: "vibepost:incoming_videos:title-or-date-guess" },
    userId: USER_ID,
    platform: "tiktok",
  }), CreativeIdentityError);
  assert.throws(() => buildMappingArguments({
    handoff, result, userId: USER_ID, platform: "tiktok", youtubeShortRowId: IDEA_ID,
  }), CreativeIdentityError);
});

test("production importer validates files and calls only the mapping RPC", async () => {
  const directory = mkdtempSync(join(tmpdir(), "post03-identity-"));
  try {
    const { handoff, result } = fixture();
    const handoffPath = join(directory, `${handoff.handoff_id}.handoff.json`);
    const resultPath = join(directory, `${handoff.handoff_id}.result.json`);
    writeFileSync(handoffPath, canonicalJson(handoff), "utf8");
    writeFileSync(resultPath, canonicalJson(result), "utf8");
    let observed;
    const imported = await runImport([
      "--handoff", handoffPath,
      "--result", resultPath,
      "--user-id", USER_ID,
      "--platform", "tiktok",
      "--tiktok-video-row-id", TIKTOK_ROW_ID,
    ], {
      SUPABASE_URL: "http://127.0.0.1:54321/",
      SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key",
    }, async (url, options) => {
      observed = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        creative_id: handoff.creative_id,
        handoff_id: handoff.handoff_id,
        platform: "tiktok",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    assert.equal(observed.url, "http://127.0.0.1:54321/rest/v1/rpc/upsert_creative_identity_mapping");
    assert.equal(observed.options.method, "POST");
    assert.equal(observed.options.redirect, "error");
    assert.ok(observed.options.signal instanceof AbortSignal);
    assert.equal(observed.body.p_tiktok_video_row_id, TIKTOK_ROW_ID);
    assert.equal(observed.body.p_incoming_video_id, INCOMING_ID);
    assert.deepEqual(imported, {
      creative_id: handoff.creative_id,
      handoff_id: handoff.handoff_id,
      platform: "tiktok",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production importer pins egress and refuses redirect responses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "post03-egress-"));
  try {
    const { handoff, result } = fixture();
    const handoffPath = join(directory, "one.handoff.json");
    const resultPath = join(directory, "one.result.json");
    writeFileSync(handoffPath, canonicalJson(handoff), "utf8");
    writeFileSync(resultPath, canonicalJson(result), "utf8");
    const argv = ["--handoff", handoffPath, "--result", resultPath, "--user-id", USER_ID, "--platform", "tiktok"];
    let called = false;
    await assert.rejects(
      runImport(argv, {
        SUPABASE_URL: "https://attacker.example",
        SUPABASE_SERVICE_ROLE_KEY: "must-not-leave",
      }, async () => { called = true; return new Response("{}"); }),
      (error) => error instanceof CreativeIdentityError && error.code === "CREATIVE_IDENTITY_ENV_INVALID" && !error.message.includes("must-not-leave"),
    );
    assert.equal(called, false);
    await assert.rejects(
      runImport(argv, {
        SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_SERVICE_ROLE_KEY: "must-not-appear",
      }, async (_url, options) => {
        assert.equal(options.redirect, "error");
        return new Response(null, { status: 302, headers: { location: "https://attacker.example" } });
      }),
      (error) => error instanceof CreativeIdentityError && error.code === "CREATIVE_IDENTITY_RPC_REJECTED" && !error.message.includes("must-not-appear"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration is additive, owner-scoped, idempotent and platform-neutral", () => {
  const sql = readFileSync("supabase/migrations/20260831000001_creative_identity_map.sql", "utf8");
  assert.doesNotMatch(sql, /\b(?:drop table|truncate|delete from)\b/i);
  assert.match(sql, /create extension if not exists pgcrypto with schema extensions/i);
  assert.match(sql, /unique \(user_id, handoff_id, platform\)/i);
  assert.match(sql, /source_hash text not null check \(source_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  for (const table of ["video_ideas", "incoming_videos", "published_shorts"]) {
    assert.match(sql, new RegExp(`${table}_id_user_unique unique \\(id, user_id\\)`, "i"));
  }
  for (const relation of ["video_ideas", "incoming_videos", "videos", "published_shorts"]) {
    assert.match(sql, new RegExp(`references public\\.${relation} \\(id, user_id\\)`, "i"));
  }
  assert.match(sql, /creative_identity_platform_links_check/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /creative_identity_owner_read/i);
  assert.match(sql, /revoke all on table public\.creative_identity_map[\s\S]*authenticated, service_role/i);
  assert.match(sql, /grant select on table public\.creative_identity_map to authenticated, service_role/i);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /extensions\.digest/i);
  assert.match(sql, /v_expected_creative_id/i);
  assert.match(sql, /source_task_id, m\.source_revision_id, m\.source_hash/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /on conflict \(user_id, handoff_id, platform\) do nothing/i);
  assert.match(sql, /coalesce\(m\.incoming_video_id, p_incoming_video_id\)/i);
  assert.match(sql, /creative_identity_conflict/i);
  assert.match(sql, /grant execute on function public\.upsert_creative_identity_mapping[\s\S]*to service_role/i);
});

test("mapping RPC rejects contradictory known chains and enriches only nulls", () => {
  const sql = readFileSync("supabase/migrations/20260831000001_creative_identity_map.sql", "utf8");
  const upsert = sql.slice(sql.indexOf("create or replace function public.upsert_creative_identity_mapping"), sql.indexOf("create or replace function public.release_youtube_publication_lineage"));
  assert.match(upsert, /select s\.video_id, s\.idea_id into v_short_video_id, v_short_idea_id[\s\S]*s\.id = p_youtube_short_row_id and s\.user_id = p_user_id[\s\S]*for no key update/i);
  assert.match(upsert, /p_incoming_video_id <> v_short_video_id/i);
  assert.match(upsert, /p_video_idea_id <> v_short_idea_id/i);
  assert.match(upsert, /p_incoming_video_id := coalesce\(p_incoming_video_id, v_short_video_id\)/i);
  assert.match(upsert, /i\.id = p_incoming_video_id and i\.user_id = p_user_id[\s\S]*for no key update/i);
  assert.match(upsert, /p_video_idea_id <> v_incoming_idea_id/i);
  assert.match(upsert, /p_video_idea_id := coalesce\(p_video_idea_id, v_incoming_idea_id\)/i);
  assert.match(upsert, /video_idea_id = coalesce\(m\.video_idea_id, p_video_idea_id\)/i);
  assert.match(upsert, /youtube_short_row_id = coalesce\(m\.youtube_short_row_id, p_youtube_short_row_id\)/i);
});

test("YouTube release persists exact lineage atomically and never reuploads", () => {
  const sql = readFileSync("supabase/migrations/20260831000001_creative_identity_map.sql", "utf8");
  const fn = sql.slice(sql.indexOf("create or replace function public.release_youtube_publication_lineage"), sql.indexOf("create or replace function public.resolve_creative_metric_lineage"));
  assert.match(fn, /from public\.youtube_publish_queue q[\s\S]*for update/i);
  const shortLock = fn.indexOf("for no key update;");
  const incomingLock = fn.indexOf("for no key update;", shortLock + 1);
  const mappingLock = fn.indexOf("for update;", fn.indexOf("from public.creative_identity_map"));
  assert.ok(shortLock >= 0 && incomingLock > shortLock && mappingLock > incomingLock);
  assert.match(fn, /i\.id = v_queue\.incoming_video_id and i\.user_id = v_queue\.user_id[\s\S]*for no key update/i);
  assert.match(fn, /on conflict \(youtube_id\) do nothing/i);
  assert.match(fn, /video_id = coalesce\(s\.video_id, v_queue\.incoming_video_id\)/i);
  assert.match(fn, /m\.incoming_video_id = v_queue\.incoming_video_id/i);
  assert.match(fn, /v_mapping\.video_idea_id <> v_idea_id/i);
  assert.match(fn, /v_idea_id := coalesce\(v_idea_id, v_mapping\.video_idea_id\)/i);
  assert.match(fn, /video_idea_id = coalesce\(m\.video_idea_id, v_idea_id\)/i);
  assert.match(fn, /youtube_short_row_id = coalesce\(m\.youtube_short_row_id, v_short\.id\)/i);
  assert.ok(fn.indexOf("update public.creative_identity_map") < fn.indexOf("update public.youtube_publish_queue"));
  assert.match(fn, /set status = 'published'/i);

  const publisher = readFileSync("supabase/functions/youtube-publish/index.ts", "utf8");
  assert.match(publisher, /\.select\("id"\)[\s\S]*\.eq\("status", "uploaded"\)/);
  assert.match(publisher, /rpc\("release_youtube_publication_lineage"/);
  assert.doesNotMatch(publisher, /\.update\(\{ status: "published"/);
  assert.match(publisher, /claim_due_youtube_publish/);
  assert.equal((publisher.match(/uploadToYouTube\(accessToken, item, video\)/g) ?? []).length, 1);
});

test("metric resolution joins existing stores without copies or fuzzy links", () => {
  const sql = readFileSync("supabase/migrations/20260831000001_creative_identity_map.sql", "utf8");
  const resolver = sql.slice(sql.indexOf("create or replace function public.resolve_creative_metric_lineage"));
  assert.match(resolver, /public\.video_metric_snapshots/);
  assert.match(resolver, /public\.studio_metrics/);
  assert.match(resolver, /public\.published_shorts_stats/);
  assert.match(resolver, /v\.id = m\.tiktok_video_row_id and v\.user_id = m\.user_id/);
  assert.match(resolver, /s\.id = m\.youtube_short_row_id and s\.user_id = m\.user_id/);
  assert.doesNotMatch(resolver, /\b(?:insert into|update|delete from)\b/i);
  assert.doesNotMatch(resolver, /\b(?:title|published_at)\b/i);
});
