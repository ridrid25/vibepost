import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "../tools/post09-db-harness/node_modules/@electric-sql/pglite/dist/index.js";

const prerequisite = readFileSync(
  "supabase/migrations/20260831235958_creative_identity_owner_anchor.sql",
  "utf8",
);
const post12 = readFileSync(
  "supabase/migrations/20260901000002_telegram_lead_attribution_v1.sql",
  "utf8",
);
const post13c = readFileSync(
  "supabase/migrations/20260901000003_content_factory_leads_canary.sql",
  "utf8",
);
const post13d = readFileSync(
  "supabase/migrations/20260902000001_content_factory_leads_canary_retry.sql",
  "utf8",
);

const user = "10000000-0000-4000-8000-000000000001";
const bot = "20000000-0000-4000-8000-000000000001";
const testChat = "30000000-0000-4000-8000-000000000001";
const mainChat = "30000000-0000-4000-8000-000000000002";
const oldMap = "40000000-0000-4000-8000-000000000001";
const oldPost = "50000000-0000-4000-8000-000000000001";
const sentinelA = "50000000-0000-4000-8000-000000000002";
const sentinelB = "50000000-0000-4000-8000-000000000003";
const run = "60000000-0000-4000-8000-000000000013";
const lease = "70000000-0000-4000-8000-000000000013";
const oldTokenDigest = "a".repeat(64);
const credentialDigest = "b".repeat(64);
const newTokenDigest = "c".repeat(64);
const creativeId = `creative-${"d".repeat(64)}`;
const sourceHash = "e".repeat(64);
const handoffId = `handoff-${"f".repeat(64)}`;

const bootstrap = String.raw`
create schema auth;
create schema extensions;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public,auth,extensions to anon,authenticated,service_role;
create function extensions.digest(data bytea, algorithm text) returns bytea
language sql immutable as $$
  select decode(md5(encode(data,'hex')) || md5('post13d:' || encode(data,'hex')),'hex')
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create table auth.users(id uuid primary key);
create table public.bots(
  id uuid primary key,user_id uuid not null references auth.users(id),
  token_secret_id uuid,is_active boolean not null default true
);
create table public.chats(
  id uuid primary key,user_id uuid not null references auth.users(id),
  bot_id uuid not null references public.bots(id),telegram_chat_id text not null,
  type text not null
);
create table public.posts(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  bot_id uuid not null references public.bots(id),
  chat_id uuid not null references public.chats(id),
  format text not null,text text,inline_buttons jsonb,
  is_silent boolean not null default false,
  disable_link_preview boolean not null default false,
  scheduled_at timestamptz not null default now(),
  status text not null,tg_message_id bigint,error text,sent_at timestamptz
);
create table public.creative_identity_map(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  creative_id text not null,source_task_id text,source_revision_id text,
  source_hash text,handoff_id text,platform text,
  unique(user_id,handoff_id,platform)
);
grant select on public.posts,public.bots,public.chats,public.creative_identity_map
  to authenticated,service_role;
`;

const identityStub = String.raw`
create or replace function public.upsert_telegram_creative_identity_mapping(
  p_user_id uuid,p_creative_id text,p_source_task_id text,
  p_source_revision_id text,p_source_hash text,p_handoff_id text
)
returns public.creative_identity_map
language plpgsql security definer set search_path = '' as $$
declare v_row public.creative_identity_map;
begin
  insert into public.creative_identity_map(
    user_id,creative_id,source_task_id,source_revision_id,source_hash,handoff_id,platform
  ) values (
    p_user_id,p_creative_id,p_source_task_id,p_source_revision_id,p_source_hash,p_handoff_id,'telegram'
  ) returning * into v_row;
  return v_row;
end;
$$;
revoke execute on function public.upsert_telegram_creative_identity_mapping(uuid,text,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.upsert_telegram_creative_identity_mapping(uuid,text,text,text,text,text)
  to service_role;
`;

async function setup() {
  const db = new PGlite();
  await db.exec(bootstrap);
  await db.exec(prerequisite);
  await db.exec(post12);
  await db.exec(identityStub);
  await db.exec(post13c);
  await db.query("insert into auth.users(id) values ($1)", [user]);
  await db.query("insert into public.bots(id,user_id) values ($1,$2)", [bot, user]);
  await db.query(
    "insert into public.chats(id,user_id,bot_id,telegram_chat_id,type) values ($1,$2,$3,$4,'channel'),($5,$2,$3,$6,'channel')",
    [testChat, user, bot, "-1001234567890", mainChat, "-1009876543210"],
  );
  await db.query(
    "insert into public.posts(id,user_id,bot_id,chat_id,format,text,inline_buttons,status,tg_message_id) values ($1,$2,$3,$4,'text','old-canary',null,'sent',70),($5,$2,$3,$6,'text','sentinel-a',null,'sent',71),($7,$2,$3,$6,'text','sentinel-b',null,'sent',72)",
    [oldPost, user, bot, testChat, sentinelA, mainChat, sentinelB],
  );
  await db.query(
    "insert into public.creative_identity_map(id,user_id,creative_id,source_task_id,source_revision_id,source_hash,handoff_id,platform) values ($1,$2,$3,'old-task','old-revision',$4,$5,'telegram')",
    [oldMap, user, `creative-${"1".repeat(64)}`, "2".repeat(64), `handoff-${"3".repeat(64)}`],
  );
  await db.query(
    "select public.freeze_content_factory_leads_canary_scope($1,$2,$3,$4,$5,$6,$7)",
    [user, testChat, "-1001234567890", mainChat, "-1009876543210", sentinelA, sentinelB],
  );
  await db.query(
    "select public.authorize_content_factory_leads_canary($1,now()+interval '10 minutes')",
    [credentialDigest],
  );
  await db.query(
    "select public.claim_content_factory_leads_canary_activation($1,$2,now()+interval '2 minutes')",
    [credentialDigest, "60000000-0000-4000-8000-000000000001"],
  );
  await db.query(
    "select public.complete_content_factory_leads_canary_activation($1,$2,$3)",
    ["60000000-0000-4000-8000-000000000001", "4".repeat(64), "5".repeat(64)],
  );
  await db.query(
    "select public.prepare_content_factory_leads_canary_run($1,$2,$3,$4)",
    [user, oldMap, oldPost, oldTokenDigest],
  );
  await db.query(
    "select public.mark_content_factory_leads_canary_cta_active($1)",
    ["6".repeat(64)],
  );
  await db.query("select public.ensure_content_factory_leads_canary_token_revoked()");
  await db.query(
    "select public.mark_content_factory_leads_canary_run_rollback('OWNER_ROLLBACK',false)",
  );
  await db.query("select public.begin_content_factory_leads_canary_deactivation()");
  await db.exec(post13d);
  return db;
}

async function prepareRetry(db) {
  return (await db.query(
    "select r.* from public.prepare_content_factory_leads_canary_retry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r",
    [
      user,
      run,
      creativeId,
      "post13d:60000000000040008000000000000013",
      "post13d.retry.v1",
      sourceHash,
      handoffId,
      newTokenDigest,
      "7".repeat(64),
      "🧪 POST-13D — изолированная тестовая публикация. Кнопка создаёт только тестовый лид; Booking, Calendar, payment и revenue не создаются.",
    ],
  )).rows[0];
}

test("fresh retry creates one independent post, identity, token and run", async () => {
  const db = await setup();
  try {
    const retry = await prepareRetry(db);
    assert.equal(retry.canary_run_id, run);
    assert.equal(retry.state, "PREPARING");
    assert.equal(retry.delivery_attempts, 0);
    assert.equal(
      (await db.query("select count(*)::int as count from public.telegram_attribution_canary_retry_runs")).rows[0].count,
      1,
    );
    assert.equal(
      (await db.query("select count(*)::int as count from public.telegram_attribution_tokens where token_digest=$1", [newTokenDigest])).rows[0].count,
      1,
    );
    assert.equal(
      (await db.query("select platform from public.creative_identity_map where creative_id=$1", [creativeId])).rows[0].platform,
      "telegram",
    );
    await assert.rejects(prepareRetry(db), /post13d_run_already_exists/u);
    assert.deepEqual(
      (await db.query("select state from public.telegram_attribution_canary_runs where singleton_key='POST13C'")).rows[0],
      { state: "ROLLED_BACK" },
    );
  } finally {
    await db.close();
  }
});

test("delivery claim is one-use and finalization binds the exact message", async () => {
  const db = await setup();
  try {
    await prepareRetry(db);
    assert.equal(
      (await db.query(
        "select public.claim_content_factory_leads_canary_retry_delivery($1,$2,$3,now()+interval '2 minutes') as ok",
        [user, run, lease],
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select public.claim_content_factory_leads_canary_retry_delivery($1,$2,$3,now()+interval '2 minutes') as ok",
        [user, run, "70000000-0000-4000-8000-000000000014"],
      )).rows[0].ok,
      false,
    );
    assert.equal(
      (await db.query(
        "select public.finalize_content_factory_leads_canary_retry_delivery($1,$2,$3,$4) as ok",
        [user, run, lease, 88],
      )).rows[0].ok,
      true,
    );
    const state = (await db.query(
      "select state,delivery_attempts,tg_message_id from public.telegram_attribution_canary_retry_runs",
    )).rows[0];
    assert.deepEqual(state, { state: "ACTIVE", delivery_attempts: 1, tg_message_id: 88 });
    const preOwner = await db.query(
      "select check_name,passed from public.audit_content_factory_leads_canary_retry('PRE_OWNER')",
    );
    assert.equal(preOwner.rows.every((row) => row.passed === true), true);
  } finally {
    await db.close();
  }
});

test("unknown token is rejected and semantic events are exactly-once", async () => {
  const db = await setup();
  try {
    await prepareRetry(db);
    await db.query(
      "select public.claim_content_factory_leads_canary_retry_delivery($1,$2,$3,now()+interval '2 minutes')",
      [user, run, lease],
    );
    await db.query(
      "select public.finalize_content_factory_leads_canary_retry_delivery($1,$2,$3,88)",
      [user, run, lease],
    );
    assert.equal(
      (await db.query("select public.run_content_factory_leads_canary_retry_negative_check() as ok")).rows[0].ok,
      true,
    );
    const subject = `subject_${"8".repeat(64)}`;
    const startUpdate = `update_${"9".repeat(64)}`;
    const leadUpdate = `update_${"a".repeat(64)}`;
    assert.equal(
      (await db.query(
        "select public.record_content_factory_leads_retry_canary_lead($1,$2,$3) as status",
        [run, subject, leadUpdate],
      )).rows[0].status,
      "REJECTED",
    );
    assert.equal(
      (await db.query(
        "select public.record_content_factory_leads_retry_bot_start($1,$2,$3) as status",
        [newTokenDigest, subject, startUpdate],
      )).rows[0].status,
      "RECORDED",
    );
    assert.equal(
      (await db.query(
        "select public.record_content_factory_leads_retry_bot_start($1,$2,$3) as status",
        [newTokenDigest, subject, startUpdate],
      )).rows[0].status,
      "DUPLICATE",
    );
    assert.equal(
      (await db.query(
        "select public.record_content_factory_leads_retry_canary_lead($1,$2,$3) as status",
        [run, subject, leadUpdate],
      )).rows[0].status,
      "RECORDED",
    );
    assert.equal(
      (await db.query(
        "select public.record_content_factory_leads_retry_canary_lead($1,$2,$3) as status",
        [run, subject, leadUpdate],
      )).rows[0].status,
      "DUPLICATE",
    );
    const evidence = (await db.query(
      "select * from public.resolve_content_factory_leads_canary_retry_evidence($1)",
      [user],
    )).rows;
    assert.equal(evidence.length, 2);
    assert.deepEqual(evidence.map((row) => row.event_type), [
      "BOT_START",
      "CANARY_LEAD_CREATED",
    ]);
    assert.equal(evidence[1].creative_id, creativeId);
    const activeAudit = await db.query(
      "select check_name,passed from public.audit_content_factory_leads_canary_retry('ACTIVE_COMPLETE')",
    );
    assert.equal(activeAudit.rows.every((row) => row.passed === true), true);
  } finally {
    await db.close();
  }
});

test("COMPLETED requires two events, revokes cf1 and preserves POST13C", async () => {
  const db = await setup();
  try {
    await prepareRetry(db);
    await db.query(
      "select public.claim_content_factory_leads_canary_retry_delivery($1,$2,$3,now()+interval '2 minutes')",
      [user, run, lease],
    );
    await db.query(
      "select public.finalize_content_factory_leads_canary_retry_delivery($1,$2,$3,88)",
      [user, run, lease],
    );
    assert.equal(
      (await db.query(
        "select public.complete_content_factory_leads_canary_retry($1,$2,$3) as ok",
        [user, run, "0".repeat(64)],
      )).rows[0].ok,
      false,
    );
    const subject = `subject_${"8".repeat(64)}`;
    await db.query(
      "select public.record_content_factory_leads_retry_bot_start($1,$2,$3)",
      [newTokenDigest, subject, `update_${"9".repeat(64)}`],
    );
    await db.query(
      "select public.record_content_factory_leads_retry_canary_lead($1,$2,$3)",
      [run, subject, `update_${"a".repeat(64)}`],
    );
    assert.equal(
      (await db.query(
        "select public.complete_content_factory_leads_canary_retry($1,$2,$3) as ok",
        [user, run, "0".repeat(64)],
      )).rows[0].ok,
      true,
    );
    const completedRun = (await db.query(
      "select state,resolution_hash from public.telegram_attribution_canary_retry_runs",
    )).rows[0];
    assert.equal(completedRun.state, "COMPLETED");
    assert.match(completedRun.resolution_hash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(
      (await db.query("select status from public.telegram_attribution_tokens where token_digest=$1", [newTokenDigest])).rows[0],
      { status: "REVOKED" },
    );
    assert.deepEqual(
      (await db.query("select state from public.telegram_canary_runtime_state where singleton_key='POST13C'")).rows[0],
      { state: "DEACTIVATING" },
    );
    const completedAudit = await db.query(
      "select check_name,passed from public.audit_content_factory_leads_canary_retry('COMPLETED')",
    );
    assert.equal(completedAudit.rows.every((row) => row.passed === true), true);
    assert.equal(
      (await db.query(
        "select public.record_content_factory_leads_retry_bot_start($1,$2,$3) as status",
        [newTokenDigest, `subject_${"b".repeat(64)}`, `update_${"c".repeat(64)}`],
      )).rows[0].status,
      "REJECTED",
    );
    assert.equal(
      (await db.query(
        "select count(*)::int as count from public.telegram_canary_retry_events",
      )).rows[0].count,
      2,
    );
    await assert.rejects(
      db.query(
        "update public.telegram_attribution_canary_retry_runs set token_digest=$1",
        ["1".repeat(64)],
      ),
      /telegram_canary_retry_run_immutable/u,
    );
  } finally {
    await db.close();
  }
});

test("expired delivery lease recovers fail-closed and cannot send again", async () => {
  const db = await setup();
  try {
    await prepareRetry(db);
    assert.equal(
      (await db.query(
        "select public.claim_content_factory_leads_canary_retry_delivery($1,$2,$3,now()+interval '20 milliseconds') as ok",
        [user, run, lease],
      )).rows[0].ok,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      (await db.query(
        "select public.recover_content_factory_leads_canary_retry_delivery($1) as recovered",
        [user],
      )).rows[0].recovered,
      true,
    );
    assert.deepEqual(
      (await db.query(
        "select state,rollback_reason,delivery_attempts from public.telegram_attribution_canary_retry_runs",
      )).rows[0],
      {
        state: "ROLLBACK_REQUIRED",
        rollback_reason: "DELIVERY_AMBIGUOUS",
        delivery_attempts: 1,
      },
    );
    assert.deepEqual(
      (await db.query(
        "select status from public.telegram_attribution_tokens where token_digest=$1",
        [newTokenDigest],
      )).rows[0],
      { status: "REVOKED" },
    );
    assert.deepEqual(
      (await db.query(
        "select status,error from public.posts where id=(select telegram_post_id from public.telegram_attribution_canary_retry_runs)",
      )).rows[0],
      { status: "failed", error: "POST13D_DELIVERY_AMBIGUOUS" },
    );
    assert.equal(
      (await db.query(
        "select public.claim_content_factory_leads_canary_retry_delivery($1,$2,$3,now()+interval '2 minutes') as ok",
        [user, run, "70000000-0000-4000-8000-000000000014"],
      )).rows[0].ok,
      false,
    );
  } finally {
    await db.close();
  }
});

test("ambiguous claimed delivery revokes token and cannot become PASS", async () => {
  const db = await setup();
  try {
    await prepareRetry(db);
    await db.query(
      "select public.claim_content_factory_leads_canary_retry_delivery($1,$2,$3,now()+interval '2 minutes')",
      [user, run, lease],
    );
    assert.equal(
      (await db.query(
        "select public.rollback_content_factory_leads_canary_retry($1,$2,'DELIVERY_AMBIGUOUS',false,null) as ok",
        [user, run],
      )).rows[0].ok,
      true,
    );
    assert.deepEqual(
      (await db.query("select state,delivery_attempts from public.telegram_attribution_canary_retry_runs")).rows[0],
      { state: "ROLLBACK_REQUIRED", delivery_attempts: 1 },
    );
    assert.equal(
      (await db.query(
        "select public.claim_content_factory_leads_canary_retry_delivery($1,$2,$3,now()+interval '2 minutes') as ok",
        [user, run, "70000000-0000-4000-8000-000000000014"],
      )).rows[0].ok,
      false,
    );
  } finally {
    await db.close();
  }
});
