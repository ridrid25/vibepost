import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "../tools/post09-db-harness/node_modules/@electric-sql/pglite/dist/index.js";
import { evaluateLessonsForFeedback } from "../supabase/functions/_shared/lesson-effective-weight.mjs";

const migration = readFileSync("supabase/migrations/20260901000001_lesson_effective_weight_v1.sql", "utf8");
const userId = "10000000-0000-4000-8000-000000000001";
const hypothesisId = "20000000-0000-4000-8000-000000000001";
const ideaId = "30000000-0000-4000-8000-000000000001";
const lessonId = "40000000-0000-4000-8000-000000000001";
const experimentId = "50000000-0000-4000-8000-000000000001";
const analysisId = "60000000-0000-4000-8000-000000000001";
const frameworkId = "70000000-0000-4000-8000-000000000001";
const marketReferenceId = "80000000-0000-4000-8000-000000000001";
const marketDnaId = "90000000-0000-4000-8000-000000000001";
const batchKey = "a".repeat(64);
const contextHash = "b".repeat(64);
const hypothesisKey = "c".repeat(64);

const bootstrap = String.raw`
create schema auth;
create schema extensions;
create function extensions.digest(p_value bytea,p_algorithm text)
returns bytea language sql immutable strict as $$
  select decode(md5(encode(p_value,'hex'))||md5('second:'||encode(p_value,'hex')),'hex')
$$;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public,auth to anon,authenticated,service_role;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role',true),'')
$$;
create function public.jsonb_has_exact_keys(p_value jsonb,p_keys text[])
returns boolean language sql immutable as $$
  select jsonb_typeof(p_value)='object' and
    (select array_agg(key order by key) from jsonb_object_keys(p_value) key)=
    (select array_agg(key order by key) from unnest(p_keys) key)
$$;
create function public.canonical_jsonb_text(p_value jsonb)
returns text language plpgsql immutable strict set search_path='' as $$
declare v_result text;
begin
  case jsonb_typeof(p_value)
    when 'object' then select '{'||coalesce(string_agg(to_jsonb(e.key)::text||':'||
      public.canonical_jsonb_text(e.value),',' order by e.key),'')||'}'
      into v_result from jsonb_each(p_value) e;
    when 'array' then select '['||coalesce(string_agg(public.canonical_jsonb_text(a.value),','
      order by a.ordinality),'')||']' into v_result
      from jsonb_array_elements(p_value) with ordinality a(value,ordinality);
    else v_result:=p_value::text;
  end case;
  return v_result;
end; $$;
create table public.content_hypotheses(
  id uuid primary key,user_id uuid not null,hypothesis_key text,constants jsonb,feedback_context jsonb
);
create table public.video_ideas(
  id uuid primary key,user_id uuid not null,feedback_batch_key text,feedback_candidate_index smallint,
  market_batch_contract_hash text,market_context_hash text,hypothesis_id uuid
);
create or replace function public.guard_hypothesis_feedback_identity()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if old.hypothesis_key is not null and row(old.hypothesis_key,old.constants,old.feedback_context)
      is distinct from row(new.hypothesis_key,new.constants,new.feedback_context)
    then raise exception 'feedback_hypothesis_identity_immutable'; end if;
  return new;
end; $$;
create trigger trg_content_hypotheses_feedback_identity before update on public.content_hypotheses
  for each row execute function public.guard_hypothesis_feedback_identity();
create or replace function public.persist_tiktok_market_feedback_batch(
  p_user_id uuid,p_batch_key text,p_context_hash text,p_hypothesis_key text,
  p_hypothesis jsonb,p_selected_lesson_ids uuid[],p_avoided_lesson_ids uuid[],
  p_api_metric_snapshot_ids uuid[],p_studio_metric_ids uuid[],p_prompt_framework_id uuid,
  p_prompt_framework_version text,p_market_context jsonb,p_candidates jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_hypothesis_id uuid:='${hypothesisId}'; v_result jsonb; v_contract_hash text;
begin
  if not public.jsonb_has_exact_keys(p_hypothesis,array[
      'statement','changed_variable','constants','expected_effect','rationale','evidence',
      'uncertainty','feedback_context'])
      or not public.jsonb_has_exact_keys(p_market_context,array[
        'integration_version','platform','OWN_PERFORMANCE','OWNER_PREFERENCE',
        'MARKET_REFERENCE','conflicts'])
      or not public.jsonb_has_exact_keys(p_market_context->'OWN_PERFORMANCE',array[
      'source_type','selected_lessons','avoided_lessons','primary','prompt_framework'])
      or exists(select 1 from jsonb_array_elements(p_market_context->'OWN_PERFORMANCE'->'selected_lessons') l
        where l ? 'effective_evidence')
      or exists(select 1 from jsonb_array_elements(p_hypothesis->'evidence') e
        where e ? 'policy_version' or e ? 'effective_state')
      or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)<>1
      or exists(select 1 from jsonb_array_elements(p_candidates) c
        where not public.jsonb_has_exact_keys(c,array[
          'slug','animal','hook','line','prompt','why_this_idea','idea_pattern',
          'market_mechanic_key','novelty_status','market_reference_ids','market_dna_ids',
          'own_lesson_ids','avoided_lesson_ids','own_experiment_ids','owner_preference_ids',
          'evidence_roots','evidence_conflicts','idea_confidence','evidence_mode','market_context_hash']))
      or p_market_context::text~*'"(verdict|experiment_verdict|create_lesson|publish|publishing|auto_production|generation_command)"[[:space:]]*:'
      or p_market_context::text~*'"(canonical_url|external_reference_id|creator_name|creator_handle|source_locator|title|caption|transcript|html)"[[:space:]]*:'
    then raise exception 'legacy_exact_validator_rejected'; end if;
  v_contract_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
    'batch_key',p_batch_key,'context_hash',p_context_hash,'hypothesis_key',p_hypothesis_key,
    'hypothesis',p_hypothesis,'selected_lesson_ids',to_jsonb(coalesce(p_selected_lesson_ids,'{}'::uuid[])),
    'avoided_lesson_ids',to_jsonb(coalesce(p_avoided_lesson_ids,'{}'::uuid[])),
    'api_metric_snapshot_ids',to_jsonb(coalesce(p_api_metric_snapshot_ids,'{}'::uuid[])),
    'studio_metric_ids',to_jsonb(coalesce(p_studio_metric_ids,'{}'::uuid[])),
    'framework_id',p_prompt_framework_id,'framework_version',p_prompt_framework_version,
    'market_context',p_market_context,'candidates',p_candidates)),'UTF8'),'sha256'),'hex');
  insert into public.content_hypotheses(id,user_id,hypothesis_key,constants,feedback_context)
    values(v_hypothesis_id,p_user_id,p_hypothesis_key,p_hypothesis->'constants',p_market_context);
  insert into public.video_ideas(id,user_id,feedback_batch_key,feedback_candidate_index,
    market_batch_contract_hash,market_context_hash,hypothesis_id)
    values('${ideaId}',p_user_id,p_batch_key,1,v_contract_hash,p_context_hash,v_hypothesis_id);
  select jsonb_agg(to_jsonb(i)) into v_result from public.video_ideas i
    where i.user_id=p_user_id and i.feedback_batch_key=p_batch_key;
  return v_result;
end; $$;
grant select,insert,update on public.content_hypotheses,public.video_ideas to service_role;
grant execute on function public.persist_tiktok_market_feedback_batch(
  uuid,text,text,text,jsonb,uuid[],uuid[],uuid[],uuid[],uuid,text,jsonb,jsonb
) to service_role;
`;

function effectiveState() {
  return evaluateLessonsForFeedback({
    lessons: [{ id: lessonId, status: "SUPPORTED", category: "WINNING_PATTERN",
      source_platform: "tiktok", evidence: [] }],
    experiments: [], analyses: [], mutations: [], lesson_bindings: [], target_platform: "tiktok",
    current_context: {}, evaluation_at: "2026-09-01T00:00:00Z",
  }).states[0];
}

function fullContext() {
  const effective = effectiveState();
  return {
    integration_version: 1,
    platform: "tiktok",
    OWN_PERFORMANCE: {
      source_type: "OWN_PERFORMANCE",
      lesson_effective_policy_version: "LESSON_EFFECTIVE_WEIGHT_V1",
      evaluation_at: "2026-09-01T00:00:00Z",
      lesson_effective_states: [effective],
      controlled_retests: [],
      selected_lessons: [],
      avoided_lessons: [],
      primary: null,
      prompt_framework: { id: frameworkId, version_label: "v1",
        status: "STANDARD", rule_ids: [] },
    },
    OWNER_PREFERENCE: { source_type: "OWNER_PREFERENCE", approved: [], rejected: [], MARKET_AVOIDANCE: [] },
    MARKET_REFERENCE: { source_type: "MARKET_REFERENCE", references: [{ key: "M1",
      market_reference_id: marketReferenceId, market_dna_id: marketDnaId, disposition: "TAKE",
      mechanics: [{ key: "M1", field: "hook_type", value: "abstract interruption",
        confidence: "MEDIUM", limitations: [] }] }],
      selected_changed_variable: "hook_type", confidence: "LOW", limitations: [] },
    conflicts: [],
  };
}

function hypothesis(context) {
  return { statement: "test", changed_variable: "hook_type", constants: {}, expected_effect: "up",
    rationale: "bounded", evidence: [{ source_type: "MARKET_REFERENCE",
      market_reference_ids: [marketReferenceId], market_dna_ids: [marketDnaId] }],
    uncertainty: "initial", feedback_context: context };
}

function candidates(context) {
  return [{ slug: "owl-test", animal: "Owl", hook: "Abstract interruption",
    line: "Bounded line", prompt: "Use an abstract interruption mechanic.",
    why_this_idea: "Tests one bounded variable.", idea_pattern: "abstract-pattern",
    market_mechanic_key: "M1", novelty_status: "MARKET_INSPIRED_TEST",
    market_reference_ids: [marketReferenceId], market_dna_ids: [marketDnaId],
    own_lesson_ids: [], avoided_lesson_ids: [], own_experiment_ids: [],
    owner_preference_ids: [marketReferenceId], evidence_roots: {
      MARKET_REFERENCE: { market_reference_ids: [marketReferenceId], market_dna_ids: [marketDnaId],
        mechanics: [{ field: "hook_type", value: "abstract interruption",
          confidence: "MEDIUM", limitations: [] }] },
      OWN_PERFORMANCE: { lesson_ids: [], experiment_ids: [] },
      OWNER_PREFERENCE: { approved_idea_ids: [], rejected_idea_ids: [],
        market_disposition_reference_ids: [marketReferenceId], market_avoidance_reference_ids: [],
        market_avoidance: [] },
    }, evidence_conflicts: [], idea_confidence: "LOW", evidence_mode: "MARKET_REFERENCE_ONLY",
    market_context_hash: contextHash }];
}

function twoRetestContext() {
  const context = fullContext();
  assert.equal(Object.hasOwn(context.OWN_PERFORMANCE.lesson_effective_states[0],
    "evaluated_mechanism_count"), false);
  const lower = structuredClone(effectiveState());
  lower.lesson_id = lessonId;
  lower.canonical_status = "CONFIRMED";
  lower.effective_strength = "LOW";
  lower.freshness_bucket = "STALE";
  lower.last_supported_at = "2026-03-01T00:00:00Z";
  lower.controlled_retest = { action: "CONTROLLED_RETEST", target_platform: "tiktok",
    source_lesson_id: lower.lesson_id, changed_variable: "hook_type", constants: {},
    supporting_experiment_ids: [], contradictory_experiment_ids: [],
    retest_reason: "HISTORICAL_STALE", policy_version: "LESSON_EFFECTIVE_WEIGHT_V1",
    limitations: [] };
  const higher = structuredClone(lower);
  higher.lesson_id = "40000000-0000-4000-8000-000000000002";
  higher.effective_strength = "MEDIUM";
  higher.last_supported_at = "2026-04-01T00:00:00Z";
  higher.controlled_retest.source_lesson_id = higher.lesson_id;
  context.OWN_PERFORMANCE.lesson_effective_states = [lower, higher];
  context.OWN_PERFORMANCE.controlled_retests = [higher.controlled_retest, lower.controlled_retest];
  return context;
}

async function setup() {
  const db = new PGlite();
  await db.exec(bootstrap);
  await db.exec(migration);
  await db.exec("set role service_role");
  await db.query("select set_config('request.jwt.claim.role','service_role',false)");
  return db;
}

async function persist(db, context, candidateRows = candidates(context)) {
  return await db.query(`select public.persist_tiktok_market_feedback_batch(
    $1,$2,$3,$4,$5,'{}'::uuid[],'{}'::uuid[],'{}'::uuid[],'{}'::uuid[],$6,'v1',$7,$8) value`,
  [userId,batchKey,contextHash,hypothesisKey,hypothesis(context),
    frameworkId,context,candidateRows]);
}

test("POST-10 migration executes and enriches the accepted immutable market snapshot once", async (t) => {
  const db = await setup(); t.after(() => db.close());
  const context = fullContext();
  const privilege = await db.query(`select has_function_privilege('service_role',
    'public.persist_tiktok_market_feedback_batch_pre_post10(uuid,text,text,text,jsonb,uuid[],uuid[],uuid[],uuid[],uuid,text,jsonb,jsonb)',
    'EXECUTE') allowed`);
  assert.equal(privilege.rows[0].allowed, false);
  const first = await persist(db, context);
  assert.equal(first.rows[0].value.length, 1);
  const stored = await db.query("select feedback_context from public.content_hypotheses where id=$1",[hypothesisId]);
  assert.equal(stored.rows[0].feedback_context.OWN_PERFORMANCE.lesson_effective_policy_version,
    "LESSON_EFFECTIVE_WEIGHT_V1");
  const replay = await persist(db, context);
  assert.equal(replay.rows[0].value.length, 1);
  const alteredCandidates = structuredClone(candidates(context));
  alteredCandidates[0].why_this_idea = "altered replay";
  await assert.rejects(() => persist(db, context, alteredCandidates), /market_feedback_batch_conflict/);
  const tampered = structuredClone(context);
  tampered.OWN_PERFORMANCE.lesson_effective_states[0].limitations = ["CHANGED_REPLAY"];
  await assert.rejects(() => persist(db, tampered), /market_feedback_batch_conflict/);
  const commandInjection = structuredClone(context);
  commandInjection.OWN_PERFORMANCE.lesson_effective_states[0].limitations =
    [{ generation_command: "run" }];
  await assert.rejects(() => persist(db, commandInjection), /market_context_command_forbidden/);
  const sourceInjection = structuredClone(context);
  sourceInjection.OWN_PERFORMANCE.lesson_effective_states[0].limitations =
    [{ creator_handle: "source" }];
  await assert.rejects(() => persist(db, sourceInjection), /market_context_source_identity_forbidden/);
  const extraKey = structuredClone(context);
  extraKey.OWN_PERFORMANCE.lesson_effective_states[0].extra = "not allowed";
  await assert.rejects(() => persist(db, extraKey), /post10_effective_state_invalid/);
  await assert.rejects(() => db.query("update public.content_hypotheses set feedback_context='{}' where id=$1",
    [hypothesisId]), /feedback_hypothesis_identity_immutable/);
});

test("POST-10 persistence accepts runtime priority order for multiple controlled retests", async (t) => {
  const db = await setup(); t.after(() => db.close());
  const context = twoRetestContext();
  await persist(db, context);
  const stored = await db.query("select feedback_context from public.content_hypotheses where id=$1",[hypothesisId]);
  assert.deepEqual(stored.rows[0].feedback_context.OWN_PERFORMANCE.controlled_retests,
    context.OWN_PERFORMANCE.controlled_retests);
  assert.equal(context.OWN_PERFORMANCE.controlled_retests[0].source_lesson_id,
    "40000000-0000-4000-8000-000000000002");
});
