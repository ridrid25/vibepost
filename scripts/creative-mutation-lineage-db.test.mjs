import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "../tools/post09-db-harness/node_modules/@electric-sql/pglite/dist/index.js";

const migration = readFileSync("supabase/migrations/20260831000006_creative_mutation_lineage.sql", "utf8");
const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const id = (number) => `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const creative = (char) => `creative-${char.repeat(64)}`;

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
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role',true),'')
$$;
create function extensions.digest(p_value bytea,p_algorithm text) returns bytea
language sql immutable strict as $$
  select decode(md5(convert_from(p_value,'UTF8'))||md5('post09:'||convert_from(p_value,'UTF8')),'hex')
$$;
create function public.canonical_jsonb_text(p_value jsonb)
returns text language plpgsql immutable strict set search_path='' as $$
declare v_result text;
begin
  case jsonb_typeof(p_value)
    when 'object' then select '{'||coalesce(string_agg(to_jsonb(e.key)::text||':'||
      public.canonical_jsonb_text(e.value),',' order by e.key),'')||'}' into v_result
      from jsonb_each(p_value) e;
    when 'array' then select '['||coalesce(string_agg(public.canonical_jsonb_text(a.value),','
      order by a.ordinality),'')||']' into v_result
      from jsonb_array_elements(p_value) with ordinality a(value,ordinality);
    else v_result:=p_value::text;
  end case;
  return v_result;
end; $$;

create table auth.users(id uuid primary key);
create table public.videos(
  id uuid primary key,user_id uuid not null,tiktok_video_id text,duration_seconds integer,
  topic text,content_format text,hook_type text,experiment_id uuid,hypothesis_id uuid,
  character_id text,visual_style_id text,pacing_profile text,punch_type text,loop_type text,
  camera_profile text,prompt_framework_version text,unique(id,user_id)
);
create table public.content_hypotheses(
  id uuid primary key,user_id uuid not null,statement text not null,changed_variable text not null,
  expected_effect text not null,constants jsonb not null default '{}',unique(id,user_id)
);
create table public.creative_identity_map(
  id uuid primary key,user_id uuid not null,creative_id text not null,
  platform text not null,tiktok_video_row_id uuid,youtube_short_row_id uuid,
  unique(id,user_id)
);
create table public.experiments(
  id uuid primary key,user_id uuid not null,hypothesis_id uuid,hypothesis text not null,
  changed_variable text not null,constants jsonb not null default '{}',success_metrics jsonb not null default '{}',
  control_video_id uuid,result text,confidence text not null default 'LOW',lessons text,
  status text not null default 'OPEN',created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),platform text not null default 'tiktok',
  control_youtube_short_id uuid,variant_youtube_short_id uuid,control_identity_map_id uuid,
  variant_identity_map_id uuid,control_creative_id text,variant_creative_id text,
  control_material_vector jsonb,variant_material_vector jsonb,metric_source text,unique(id,user_id)
);
alter table public.videos add foreign key(experiment_id,user_id) references public.experiments(id,user_id);
create table public.content_analysis_results(
  id uuid primary key,user_id uuid not null,video_id uuid,experiment_id uuid,
  checkpoint text not null,conclusion text not null,evidence jsonb not null default '[]',
  metrics jsonb not null default '{}',metric_sources jsonb not null default '{}',
  confidence text not null,sample_size jsonb not null default '{}',limitations jsonb not null default '[]',
  expected jsonb not null default '{}',actual jsonb not null default '{}',
  created_at timestamptz not null default now(),platform text not null default 'tiktok',
  youtube_short_id uuid,youtube_snapshot_polled_at timestamptz,unique(id,user_id)
);
create table public.content_lessons(
  id uuid primary key,user_id uuid not null,lesson text not null,category text not null,
  evidence jsonb not null default '[]',confidence text not null default 'LOW',
  status text not null default 'HYPOTHESIS',created_at timestamptz not null default now(),
  unique(id,user_id)
);
create table public.content_lesson_youtube_publications(
  lesson_id uuid not null,user_id uuid not null,experiment_id uuid not null,
  short_id uuid,created_at timestamptz not null default now()
);
grant select,insert,update,delete on all tables in schema public to authenticated,service_role;
`;

async function setup() {
  const db = new PGlite();
  await db.exec(bootstrap);
  await db.exec(migration);
  await db.query("insert into auth.users(id) values ($1),($2)", [userA, userB]);
  return db;
}

async function asRole(db, role, userId, operation) {
  await db.exec(`set role ${role}`);
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)",
    [userId, role]);
  try { return await operation(); } finally { await db.exec("reset role"); }
}

async function expectDatabaseError(operation, pattern) {
  await assert.rejects(operation, (error) => pattern.test(String(error?.message)));
}

async function identity(db, number, owner, creativeId, platform = "tiktok", videoId = null) {
  const rowId = id(number);
  await db.query(`insert into public.creative_identity_map
    (id,user_id,creative_id,platform,tiktok_video_row_id)
    values ($1,$2,$3,$4,$5)`, [rowId, owner, creativeId, platform, videoId]);
  return rowId;
}

async function hypothesis(db, number, owner, changedVariable, constants) {
  const rowId = id(number);
  await db.query(`insert into public.content_hypotheses
    (id,user_id,statement,changed_variable,expected_effect,constants)
    values ($1,$2,'One controlled change',$3,'Improve metric',$4)`,
  [rowId, owner, changedVariable, constants]);
  return rowId;
}

test("exact POST-09 migration executes in a disposable PostgreSQL-compatible database", async (t) => {
  const db = await setup(); t.after(() => db.close());
  const tables = await db.query("select tablename from pg_tables where schemaname='public' and tablename='creative_mutations'");
  assert.equal(tables.rows.length, 1);
  const columns = await db.query("select column_name from information_schema.columns where table_name='experiments' and column_name like 'lineage_%'");
  assert.equal(columns.rows.length, 6);
});

test("service registration is owner-scoped, idempotent, immutable, branching and cycle-safe", async (t) => {
  const db = await setup(); t.after(() => db.close());
  const A = creative("a"), B = creative("b"), C = creative("c"), D = creative("d"), E = creative("e");
  const a = await identity(db,1,userA,A), b = await identity(db,2,userA,B);
  const c = await identity(db,3,userA,C), d = await identity(db,4,userA,D), e = await identity(db,5,userA,E);
  const h1 = await hypothesis(db,10,userA,"hook_type",{});
  const h2 = await hypothesis(db,11,userA,"pacing_profile",{});
  const register = async (childId,childCreative,parentId,parentCreative,variable,hypothesisId) =>
    await asRole(db,"service_role",userA,() => db.query(
      "select id,child_creative_id from public.register_creative_mutation($1,$2,$3,$4,$5,'CONTROLLED_MUTATION',$6,'Controlled test',$7,null)",
      [userA,childId,childCreative,parentId,parentCreative,variable,hypothesisId]));
  const first = await register(b,B,a,A,"hook_type",h1);
  const replay = await register(b,B,a,A,"hook_type",h1);
  assert.equal(first.rows[0].id, replay.rows[0].id);
  await register(c,C,a,A,"pacing_profile",h2);
  const children = await asRole(db,"authenticated",userA,() =>
    db.query("select child_creative_id from public.get_creative_children($1,$2)",[userA,A]));
  assert.deepEqual(children.rows.map((row) => row.child_creative_id), [B,C]);
  await expectDatabaseError(() => register(b,B,c,C,"hook_type",h1), /MUTATION_REPLAY_CONFLICT/);
  const cycleResults=await asRole(db,"service_role",userA,()=>Promise.allSettled([
    db.query("select * from public.register_creative_mutation($1,$2,$3,$4,$5,'CONTROLLED_MUTATION','hook_type','Edge D',$6,null)",
      [userA,d,D,e,E,h1]),
    db.query("select * from public.register_creative_mutation($1,$2,$3,$4,$5,'CONTROLLED_MUTATION','hook_type','Edge E',$6,null)",
      [userA,e,E,d,D,h1]),
  ]));
  assert.equal(cycleResults.filter((row)=>row.status==="fulfilled").length,1);
  assert.equal(cycleResults.filter((row)=>row.status==="rejected" &&
    /MUTATION_CONTRACT_VIOLATION/.test(String(row.reason?.message))).length,1);
  const descendants = await asRole(db,"authenticated",userA,() =>
    db.query("select * from public.get_creative_descendants($1,$2)",[userA,A]));
  assert.equal(descendants.rows.length,2);
  await expectDatabaseError(() => db.query("update public.creative_mutations set mutation_reason='rewrite' where id=$1",
    [first.rows[0].id]), /MUTATION_HISTORY_IMMUTABLE/);
});

test("RLS and function owner checks block cross-user reads and direct writes", async (t) => {
  const db = await setup(); t.after(() => db.close());
  const A = creative("a"); await identity(db,1,userA,A);
  await asRole(db,"service_role",userA,() => db.query(
    "select * from public.register_creative_mutation($1,$2,$3,null,null,'NEW_CONCEPT',null,null,null,null)",
    [userA,id(1),A]));
  const own = await asRole(db,"authenticated",userA,() => db.query("select * from public.creative_mutations"));
  const foreign = await asRole(db,"authenticated",userB,() => db.query("select * from public.creative_mutations"));
  assert.equal(own.rows.length,1); assert.equal(foreign.rows.length,0);
  await expectDatabaseError(() => asRole(db,"authenticated",userA,() => db.query(
    "insert into public.creative_mutations(id,user_id,child_identity_map_id,child_creative_id,mutation_kind) values ($1,$2,$3,$4,'NEW_CONCEPT')",
    [id(99),userA,id(1),creative("f")])), /permission denied/);
  const foreignFunction = await asRole(db,"authenticated",userB,() =>
    db.query("select * from public.get_creative_lineage_chain($1,$2)",[userA,A]));
  assert.equal(foreignFunction.rows.length,0);
  await expectDatabaseError(() => asRole(db,"authenticated",userA,() => db.query(
    `insert into public.experiments(id,user_id,hypothesis,changed_variable,creative_mutation_id,
      lineage_material_schema,lineage_parent_material_vector,lineage_child_material_vector,
      lineage_constants_snapshot,lineage_material_diff,lineage_contract_hash)
     values($1,$2,'forged','hook_type',$3,'tiktok_v1','{}','{}','{}','{}',$4)`,
    [id(98),userA,id(97),"a".repeat(64)])), /MUTATION_LINEAGE_SERVICE_ONLY|permission denied/);
  await expectDatabaseError(() => asRole(db,"authenticated",userA,() => db.query(
    "update public.experiments set lineage_contract_hash=$1 where id=$2",["b".repeat(64),id(98)])),
  /permission denied/);
});

test("TikTok binding proves one change, attributes existing metrics and traverses lessons", async (t) => {
  const db = await setup(); t.after(() => db.close());
  const A=creative("a"),B=creative("b"), videoA=id(30),videoB=id(31);
  const mapA=await identity(db,1,userA,A,"tiktok",videoA), mapB=await identity(db,2,userA,B,"tiktok",videoB);
  const fields={topic:"animals",content_format:"story",character_id:"cat",visual_style_id:"real",
    pacing_profile:"steady",punch_type:"surprise",loop_type:"closed",camera_profile:"static",
    prompt_framework_version:"v1"};
  await db.query(`insert into public.videos(id,user_id,tiktok_video_id,duration_seconds,hook_type,
    topic,content_format,character_id,visual_style_id,pacing_profile,punch_type,loop_type,camera_profile,prompt_framework_version)
    values ($1,$2,'a',12,'calm',$3,$4,$5,$6,$7,$8,$9,$10,$11),
           ($12,$2,'b',12,'interrupt',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [videoA,userA,fields.topic,fields.content_format,fields.character_id,fields.visual_style_id,
    fields.pacing_profile,fields.punch_type,fields.loop_type,fields.camera_profile,fields.prompt_framework_version,videoB]);
  const constants={topic:"animals",content_format:"story",duration_bin:"10-14",character_id:"cat",
    visual_style_id:"real",pacing_profile:"steady",punch_type:"surprise",loop_type:"closed",
    camera_profile:"static",prompt_framework_version:"v1"};
  const h=await hypothesis(db,10,userA,"hook_type",constants); const experiment=id(20);
  await db.query(`insert into public.experiments(id,user_id,hypothesis_id,hypothesis,changed_variable,
    constants,success_metrics,control_video_id,platform)
    values($1,$2,$3,'Mismatched hypothesis text','hook_type',$4,$5,$6,'tiktok')`,
  [experiment,userA,h,constants,{primary_metric:"like_rate",checkpoint:"24h"},videoA]);
  await db.query("update public.videos set experiment_id=$1,hypothesis_id=$2 where id=$3",[experiment,h,videoB]);
  const mutation = await asRole(db,"service_role",userA,() => db.query(
    "select id from public.register_creative_mutation($1,$2,$3,$4,$5,'CONTROLLED_MUTATION','hook_type','Hook test',$6,null)",
    [userA,mapB,B,mapA,A,h]));
  const mutationId=mutation.rows[0].id;
  await expectDatabaseError(() => asRole(db,"service_role",userA,()=>db.query(
    "select id from public.bind_experiment_creative_mutation($1,$2,$3)",[userA,experiment,mutationId])),
  /MUTATION_CONTRACT_VIOLATION/);
  await db.query("update public.experiments set hypothesis='One controlled change' where id=$1",[experiment]);
  const bound=await asRole(db,"service_role",userA,()=>db.query(
    "select creative_mutation_id,lineage_material_diff,lineage_contract_hash from public.bind_experiment_creative_mutation($1,$2,$3)",
    [userA,experiment,mutationId]));
  assert.equal(bound.rows[0].creative_mutation_id,mutationId);
  assert.deepEqual(bound.rows[0].lineage_material_diff.changed_material_variables,["hook_type"]);
  const replay=await asRole(db,"service_role",userA,()=>db.query(
    "select lineage_contract_hash from public.bind_experiment_creative_mutation($1,$2,$3)",[userA,experiment,mutationId]));
  assert.equal(replay.rows[0].lineage_contract_hash,bound.rows[0].lineage_contract_hash);
  await db.query(`insert into public.content_analysis_results(id,user_id,video_id,experiment_id,checkpoint,
    conclusion,metrics,metric_sources,confidence,platform,limitations)
    values($1,$2,$3,$4,'24h','PASS',$5,$6,'MEDIUM','tiktok','[]')`,
  [id(40),userA,videoB,experiment,{primary_metric:"like_rate",control_rate:0.1,variant_rate:0.15},{like_rate:"api"}]);
  const attribution=await asRole(db,"authenticated",userA,()=>db.query(
    "select public.resolve_creative_mutation_attribution($1,$2) value",[userA,experiment]));
  assert.equal(attribution.rows[0].value.verdict,"PASS");
  assert.equal(attribution.rows[0].value.metric_delta.absolute_delta,0.05);
  const lesson=id(50);
  await db.query("insert into public.content_lessons(id,user_id,lesson,category,evidence) values($1,$2,'Hook works','WINNING_PATTERN',$3)",
    [lesson,userA,[{experiment_id:experiment}]]);
  const traversal=await asRole(db,"authenticated",userA,()=>db.query(
    "select public.resolve_lesson_mutation_lineage($1,$2) value",[userA,lesson]));
  assert.equal(traversal.rows[0].value[0].child_creative_id,B);
});

test("YouTube binding and attribution reuse existing material vectors and preserve UNKNOWN policy", async (t) => {
  const db=await setup();t.after(()=>db.close());
  const X=creative("e"),Y=creative("f");
  const anchorX=await identity(db,58,userA,X,"tiktok"),anchorY=await identity(db,59,userA,Y,"tiktok");
  const mapX=await identity(db,60,userA,X,"youtube_shorts"),mapY=await identity(db,61,userA,Y,"youtube_shorts");
  const parent={causal_pattern_class:"EXPECTATION",payoff_class:"REVEAL",prompt_framework_version:"v2",fidelity_constraints_hash:"hash-a"};
  const child={...parent,payoff_class:"REVERSAL"}; const constants={causal_pattern_class:"EXPECTATION",prompt_framework_version:"v2",fidelity_constraints_hash:"hash-a"};
  const h=await hypothesis(db,62,userA,"payoff_class",constants);const experiment=id(63);
  await db.query(`insert into public.experiments(id,user_id,hypothesis_id,hypothesis,changed_variable,constants,
    success_metrics,platform,control_identity_map_id,variant_identity_map_id,control_creative_id,
    variant_creative_id,control_material_vector,variant_material_vector,metric_source)
    values($1,$2,$3,'One controlled change','payoff_class',$4,$5,'youtube_shorts',$6,$7,$8,$9,$10,$11,'youtube')`,
  [experiment,userA,h,constants,{primary_metric:"like_rate",checkpoint:"24h"},mapX,mapY,X,Y,parent,child]);
  const mutation=await asRole(db,"service_role",userA,()=>db.query(
    "select id from public.register_creative_mutation($1,$2,$3,$4,$5,'CONTROLLED_MUTATION','payoff_class','Payoff test',$6,null)",
    [userA,anchorY,Y,anchorX,X,h]));
  const replay=await asRole(db,"service_role",userA,()=>db.query(
    "select id from public.register_creative_mutation($1,$2,$3,$4,$5,'CONTROLLED_MUTATION','payoff_class','Payoff test',$6,null)",
    [userA,mapY,Y,mapX,X,h]));
  assert.equal(replay.rows[0].id,mutation.rows[0].id);
  await asRole(db,"service_role",userA,()=>db.query(
    "select id from public.bind_experiment_creative_mutation($1,$2,$3)",[userA,experiment,mutation.rows[0].id]));
  await db.query(`insert into public.content_analysis_results(id,user_id,experiment_id,checkpoint,conclusion,
    metric_sources,confidence,actual,platform,limitations)
    values($1,$2,$3,'24h','FAIL',$4,'MEDIUM',$5,'youtube_shorts','[]')`,
  [id(64),userA,experiment,{store:"published_shorts_stats",
    control_snapshot:{short_id:id(65),polled_at:"2026-08-31T00:00:00+00:00"},
    variant_snapshot:{short_id:id(66),polled_at:"2026-08-31T00:00:00+00:00"}},
    {control_rate:0.08,variant_rate:0.04}]);
  let result=await asRole(db,"authenticated",userA,()=>db.query(
    "select public.resolve_creative_mutation_attribution($1,$2) value",[userA,experiment]));
  assert.equal(result.rows[0].value.metric_delta.relative_delta_pct,-50);
  await db.query("update public.content_analysis_results set metric_sources=$1 where id=$2",
    [{store:"published_shorts_stats",control_snapshot:{short_id:id(65),polled_at:"August 31, 2026"},
      variant_snapshot:{short_id:id(66),polled_at:"2026-08-31T00:00:00+00:00"}},id(64)]);
  result=await asRole(db,"authenticated",userA,()=>db.query(
    "select public.resolve_creative_mutation_attribution($1,$2) value",[userA,experiment]));
  assert.equal(result.rows[0].value.control_metrics,"UNKNOWN");
  await db.query("update public.content_analysis_results set metric_sources=$1 where id=$2",
    [{store:"published_shorts_stats",control_snapshot:{short_id:id(65),polled_at:"2026-02-31T00:00:00Z"},
      variant_snapshot:{short_id:id(66),polled_at:"2026-08-31T00:00:00+00:00"}},id(64)]);
  result=await asRole(db,"authenticated",userA,()=>db.query(
    "select public.resolve_creative_mutation_attribution($1,$2) value",[userA,experiment]));
  assert.equal(result.rows[0].value.control_metrics,"UNKNOWN");
  await db.query("update public.content_analysis_results set metric_sources=$1 where id=$2",
    [{store:"published_shorts_stats",control_snapshot:{short_id:"UNKNOWN",polled_at:"UNKNOWN"},
      variant_snapshot:{short_id:id(66),polled_at:"2026-08-31T00:00:00Z"}},id(64)]);
  result=await asRole(db,"authenticated",userA,()=>db.query(
    "select public.resolve_creative_mutation_attribution($1,$2) value",[userA,experiment]));
  assert.equal(result.rows[0].value.control_metrics,"UNKNOWN");
  const lesson=id(67);
  await db.query("insert into public.content_lessons(id,user_id,lesson,category,evidence) values($1,$2,'Payoff evidence','FAILED_PATTERN','[]')",
    [lesson,userA]);
  await db.query("insert into public.content_lesson_youtube_publications(lesson_id,user_id,experiment_id,short_id) values($1,$2,$3,$4)",
    [lesson,userA,experiment,id(66)]);
  const forward=await asRole(db,"authenticated",userA,()=>db.query(
    "select public.resolve_lesson_mutation_lineage($1,$2) value",[userA,lesson]));
  const reverse=await asRole(db,"authenticated",userA,()=>db.query(
    "select public.resolve_creative_lesson_lineage($1,$2) value",[userA,Y]));
  assert.equal(forward.rows[0].value[0].child_creative_id,Y);
  assert.equal(reverse.rows[0].value[0].lesson_id,lesson);
});
