import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "../tools/post09-db-harness/node_modules/@electric-sql/pglite/dist/index.js";

const prerequisite = readFileSync("supabase/migrations/20260831235958_creative_identity_owner_anchor.sql", "utf8");
const migration = readFileSync("supabase/migrations/20260901000002_telegram_lead_attribution_v1.sql", "utf8");
const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const mapA = "20000000-0000-4000-8000-000000000001";
const mapB = "20000000-0000-4000-8000-000000000002";
const postA = "30000000-0000-4000-8000-000000000001";
const digestA = "a".repeat(64);

const bootstrap = String.raw`
create schema auth;
create schema extensions;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public,auth to anon,authenticated,service_role;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create table auth.users(id uuid primary key);
create table public.posts(id uuid primary key,user_id uuid not null references auth.users(id));
create table public.creative_identity_map(
  id uuid primary key,user_id uuid not null references auth.users(id),creative_id text not null
);
grant select on public.posts,public.creative_identity_map to authenticated,service_role;
`;

async function setup() {
  const db = new PGlite();
  await db.exec(bootstrap);
  await db.exec(prerequisite);
  await db.exec(migration);
  await db.query("insert into auth.users(id) values ($1),($2)", [userA, userB]);
  await db.query("insert into public.posts(id,user_id) values ($1,$2)", [postA, userA]);
  await db.query("insert into public.creative_identity_map(id,user_id,creative_id) values ($1,$2,$3),($4,$5,$6)",
    [mapA, userA, `creative-${"a".repeat(64)}`, mapB, userA, `creative-${"b".repeat(64)}`]);
  return db;
}

test("exact Telegram publication binding is idempotent and contradictory mapping fails closed", async () => {
  const db = await setup();
  try {
    const first = await db.query("select (public.bind_telegram_creative_publication($1,$2,$3)).id",
      [userA, mapA, postA]);
    const repeated = await db.query("select (public.bind_telegram_creative_publication($1,$2,$3)).id",
      [userA, mapA, postA]);
    assert.equal(first.rows[0].id, repeated.rows[0].id);
    await assert.rejects(db.query("select public.bind_telegram_creative_publication($1,$2,$3)",
      [userA, mapB, postA]), /telegram_publication_identity_conflict/u);
  } finally { await db.close(); }
});

test("digest mapping is one-active/idempotent, revocation fails closed, and rows are immutable", async () => {
  const db = await setup();
  try {
    const publication = await db.query("select (public.bind_telegram_creative_publication($1,$2,$3)).id",
      [userA, mapA, postA]);
    const publicationId = publication.rows[0].id;
    const first = await db.query("select * from public.register_telegram_attribution_token($1,$2,$3,'cf1','meeting_assistant')",
      [userA, publicationId, digestA]);
    const repeated = await db.query("select * from public.register_telegram_attribution_token($1,$2,$3,'cf1','meeting_assistant')",
      [userA, publicationId, "b".repeat(64)]);
    assert.equal(first.rows[0].was_created, true);
    assert.equal(repeated.rows[0].was_created, false);
    assert.equal(first.rows[0].token_id, repeated.rows[0].token_id);
    assert.equal(repeated.rows[0].registered_digest, digestA);
    assert.equal((await db.query("select count(*)::int as count from public.resolve_active_telegram_attribution_token($1)",
      [digestA])).rows[0].count, 1);
    assert.equal((await db.query("select public.revoke_telegram_attribution_token($1,$2) as revoked",
      [userA, first.rows[0].token_id])).rows[0].revoked, true);
    assert.equal((await db.query("select count(*)::int as count from public.resolve_active_telegram_attribution_token($1)",
      [digestA])).rows[0].count, 0);
    await assert.rejects(db.query("delete from public.telegram_attribution_tokens where id=$1",
      [first.rows[0].token_id]), /telegram_attribution_token_immutable/u);
  } finally { await db.close(); }
});

test("owner RLS and revoked direct DML prevent cross-owner mutation/read", async () => {
  const db = await setup();
  try {
    await db.query("select public.bind_telegram_creative_publication($1,$2,$3)", [userA, mapA, postA]);
    await db.exec("set role authenticated");
    await db.exec(`select set_config('request.jwt.claim.sub','${userB}',false)`);
    assert.equal((await db.query("select count(*)::int as count from public.creative_telegram_publications")).rows[0].count, 0);
    await assert.rejects(db.query("insert into public.telegram_attribution_tokens(user_id,publication_mapping_id,token_digest,token_version,destination) values ($1,$2,$3,'cf1','meeting_assistant')",
      [userB, mapA, digestA]), /permission denied/u);
  } finally { await db.close(); }
});
