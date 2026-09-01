import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "../tools/post09-db-harness/node_modules/@electric-sql/pglite/dist/index.js";

const migration = readFileSync(
  "supabase/migrations/20260831235959_telegram_identity_semantic.sql",
  "utf8",
);
const owner = "10000000-0000-4000-8000-000000000001";
const sourceTask = "post13a-canary";
const sourceRevision = "telegram-v1";
const sourceHash = "a".repeat(64);
const handoffId = `handoff-${"b".repeat(64)}`;
const creativeId = `creative-${createHash("sha256").update(JSON.stringify({
  domain: "content-factory:creative:v1",
  source_hash: sourceHash,
  source_revision_id: sourceRevision,
  source_task_id: sourceTask,
})).digest("hex")}`;

const bootstrap = String.raw`
create schema auth;
create schema extensions;
create function extensions.digest(bytea,text) returns bytea language sql immutable
  as $$ select sha256($1) $$;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create table auth.users(id uuid primary key);
create table public.videos(
  id uuid primary key,user_id uuid not null,tiktok_video_id text
);
create table public.published_shorts(
  id uuid primary key,user_id uuid not null,youtube_id text
);
create table public.video_metric_snapshots(user_id uuid not null,video_id uuid not null);
create table public.studio_metrics(user_id uuid not null,video_id uuid not null);
create table public.published_shorts_stats(short_id uuid not null);
create table public.creative_identity_map(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  creative_id text not null check (creative_id ~ '^creative-[0-9a-f]{64}$'),
  source_task_id text not null,
  source_revision_id text not null,
  source_hash text not null,
  handoff_id text not null,
  platform text not null,
  video_idea_id uuid,
  incoming_video_id uuid,
  tiktok_video_row_id uuid,
  youtube_short_row_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,handoff_id,platform),
  constraint creative_identity_map_platform_check
    check(platform in ('tiktok','youtube_shorts')),
  constraint creative_identity_platform_links_check check(
    (platform='tiktok' and youtube_short_row_id is null)
    or (platform='youtube_shorts' and tiktok_video_row_id is null)
  )
);
create function public.resolve_creative_metric_lineage(uuid,text,text default null)
returns table(mapping_id uuid,handoff_id text,platform text,external_video_id text,
  metric_store text,metric_snapshot_count bigint,secondary_metric_count bigint)
language sql as $$ select null::uuid,null::text,null::text,null::text,null::text,
  null::bigint,null::bigint where false $$;
`;

async function setup() {
  const db = new PGlite();
  await db.exec(bootstrap);
  await db.exec(migration);
  await db.query("insert into auth.users(id) values ($1)", [owner]);
  return db;
}

test("Telegram identity is truthful, deterministic and idempotent", async () => {
  const db = await setup();
  try {
    const args = [owner, creativeId, sourceTask, sourceRevision, sourceHash, handoffId];
    const first = await db.query(
      "select (public.upsert_telegram_creative_identity_mapping($1,$2,$3,$4,$5,$6)).*",
      args,
    );
    const repeated = await db.query(
      "select (public.upsert_telegram_creative_identity_mapping($1,$2,$3,$4,$5,$6)).*",
      args,
    );
    assert.equal(first.rows[0].id, repeated.rows[0].id);
    assert.equal(first.rows[0].platform, "telegram");
    assert.equal(first.rows[0].tiktok_video_row_id, null);
    assert.equal(first.rows[0].youtube_short_row_id, null);
    assert.equal((await db.query(
      "select count(*)::int as count from public.creative_identity_map where platform='tiktok'",
    )).rows[0].count, 0);
  } finally {
    await db.close();
  }
});

test("Telegram metric lineage is explicitly unsupported and never falls through to YouTube", async () => {
  const db = await setup();
  try {
    await db.query(
      "select public.upsert_telegram_creative_identity_mapping($1,$2,$3,$4,$5,$6)",
      [owner, creativeId, sourceTask, sourceRevision, sourceHash, handoffId],
    );
    const resolved = await db.query(
      "select * from public.resolve_creative_metric_lineage($1,$2,'telegram')",
      [owner, creativeId],
    );
    assert.equal(resolved.rows.length, 1);
    assert.equal(resolved.rows[0].platform, "telegram");
    assert.equal(resolved.rows[0].external_video_id, null);
    assert.equal(resolved.rows[0].metric_store, "UNSUPPORTED");
    assert.equal(resolved.rows[0].metric_snapshot_count, null);
    assert.equal(resolved.rows[0].secondary_metric_count, null);
  } finally {
    await db.close();
  }
});

test("Telegram identity rejects tampering and platform publication columns", async () => {
  const db = await setup();
  try {
    await assert.rejects(db.query(
      "select public.upsert_telegram_creative_identity_mapping($1,$2,$3,$4,$5,$6)",
      [owner, `creative-${"f".repeat(64)}`, sourceTask, sourceRevision, sourceHash, handoffId],
    ), /creative_identity_invalid/u);
    await assert.rejects(db.query(
      `insert into public.creative_identity_map(
        user_id,creative_id,source_task_id,source_revision_id,source_hash,handoff_id,
        platform,tiktok_video_row_id
      ) values ($1,$2,$3,$4,$5,$6,'telegram',$7)`,
      [owner, creativeId, sourceTask, sourceRevision, sourceHash, handoffId,
        "20000000-0000-4000-8000-000000000001"],
    ), /creative_identity_platform_links_check/u);
  } finally {
    await db.close();
  }
});

test("existing TikTok and YouTube metric branches keep their accepted semantics", async () => {
  const db = await setup();
  try {
    const tiktokVideo = "20000000-0000-4000-8000-000000000001";
    const youtubeShort = "30000000-0000-4000-8000-000000000001";
    const tiktokCreative = `creative-${"c".repeat(64)}`;
    const youtubeCreative = `creative-${"d".repeat(64)}`;
    await db.query("insert into public.videos(id,user_id,tiktok_video_id) values ($1,$2,'tt-live')",
      [tiktokVideo, owner]);
    await db.query("insert into public.published_shorts(id,user_id,youtube_id) values ($1,$2,'yt-live')",
      [youtubeShort, owner]);
    await db.query(`insert into public.creative_identity_map(
      user_id,creative_id,source_task_id,source_revision_id,source_hash,handoff_id,
      platform,tiktok_video_row_id
    ) values ($1,$2,'task-tiktok','revision-1',$3,$4,'tiktok',$5)`,
    [owner, tiktokCreative, "e".repeat(64), `handoff-${"e".repeat(64)}`, tiktokVideo]);
    await db.query(`insert into public.creative_identity_map(
      user_id,creative_id,source_task_id,source_revision_id,source_hash,handoff_id,
      platform,youtube_short_row_id
    ) values ($1,$2,'task-youtube','revision-1',$3,$4,'youtube_shorts',$5)`,
    [owner, youtubeCreative, "f".repeat(64), `handoff-${"f".repeat(64)}`, youtubeShort]);
    await db.query("insert into public.video_metric_snapshots(user_id,video_id) values ($1,$2)",
      [owner, tiktokVideo]);
    await db.query("insert into public.studio_metrics(user_id,video_id) values ($1,$2)",
      [owner, tiktokVideo]);
    await db.query("insert into public.published_shorts_stats(short_id) values ($1),($1)",
      [youtubeShort]);

    const tiktok = (await db.query(
      "select * from public.resolve_creative_metric_lineage($1,$2,'tiktok')", [owner, tiktokCreative],
    )).rows[0];
    assert.equal(tiktok.external_video_id, "tt-live");
    assert.equal(tiktok.metric_store, "video_metric_snapshots+studio_metrics");
    assert.equal(Number(tiktok.metric_snapshot_count), 1);
    assert.equal(Number(tiktok.secondary_metric_count), 1);

    const youtube = (await db.query(
      "select * from public.resolve_creative_metric_lineage($1,$2,'youtube_shorts')",
      [owner, youtubeCreative],
    )).rows[0];
    assert.equal(youtube.external_video_id, "yt-live");
    assert.equal(youtube.metric_store, "published_shorts_stats");
    assert.equal(Number(youtube.metric_snapshot_count), 2);
    assert.equal(youtube.secondary_metric_count, null);
  } finally {
    await db.close();
  }
});
