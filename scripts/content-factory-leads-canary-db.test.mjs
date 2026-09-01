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

const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const botA = "20000000-0000-4000-8000-000000000001";
const chatA = "30000000-0000-4000-8000-000000000001";
const mainChatA = "30000000-0000-4000-8000-000000000002";
const mapA = "40000000-0000-4000-8000-000000000001";
const postA = "50000000-0000-4000-8000-000000000001";
const sentinelA = "50000000-0000-4000-8000-000000000002";
const sentinelB = "50000000-0000-4000-8000-000000000003";
const tokenDigest = "a".repeat(64);
const credentialDigest = "b".repeat(64);

const bootstrap = String.raw`
create schema auth;
create schema extensions;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public,auth,extensions to anon,authenticated,service_role;
create function extensions.digest(data bytea, algorithm text) returns bytea
language sql immutable as $$
  select decode(md5(encode(data,'hex')) || md5('post13c:' || encode(data,'hex')),'hex')
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create table auth.users(id uuid primary key);
create table public.bots(id uuid primary key,user_id uuid not null references auth.users(id));
create table public.chats(
  id uuid primary key,user_id uuid not null references auth.users(id),
  bot_id uuid not null references public.bots(id),telegram_chat_id text not null,
  type text not null
);
create table public.posts(
  id uuid primary key,user_id uuid not null references auth.users(id),
  bot_id uuid not null references public.bots(id),chat_id uuid not null references public.chats(id),
  format text not null,status text not null,tg_message_id bigint,inline_buttons jsonb,text text
);
create table public.creative_identity_map(
  id uuid primary key,user_id uuid not null references auth.users(id),creative_id text not null
);
grant select on public.posts,public.bots,public.chats,public.creative_identity_map to authenticated,service_role;
`;

async function setup() {
  const db = new PGlite();
  await db.exec(bootstrap);
  await db.exec(prerequisite);
  await db.exec(post12);
  await db.exec(post13c);
  await db.query("insert into auth.users(id) values ($1),($2)", [userA, userB]);
  await db.query("insert into public.bots(id,user_id) values ($1,$2)", [
    botA,
    userA,
  ]);
  await db.query(
    "insert into public.chats(id,user_id,bot_id,telegram_chat_id,type) values ($1,$2,$3,$4,'channel'),($5,$2,$3,$6,'channel')",
    [chatA, userA, botA, "-1001234567890", mainChatA, "-1009876543210"],
  );
  await db.query(
    "insert into public.posts(id,user_id,bot_id,chat_id,format,status,tg_message_id,inline_buttons,text) values ($1,$2,$3,$4,'text','sent',77,null,'canary'),($5,$2,$3,$6,'text','sent',78,null,'sentinel-a'),($7,$2,$3,$6,'text','sent',79,null,'sentinel-b')",
    [postA, userA, botA, chatA, sentinelA, mainChatA, sentinelB],
  );
  await db.query(
    "insert into public.creative_identity_map(id,user_id,creative_id) values ($1,$2,$3)",
    [mapA, userA, `creative-${"c".repeat(64)}`],
  );
  await db.query(
    "select public.freeze_content_factory_leads_canary_scope($1,$2,$3,$4,$5,$6,$7)",
    [
      userA,
      chatA,
      "-1001234567890",
      mainChatA,
      "-1009876543210",
      sentinelA,
      sentinelB,
    ],
  );
  return db;
}

async function activateRuntime(db) {
  assert.equal(
    (await db.query(
      "select public.authorize_content_factory_leads_canary($1,now()+interval '10 minutes') as ok",
      [credentialDigest],
    )).rows[0].ok,
    true,
  );
  const lease = "60000000-0000-4000-8000-000000000001";
  assert.equal(
    (await db.query(
      "select public.claim_content_factory_leads_canary_activation($1,$2,now()+interval '2 minutes') as ok",
      [credentialDigest, lease],
    )).rows[0].ok,
    true,
  );
  assert.equal(
    (await db.query(
      "select public.complete_content_factory_leads_canary_activation($1,$2,$3) as ok",
      [lease, "d".repeat(64), "e".repeat(64)],
    )).rows[0].ok,
    true,
  );
}

async function prepareRun(db) {
  return (await db.query(
    "select r.* from public.prepare_content_factory_leads_canary_run($1,$2,$3,$4) r",
    [userA, mapA, postA, tokenDigest],
  )).rows[0];
}

test("activation authorization is one-use, expiring and fail-closed", async () => {
  const db = await setup();
  try {
    assert.equal(
      (await db.query(
        "select public.authorize_content_factory_leads_canary($1,now()+interval '10 minutes') as ok",
        [credentialDigest],
      )).rows[0].ok,
      true,
    );
    const lease = "60000000-0000-4000-8000-000000000001";
    assert.equal(
      (await db.query(
        "select public.claim_content_factory_leads_canary_activation($1,$2,now()+interval '2 minutes') as ok",
        ["f".repeat(64), lease],
      )).rows[0].ok,
      false,
    );
    assert.equal(
      (await db.query(
        "select public.claim_content_factory_leads_canary_activation($1,$2,now()+interval '2 minutes') as ok",
        [credentialDigest, lease],
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select public.claim_content_factory_leads_canary_activation($1,$2,now()+interval '2 minutes') as ok",
        [credentialDigest, "60000000-0000-4000-8000-000000000002"],
      )).rows[0].ok,
      false,
    );
    assert.equal(
      (await db.query(
        "select public.complete_content_factory_leads_canary_activation($1,$2,$3) as ok",
        [lease, "d".repeat(64), "e".repeat(64)],
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query("select state from public.telegram_canary_runtime_state"))
        .rows[0].state,
      "ACTIVE",
    );
  } finally {
    await db.close();
  }
});

test("lost activation-finalize responses can terminate ACTIVE runtime by credential proof", async () => {
  const db = await setup();
  try {
    await activateRuntime(db);
    assert.equal(
      (await db.query(
        "select public.mark_content_factory_leads_canary_rollback_required($1,$2) as ok",
        ["60000000-0000-4000-8000-000000000001", "0".repeat(64)],
      )).rows[0].ok,
      false,
    );
    assert.equal(
      (await db.query(
        "select public.mark_content_factory_leads_canary_rollback_required($1,$2) as ok",
        ["60000000-0000-4000-8000-000000000001", credentialDigest],
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select public.complete_content_factory_leads_canary_deactivation($1) as ok",
        [credentialDigest],
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select state from public.telegram_canary_runtime_state",
      )).rows[0].state,
      "ROLLED_BACK",
    );
  } finally {
    await db.close();
  }
});

test("uncertain claim terminalizes AUTHORIZED runtime and authorization cannot replay", async () => {
  const db = await setup();
  try {
    assert.equal(
      (await db.query(
        "select public.authorize_content_factory_leads_canary($1,now()+interval '10 minutes') as ok",
        [credentialDigest],
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select public.complete_content_factory_leads_canary_deactivation($1) as ok",
        [credentialDigest],
      )).rows[0].ok,
      true,
    );
    const runtime = (await db.query(
      "select state,activation_attempts,activation_authorization_digest from public.telegram_canary_runtime_state",
    )).rows[0];
    assert.deepEqual(runtime, {
      state: "ROLLED_BACK",
      activation_attempts: 1,
      activation_authorization_digest: null,
    });
    assert.equal(
      (await db.query(
        "select public.claim_content_factory_leads_canary_activation($1,$2,now()+interval '2 minutes') as ok",
        [credentialDigest, "60000000-0000-4000-8000-000000000099"],
      )).rows[0].ok,
      false,
    );
  } finally {
    await db.close();
  }
});

test("one truthful post and one dedicated token are frozen immutably", async () => {
  const db = await setup();
  try {
    await activateRuntime(db);
    const run = await prepareRun(db);
    assert.equal(run.destination, "content_factory_leads_canary");
    assert.equal(run.telegram_post_id, postA);
    assert.equal(run.state, "TOKEN_ISSUED");
    await assert.rejects(prepareRun(db), /canary_run_already_exists/u);
    assert.equal(
      (await db.query(
        "select public.mark_content_factory_leads_canary_cta_active($1) as ok",
        ["f".repeat(64)],
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select count(*)::int as count from public.telegram_attribution_tokens where destination='content_factory_leads_canary'",
      )).rows[0].count,
      1,
    );
    await assert.rejects(
      db.query(
        "update public.telegram_attribution_canary_runs set telegram_post_id=$1 where singleton_key='POST13C'",
        ["50000000-0000-4000-8000-000000000002"],
      ),
      /telegram_canary_run_immutable/u,
    );
    await assert.rejects(
      db.query(
        "update public.telegram_canary_scope_freeze set test_chat_id=$1 where singleton_key='POST13C'",
        [mainChatA],
      ),
      /telegram_canary_event_immutable/u,
    );
  } finally {
    await db.close();
  }
});

test("BOT_START and explicit CANARY_LEAD_CREATED are separate, replay-safe and PII-free", async () => {
  const db = await setup();
  try {
    await activateRuntime(db);
    await prepareRun(db);
    await db.query(
      "select public.mark_content_factory_leads_canary_cta_active($1)",
      ["f".repeat(64)],
    );
    const subject = `subject_${"1".repeat(64)}`;
    const update1 = `update_${"2".repeat(64)}`;
    const update2 = `update_${"3".repeat(64)}`;
    assert.equal(
      (await db.query(
        "select public.record_content_factory_leads_bot_start($1,$2,$3) as ok",
        [tokenDigest, subject, update1],
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select public.record_content_factory_leads_bot_start($1,$2,$3) as ok",
        [tokenDigest, subject, update1],
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select public.record_content_factory_leads_canary_lead($1,$2) as ok",
        [subject, update2],
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select public.record_content_factory_leads_canary_lead($1,$2) as ok",
        [subject, update2],
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select public.record_content_factory_leads_bot_start($1,$2,$3) as ok",
        [
          "9".repeat(64),
          `subject_${"4".repeat(64)}`,
          `update_${"5".repeat(64)}`,
        ],
      )).rows[0].ok,
      false,
    );

    const events = (await db.query(
      "select event_type,attribution_quality,provenance from public.telegram_canary_attribution_events order by event_type",
    )).rows;
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((row) => row.event_type), [
      "BOT_START",
      "CANARY_LEAD_CREATED",
    ]);
    assert.deepEqual(events.map((row) => row.attribution_quality), [
      "DIRECT_LINK",
      "DETERMINISTIC_CANARY",
    ]);
    assert.equal(
      events.every((row) => row.provenance.test_only === true),
      true,
    );
    await assert.rejects(
      db.query("delete from public.telegram_canary_attribution_events"),
      /telegram_canary_event_immutable/u,
    );
  } finally {
    await db.close();
  }
});

test("callback without BOT_START, cross-owner RLS and uncertain deactivation fail closed", async () => {
  const db = await setup();
  try {
    await activateRuntime(db);
    await prepareRun(db);
    await db.query(
      "select public.mark_content_factory_leads_canary_cta_active($1)",
      ["f".repeat(64)],
    );
    assert.equal(
      (await db.query(
        "select public.record_content_factory_leads_canary_lead($1,$2) as ok",
        [`subject_${"6".repeat(64)}`, `update_${"7".repeat(64)}`],
      )).rows[0].ok,
      false,
    );

    await db.exec("set role authenticated");
    await db.exec(
      `select set_config('request.jwt.claim.sub','${userB}',false)`,
    );
    assert.equal(
      (await db.query(
        "select count(*)::int as count from public.telegram_attribution_canary_runs",
      )).rows[0].count,
      0,
    );
    assert.equal(
      (await db.query(
        "select count(*)::int as count from public.telegram_canary_attribution_events",
      )).rows[0].count,
      0,
    );
    await db.exec("reset role");

    assert.equal(
      (await db.query(
        "select public.begin_content_factory_leads_canary_deactivation() as ok",
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select public.complete_content_factory_leads_canary_deactivation($1) as ok",
        ["0".repeat(64)],
      )).rows[0].ok,
      false,
    );
    assert.equal(
      (await db.query(
        "select state from public.telegram_canary_runtime_state",
      )).rows[0].state,
      "DEACTIVATING",
    );
    assert.equal(
      (await db.query(
        "select public.complete_content_factory_leads_canary_deactivation($1) as ok",
        [credentialDigest],
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select state from public.telegram_canary_runtime_state",
      )).rows[0].state,
      "ROLLED_BACK",
    );
  } finally {
    await db.close();
  }
});

test("count/hash audit exposes no rows and reports a single deterministic canary", async () => {
  const db = await setup();
  try {
    await activateRuntime(db);
    await prepareRun(db);
    await db.query(
      "select public.mark_content_factory_leads_canary_cta_active($1)",
      ["f".repeat(64)],
    );
    await db.query(
      "select public.record_content_factory_leads_bot_start($1,$2,$3)",
      [tokenDigest, `subject_${"1".repeat(64)}`, `update_${"2".repeat(64)}`],
    );
    await db.query(
      "select public.record_content_factory_leads_canary_lead($1,$2)",
      [`subject_${"1".repeat(64)}`, `update_${"3".repeat(64)}`],
    );
    const audit = (await db.query(
      "select * from public.audit_content_factory_leads_canary('ACTIVE_COMPLETE') order by check_name",
    )).rows;
    assert.equal(audit.length, 13);
    assert.equal(audit.every((row) => row.passed === true), true);
    assert.equal(
      audit.every((row) => /^[0-9a-f]{64}$/u.test(row.state_hash)),
      true,
    );
    assert.equal(
      audit.every((row) => row.audit_version === "POST13C_AUDIT_V2"),
      true,
    );
    assert.deepEqual(
      Object.keys(audit[0]).sort(),
      ["audit_version", "check_name", "passed", "row_count", "state_hash"]
        .sort(),
    );
  } finally {
    await db.close();
  }
});

test("versioned audit fails on service-role DML, function ACL and schema drift", async () => {
  const db = await setup();
  try {
    await activateRuntime(db);
    await prepareRun(db);
    await db.query(
      "select public.mark_content_factory_leads_canary_cta_active($1)",
      ["f".repeat(64)],
    );
    const subject = `subject_${"1".repeat(64)}`;
    await db.query(
      "select public.record_content_factory_leads_bot_start($1,$2,$3)",
      [tokenDigest, subject, `update_${"2".repeat(64)}`],
    );
    await db.query(
      "select public.record_content_factory_leads_canary_lead($1,$2)",
      [subject, `update_${"3".repeat(64)}`],
    );

    await db.exec(
      "grant insert on public.telegram_canary_attribution_events to service_role",
    );
    await db.exec(
      "grant execute on function public.record_content_factory_leads_bot_start(text,text,text) to authenticated",
    );
    await db.exec(
      "alter table public.telegram_canary_attribution_events add column schema_drift text",
    );
    const audit = (await db.query(
      "select check_name,passed from public.audit_content_factory_leads_canary('ACTIVE_COMPLETE')",
    )).rows;
    const byName = Object.fromEntries(
      audit.map((row) => [row.check_name, row.passed]),
    );
    assert.equal(byName.WRITE_ACL_VIOLATIONS, false);
    assert.equal(byName.FUNCTION_ACL_VIOLATIONS, false);
    assert.equal(byName.SCHEMA_HASH, false);
  } finally {
    await db.close();
  }
});

test("frozen scope rejects main-channel/sentinel substitutions and revoke is idempotent", async () => {
  const db = await setup();
  try {
    await activateRuntime(db);
    await assert.rejects(
      db.query(
        "select r.* from public.prepare_content_factory_leads_canary_run($1,$2,$3,$4) r",
        [userA, mapA, sentinelA, tokenDigest],
      ),
      /canary_post_not_eligible/u,
    );
    const run = await prepareRun(db);
    assert.equal(run.chat_id, chatA);
    assert.equal(
      (await db.query(
        "select public.ensure_content_factory_leads_canary_token_revoked() as ok",
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select public.ensure_content_factory_leads_canary_token_revoked() as ok",
      )).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query(
        "select status from public.telegram_attribution_tokens where id=$1",
        [run.token_id],
      )).rows[0].status,
      "REVOKED",
    );
  } finally {
    await db.close();
  }
});
