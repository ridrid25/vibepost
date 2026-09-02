import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "../tools/post09-db-harness/node_modules/@electric-sql/pglite/dist/index.js";
import { pgcrypto } from "../tools/post09-db-harness/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js";
import {
  META_READ_EDGES, MetaReadonlyError, canonicalJson, executeMetaRead,
  metaReadRequests, normalizeMetaGraphResult, normalizeMetaReadBundle, sha256Hex,
} from "../supabase/functions/_shared/meta-readonly.mjs";
import {
  EVIDENCE_ROOT_ORDER, MATERIAL_KEYS, buildMetaFirstDecision,
} from "../supabase/functions/_shared/meta-first-decision.mjs";

const fixture = () => JSON.parse(readFileSync("scripts/fixtures/meta-first/meta-read-bundle.json", "utf8"));
const expectedDecision = () => JSON.parse(readFileSync("scripts/fixtures/meta-first/closed-loop-decision.json", "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

const controlMaterial = {
  topic: "evidence-led-content", audience: "expert-founders", format: "short-video",
  angle: "proof-before-scale", hook: "Explain the process first", opening: "Process overview",
  cta: "Review the evidence", visual: "screen-proof", duration: "45s",
};
const variantMaterial = { ...controlMaterial, hook: "46 accepted stages prove the baseline" };
const experiment = () => ({
  experiment_id: "00000000-0000-4000-8000-000000000701",
  control_binding_id: "00000000-0000-4000-8000-000000000401",
  variant_binding_id: "00000000-0000-4000-8000-000000000402",
  control_snapshot_id: "00000000-0000-4000-8000-000000000501",
  variant_snapshot_id: "00000000-0000-4000-8000-000000000502",
  primary_action_type: "landing_page_view",
  conversion_action_type: null,
  revenue_action_type: null,
  changed_variable: "hook",
  mutation_kind: "CONTROLLED_MUTATION",
  control_material: { ...controlMaterial },
  variant_material: { ...variantMaterial },
  overlap_ambiguity: false,
});
const roots = () => ({
  OWN_ORGANIC_PERFORMANCE: { availability: "UNKNOWN", signal: "UNKNOWN", evidence_refs: [], contribution: "No comparable organic cohort is available.", limitations: ["NO_COMPARABLE_COHORT"] },
  MARKET_REFERENCE: { availability: "KNOWN", signal: "SUPPORT", evidence_refs: ["market-reference-01"], contribution: "Market evidence supports demand for auditable content systems.", limitations: [] },
  OWNER_PREFERENCE: { availability: "KNOWN", signal: "SUPPORT", evidence_refs: ["owner-preference-01"], contribution: "Owner prioritizes evidence-first product education.", limitations: [] },
  EXPERT_RESEARCH_EVIDENCE: { availability: "KNOWN", signal: "SUPPORT", evidence_refs: ["research-source-01"], contribution: "Accepted project evidence supports the factual proof angle.", limitations: [] },
});
const topicCandidates = () => ([{
  topic_key: "evidence-led-content", audience_key: "expert-founders", angle_key: "proof-before-scale",
  relationship: "CURRENT", evidence_roots: roots(),
}]);
const decide = (batch, overrides = {}) => buildMetaFirstDecision({
  batch, experiment: overrides.experiment ?? experiment(),
  topic_candidates: overrides.topic_candidates ?? topicCandidates(),
  policy: overrides.policy,
});
const rehashBatch = async (batch) => {
  const material = clone(batch); delete material.batch_hash;
  batch.batch_hash = await sha256Hex(canonicalJson(material));
  return batch;
};
const withoutHash = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "evidence_hash"));
const rehashLearning = async (learning) => {
  learning.experiment_evidence.evidence_hash = await sha256Hex(canonicalJson({ hypothesis: learning.hypothesis, experiment: learning.experiment, experiment_evidence: withoutHash(learning.experiment_evidence) }));
  learning.analysis_evidence.evidence_hash = await sha256Hex(canonicalJson({ analysis: learning.analysis, analysis_evidence: withoutHash(learning.analysis_evidence) }));
  learning.lesson_evidence.evidence_hash = await sha256Hex(canonicalJson({ lesson: learning.lesson, lesson_evidence: withoutHash(learning.lesson_evidence) }));
  return learning;
};

test("Meta adapter exposes only five allowlisted GET surfaces and keeps token out of URLs", async () => {
  assert.deepEqual(Object.keys(META_READ_EDGES), ["campaigns", "adsets", "ads", "adcreatives", "insights"]);
  const descriptors = metaReadRequests({ accountId: "1000001", apiVersion: "v26.0", dateStart: "2026-08-21", dateStop: "2026-08-27" });
  assert.equal(descriptors.length, 5);
  assert.ok(descriptors.every((item) => item.method === "GET" && !item.url.includes("access_token")));
  let calls = 0;
  const result = await executeMetaRead({ descriptors, accessToken: "fixture-secret-never-logged", fetchImpl: async (_url, init) => {
    calls += 1; assert.equal(init.method, "GET"); assert.equal(init.headers.Authorization.startsWith("Bearer "), true);
    return { ok: true, async json() { return { data: [] }; } };
  } });
  assert.equal(calls, 5); assert.deepEqual(Object.keys(result), Object.keys(META_READ_EDGES));
  await assert.rejects(() => executeMetaRead({ descriptors: [{ ...descriptors[0], method: "POST" }], accessToken: "fixture-secret-never-logged" }), MetaReadonlyError);
  const arbitraryFields = new URL(descriptors[0].url); arbitraryFields.searchParams.set("fields", "id,name,targeting");
  await assert.rejects(() => executeMetaRead({ descriptors: [{ ...descriptors[0], url: arbitraryFields.toString() }], accessToken: "fixture-secret-never-logged" }), { code: "META_FIELDSET_FORBIDDEN" });
  await assert.rejects(() => executeMetaRead({ descriptors: [descriptors[0]], accessToken: "fixture-secret-never-logged", fetchImpl: async () => ({
    ok: true,
    async json() { return { data: [], paging: { next: "https://graph.facebook.com/v26.0/act_1000001/ads?limit=100" } }; },
  }) }), { code: "META_PAGINATION_FORBIDDEN" });
  await assert.rejects(() => executeMetaRead({ descriptors: [descriptors[0]], accessToken: "fixture-secret-never-logged", fetchImpl: async () => ({
    ok: true,
    async json() { return { data: [], paging: { next: `${descriptors[0].url}&access_token=forbidden` } }; },
  }) }), { code: "META_SECRET_LOCATION_FORBIDDEN" });
  await assert.rejects(() => executeMetaRead({ descriptors: [descriptors[0]], accessToken: "fixture-secret-never-logged", fetchImpl: async () => ({
    ok: true,
    async json() { return { data: [], paging: { next: `${descriptors[0].url}&fields=${encodeURIComponent(META_READ_EDGES.campaigns)}&after=cursor` } }; },
  }) }), { code: "META_PAGINATION_FORBIDDEN" });
  let page = 0;
  await assert.rejects(() => executeMetaRead({ descriptors: [descriptors[0]], accessToken: "fixture-secret-never-logged", fetchImpl: async (url) => {
    page += 1;
    const next = new URL(url); next.searchParams.set("after", String(page));
    return { ok: true, async json() { return { data: [], paging: { next: next.toString() } }; } };
  } }), { code: "META_PAGINATION_LIMIT" });
  assert.equal(page, 50);
});

test("strict normalization proves exact one-to-many identity and explicit UNKNOWN", async () => {
  const first = await normalizeMetaReadBundle(fixture());
  const second = await normalizeMetaReadBundle(fixture());
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.batch_hash, second.batch_hash);
  assert.equal(first.bindings.filter((item) => item.creative_id.endsWith("b".repeat(64))).length, 2);
  assert.equal(first.snapshots[2].metrics.spend.state, "UNKNOWN");
  assert.equal(first.snapshots[2].metrics.spend.value, null);
  assert.equal(first.actions[2].state, "UNKNOWN");
});

test("provider GET rows normalize into the persisted batch contract instead of being discarded", async () => {
  const source = fixture(); const adById = new Map(source.ads.map((item) => [item.id, item]));
  const graph = {
    campaigns: source.campaigns.map(({ id, objective }) => ({ id, objective })),
    adsets: source.adsets.map(({ id, campaign_id, optimization_goal }) => ({ id, campaign_id, optimization_goal })),
    ads: source.ads.map(({ id, campaign_id, adset_id, creative_id }) => ({ id, campaign_id, adset_id, creative: { id: creative_id } })),
    adcreatives: source.creatives.map(({ id }) => ({ id })),
    insights: source.insights.map((item) => ({
      campaign_id: adById.get(item.ad_id).campaign_id, adset_id: adById.get(item.ad_id).adset_id, ad_id: item.ad_id,
      ...item.metrics, actions: item.actions.map(({ action_type, value }) => ({ action_type, value })), action_values: [],
      account_currency: item.currency, date_start: item.date_start, date_stop: item.date_stop,
      attribution_setting: item.attribution_setting,
    })),
  };
  const context = {
    schema: "meta-normalization-context-v1", user_id: source.user_id, account_id: source.accounts[0].id,
    field_set_version: source.field_set_version, collected_at: source.insights[0].collected_at,
    placement_key: "feed", creative_profiles: source.creative_profiles, bindings: source.bindings,
    authoritative_actions: [{ action_type: "landing_page_view", currency: null }],
  };
  const args = { graph, context, apiVersion: "v26.0", dateStart: "2026-08-21", dateStop: "2026-08-27" };
  const normalized = await normalizeMetaGraphResult(args);
  assert.equal(normalized.snapshots.length, 3); assert.equal(normalized.actions.length, 3);
  assert.equal(normalized.actions[0].authoritative, true);
  assert.equal(normalized.snapshots[0].cohort_hash, normalized.snapshots[1].cohort_hash);
  assert.equal(normalized.batch_hash, (await normalizeMetaGraphResult(args)).batch_hash);
  const forbidden = clone(graph); forbidden.ads[0].name = "PII-like provider copy";
  await assert.rejects(() => normalizeMetaGraphResult({ ...args, graph: forbidden }), { code: "META_FIELD_FORBIDDEN" });
  const unknownCurrency = clone(graph); delete unknownCurrency.insights[2].account_currency;
  const withUnknown = await normalizeMetaGraphResult({ ...args, graph: unknownCurrency });
  assert.equal(withUnknown.snapshots[2].currency, "UNKNOWN");
});

test("strict normalization rejects PII/raw fields, orphan identity and ambiguous ad remap", async () => {
  const pii = fixture(); pii.campaigns[0].name = "forbidden";
  await assert.rejects(() => normalizeMetaReadBundle(pii), { code: "META_FIELD_FORBIDDEN" });
  const orphan = fixture(); orphan.bindings[0].identity_map_id = "00000000-0000-4000-8000-000000000999";
  await assert.rejects(() => normalizeMetaReadBundle(orphan), { code: "META_BINDING_UNKNOWN" });
  const remap = fixture(); remap.bindings.push({ ...remap.bindings[0], id: "00000000-0000-4000-8000-000000000499", creative_id: remap.bindings[1].creative_id, identity_map_id: remap.bindings[1].identity_map_id });
  await assert.rejects(() => normalizeMetaReadBundle(remap), { code: "META_BINDING_CONFLICT" });
});

test("deterministic closed-loop decision matches the committed coordination vector", async () => {
  const batch = await normalizeMetaReadBundle(fixture());
  const decision = await decide(batch);
  assert.deepEqual(decision, expectedDecision());
  assert.equal(decision.verdict, "PASS");
  assert.equal(decision.lesson.changed_variable, "hook");
  assert.equal(decision.next_hypothesis.topic_action, "CONTINUE");
  assert.equal(decision.metrics.conversion.state, "UNKNOWN");
  assert.deepEqual(decision.why_this_topic_now.map((item) => item.root), EVIDENCE_ROOT_ORDER);
  assert.equal("score" in decision, false);
});

test("window, cumulative overlap, missing action and whole-concept evidence fail closed", async () => {
  const original = await normalizeMetaReadBundle(fixture());
  const windowed = clone(original); windowed.snapshots[1].date_start = "2026-08-22";
  assert.equal((await decide(windowed)).evaluation_reason, "COHORT_OR_WINDOW_MISMATCH");
  const overlap = experiment(); overlap.overlap_ambiguity = true;
  assert.equal((await decide(original, { experiment: overlap })).evaluation_reason, "CUMULATIVE_OVERLAP_AMBIGUOUS");
  const missing = clone(original); missing.actions.find((item) => item.snapshot_id.endsWith("502")).state = "UNKNOWN"; missing.actions.find((item) => item.snapshot_id.endsWith("502")).value = null;
  assert.equal((await decide(missing)).evaluation_reason, "AUTHORITATIVE_ACTION_UNKNOWN");
  const concept = experiment(); concept.mutation_kind = "NEW_CONCEPT"; concept.variant_material.angle = "different";
  assert.equal((await decide(original, { experiment: concept })).evaluation_reason, "NEW_CONCEPT_NOT_AB_TEST");
});

test("Meta evaluator separates downstream quality and auction confounding from topic quality", async () => {
  const original = await normalizeMetaReadBundle(fixture());
  const poor = clone(original); const action = poor.actions.find((item) => item.snapshot_id.endsWith("502")); action.value = 50;
  const poorDecision = await decide(poor);
  assert.equal(poorDecision.verdict, "FAIL"); assert.equal(poorDecision.lesson.changed_variable, "cta");
  const auction = clone(original); const variant = auction.snapshots.find((item) => item.id.endsWith("502"));
  variant.metrics.ctr.value = 2.1; variant.metrics.cpm.value = 35;
  const auctionDecision = await decide(auction);
  assert.equal(auctionDecision.verdict, "INCONCLUSIVE"); assert.equal(auctionDecision.evaluation_reason, "AUCTION_OR_AUDIENCE_CONFOUND");
});

test("one-changed-variable rule is exact", async () => {
  assert.deepEqual(MATERIAL_KEYS, ["topic", "audience", "format", "angle", "hook", "opening", "cta", "visual", "duration"]);
  const batch = await normalizeMetaReadBundle(fixture());
  const many = experiment(); many.variant_material.angle = "new-angle";
  assert.equal((await decide(batch, { experiment: many })).evaluation_reason, "ONE_VARIABLE_RULE_FAILED");
});

test("topic decisions prove PAUSE, EXPLORE_ADJACENT and NEW_TOPIC without a magic score", async () => {
  const batch = await normalizeMetaReadBundle(fixture());
  const weak = clone(batch); weak.snapshots[1].metrics.ctr.value = 1.6;
  const topicExperiment = experiment(); topicExperiment.changed_variable = "topic";
  topicExperiment.variant_material = { ...topicExperiment.control_material, topic: "evidence-led-content-v2" };
  const paused = await decide(weak, { experiment: topicExperiment });
  assert.equal(paused.next_hypothesis.topic_action, "PAUSE");
  const supportedRoots = roots(); supportedRoots.OWN_ORGANIC_PERFORMANCE = {
    availability: "KNOWN", signal: "SUPPORT", evidence_refs: ["organic-topic-01"],
    contribution: "A comparable organic cohort supports the adjacent topic.", limitations: [],
  };
  const adjacent = { topic_key: "auditable-content", audience_key: "expert-founders", angle_key: "proof-before-scale", relationship: "ADJACENT", evidence_roots: supportedRoots };
  const explored = await decide(weak, { experiment: topicExperiment, topic_candidates: [...topicCandidates(), adjacent] });
  assert.equal(explored.next_hypothesis.topic_action, "EXPLORE_ADJACENT");
  assert.equal(explored.next_hypothesis.next_topic_candidate, "auditable-content");
  const fresh = { ...adjacent, topic_key: "decision-led-writing", relationship: "NEW" };
  const newTopic = await decide(weak, { experiment: topicExperiment, topic_candidates: [...topicCandidates(), fresh] });
  assert.equal(newTopic.next_hypothesis.topic_action, "NEW_TOPIC");
});

test("authoritative actions produce conversions, CPA and ROAS while absent authority stays UNKNOWN", async () => {
  const batch = await normalizeMetaReadBundle(fixture());
  const variant = batch.snapshots.find((item) => item.id.endsWith("502"));
  batch.actions.push(
    { id: "00000000-0000-4000-8000-000000000611", user_id: batch.user_id, snapshot_id: variant.id, action_type: "purchase", state: "KNOWN", value: 8, currency: null, authoritative: true },
    { id: "00000000-0000-4000-8000-000000000612", user_id: batch.user_id, snapshot_id: variant.id, action_type: "purchase_value", state: "KNOWN", value: 960, currency: "USD", authoritative: true },
  );
  const configured = experiment(); configured.conversion_action_type = "purchase"; configured.revenue_action_type = "purchase_value";
  const decision = await decide(batch, { experiment: configured });
  assert.deepEqual(decision.metrics.conversion, { state: "KNOWN", value: 8 });
  assert.deepEqual(decision.metrics.cpa, { state: "KNOWN", value: 12.5, currency: "USD" });
  assert.deepEqual(decision.metrics.roas, { state: "KNOWN", value: 9.6, currency: "USD" });
});

test("migration is additive, owner-readable and exposes only service-role mutation RPCs", () => {
  const sql = readFileSync("supabase/migrations/20260902000002_meta_first_closed_loop_v1.sql", "utf8");
  for (const token of [
    "creative_analysis_dimensions_identity_owner_fk", "meta_creative_ad_bindings_identity_owner_fk",
    "content_analysis_meta_evidence_meta_unique", "content_lesson_meta_evidence_analysis_unique",
    "persist_meta_readonly_batch", "persist_meta_learning_result", "META_IDENTITY_ANCHOR_UNKNOWN",
    "META_IMMUTABLE_CONFLICT", "source_platform in ('tiktok','youtube_shorts','meta_ads')",
  ]) assert.ok(sql.includes(token), token);
  assert.equal((sql.match(/create policy /g) ?? []).length, 8);
  assert.equal((sql.match(/create trigger /gi) ?? []).length, 0);
  assert.equal(/\bupdate\s+public\./i.test(sql), false);
  assert.equal(/\bdelete\s+from\s+public\./i.test(sql), false);
  assert.match(sql, /grant execute on function[\s\S]+to service_role;/i);
  assert.match(sql, /revoke execute on function[\s\S]+from public,anon,authenticated;/i);
});

test("live gate normalizes GET rows and returns only counts plus batch hash", () => {
  const source = readFileSync("supabase/functions/meta-sync/index.ts", "utf8");
  assert.match(source, /normalizeMetaGraphResult/);
  assert.match(source, /provider_write_operations:\s*0/);
  assert.match(source, /batch_hash:\s*normalized\.batch_hash/);
  assert.equal(source.includes("normalized_response_hash"), false);
});

const dbBootstrap = String.raw`
create schema auth;
create schema extensions;
create extension pgcrypto with schema extensions;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public,auth to anon,authenticated,service_role;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
create function public.canonical_jsonb_text(p_value jsonb)
returns text language plpgsql immutable strict set search_path = '' as $$
declare v_result text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{'||coalesce(string_agg(to_jsonb(e.key)::text||':'||public.canonical_jsonb_text(e.value),',' order by e.key),'')||'}'
        into v_result from jsonb_each(p_value) e;
    when 'array' then
      select '['||coalesce(string_agg(public.canonical_jsonb_text(a.value),',' order by a.ordinality),'')||']' into v_result
        from jsonb_array_elements(p_value) with ordinality a(value,ordinality);
    else v_result := p_value::text;
  end case;
  return v_result;
end; $$;
create table auth.users(id uuid primary key);
create table public.creative_identity_map(
 id uuid primary key,user_id uuid not null references auth.users(id),creative_id text not null,
 platform text not null,unique(id,user_id),unique(id,user_id,creative_id));
create table public.content_hypotheses(
 id uuid primary key,user_id uuid not null references auth.users(id),statement text not null,changed_variable text not null,
 expected_effect text not null,rationale text,evidence jsonb not null default '[]',status text not null default 'HYPOTHESIS',
 confidence text not null default 'LOW',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(id,user_id));
create table public.experiments(
 id uuid primary key,user_id uuid not null references auth.users(id),hypothesis_id uuid,hypothesis text not null,changed_variable text not null,
 constants jsonb not null default '{}',success_metrics jsonb not null default '{}',control_video_id uuid,result text,confidence text not null default 'LOW',
 lessons text,status text not null default 'OPEN',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 platform text not null default 'tiktok',control_youtube_short_id uuid,variant_youtube_short_id uuid,control_identity_map_id uuid,variant_identity_map_id uuid,
 control_creative_id text,variant_creative_id text,control_material_vector jsonb,variant_material_vector jsonb,metric_source text,
 creative_mutation_id uuid,lineage_material_schema text,lineage_parent_material_vector jsonb,lineage_child_material_vector jsonb,
 lineage_constants_snapshot jsonb,lineage_material_diff jsonb,lineage_contract_hash text,unique(id,user_id),
 constraint experiments_platform_check check(platform in ('tiktok','youtube_shorts')),
 constraint experiments_metric_source_check check(metric_source is null or metric_source in ('tiktok','youtube')),
 constraint experiments_youtube_subject_check check(true));
create table public.content_analysis_results(
 id uuid primary key,user_id uuid not null references auth.users(id),video_id uuid,experiment_id uuid,checkpoint text not null,conclusion text not null,
 evidence jsonb not null default '[]',metrics jsonb not null default '{}',metric_sources jsonb not null default '{}',confidence text not null,
 sample_size jsonb not null default '{}',limitations jsonb not null default '[]',expected jsonb not null default '{}',actual jsonb not null default '{}',
 created_at timestamptz not null default now(),platform text not null default 'tiktok',youtube_short_id uuid,youtube_snapshot_polled_at timestamptz,
 unique(id,user_id),constraint content_analysis_platform_check check(platform in ('tiktok','youtube_shorts')),
 constraint content_analysis_subject_check check(true));
create table public.content_lessons(
 id uuid primary key,user_id uuid not null references auth.users(id),lesson text not null,category text not null,evidence jsonb not null default '[]',
 videos_used uuid[] not null default '{}',sample_size jsonb not null default '{}',confidence text not null default 'LOW',status text not null default 'HYPOTHESIS',
 applicable_topics text[] not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 source_platform text not null default 'tiktok',changed_variable text,creative_ids_used text[] not null default '{}',
 metric_provenance jsonb not null default '[]',limitations jsonb not null default '[]',youtube_lesson_key text,unique(id,user_id),
 constraint content_lessons_source_platform_check check(source_platform in ('tiktok','youtube_shorts')),
 constraint content_lessons_platform_evidence_check check(true));
`;

test("migration compiles and normalized batch RPC is exact, idempotent and RLS-scoped", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(dbBootstrap);
  await db.exec(readFileSync("supabase/migrations/20260902000002_meta_first_closed_loop_v1.sql", "utf8"));
  const raw = fixture();
  await db.query("insert into auth.users(id) values ($1)", [raw.user_id]);
  for (const profile of raw.creative_profiles) {
    await db.query("insert into public.creative_identity_map(id,user_id,creative_id,platform) values($1,$2,$3,'tiktok')", [profile.identity_map_id, raw.user_id, profile.creative_id]);
  }
  const normalized = await normalizeMetaReadBundle(raw);
  await db.exec("set role service_role");
  await db.query("select set_config('request.jwt.claim.role','service_role',false)");
  const first = await db.query("select public.persist_meta_readonly_batch($1::jsonb) as result", [JSON.stringify(normalized)]);
  const second = await db.query("select public.persist_meta_readonly_batch($1::jsonb) as result", [JSON.stringify(normalized)]);
  assert.deepEqual(first.rows[0].result, second.rows[0].result);
  const extraRowKey = clone(normalized); extraRowKey.objects[0].unexpected = "forbidden"; await rehashBatch(extraRowKey);
  await assert.rejects(() => db.query("select public.persist_meta_readonly_batch($1::jsonb)", [JSON.stringify(extraRowKey)]), /META_NORMALIZED_BATCH_INVALID/);
  const extraMetricKey = clone(normalized); extraMetricKey.snapshots[0].metrics.ctr.unexpected = "forbidden"; await rehashBatch(extraMetricKey);
  await assert.rejects(() => db.query("select public.persist_meta_readonly_batch($1::jsonb)", [JSON.stringify(extraMetricKey)]), /META_NORMALIZED_BATCH_INVALID/);
  const conflictingObject = clone(normalized); conflictingObject.objects[1].objective_key = "OUTCOME_LEADS";
  const objectHashKeys = ["provider_account_id", "object_kind", "external_id", "parent_external_id", "campaign_external_id", "adset_external_id", "creative_external_id", "objective_key", "optimization_goal"];
  conflictingObject.objects[1].payload_hash = await sha256Hex(canonicalJson(Object.fromEntries(objectHashKeys.map((key) => [key, conflictingObject.objects[1][key]]))));
  await rehashBatch(conflictingObject);
  await assert.rejects(() => db.query("select public.persist_meta_readonly_batch($1::jsonb)", [JSON.stringify(conflictingObject)]), /META_IMMUTABLE_CONFLICT/);
  const decision = expectedDecision();
  const learning = {
    schema: "meta-learning-result-v1", user_id: raw.user_id,
    hypothesis: {
      id: "00000000-0000-4000-8000-000000000801", statement: decision.next_hypothesis.statement,
      changed_variable: "hook", expected_effect: decision.next_hypothesis.expected_effect, rationale: "Meta fixture evidence",
      evidence: [decision.decision_id], status: "SUPPORTED", confidence: "HIGH", topic_family_key: "evidence-led-content",
      topic_action: "CONTINUE", decision_context_hash: decision.decision_id.slice(9),
    },
    experiment: {
      id: "00000000-0000-4000-8000-000000000802", hypothesis_id: "00000000-0000-4000-8000-000000000801",
      hypothesis: decision.next_hypothesis.statement, changed_variable: "hook", constants: decision.next_hypothesis.constants_snapshot,
      success_metrics: { primary: "ctr", downstream: "landing_page_view" }, result: "PASS", confidence: "HIGH",
      lessons: decision.lesson.statement, status: "ANALYZED", control_creative_id: raw.creative_profiles[0].creative_id,
      variant_creative_id: raw.creative_profiles[1].creative_id, control_material_vector: controlMaterial,
      variant_material_vector: variantMaterial, control_meta_binding_id: raw.bindings[0].id, variant_meta_binding_id: raw.bindings[1].id,
    },
    experiment_evidence: {
      id: "00000000-0000-4000-8000-000000000803", experiment_id: "00000000-0000-4000-8000-000000000802",
      control_binding_id: raw.bindings[0].id, variant_binding_id: raw.bindings[1].id,
      control_snapshot_id: raw.insights[0].id, variant_snapshot_id: raw.insights[1].id,
      cohort_hash: raw.insights[0].cohort_hash, policy_version: "meta-experiment-v1", evidence_hash: "d".repeat(64),
    },
    analysis: {
      id: "00000000-0000-4000-8000-000000000804", experiment_id: "00000000-0000-4000-8000-000000000802",
      checkpoint: "manual", conclusion: "PASS", evidence: ["00000000-0000-4000-8000-000000000803"],
      metrics: decision.metrics, metric_sources: { provider: "meta_ads", source: "fixture" }, confidence: "HIGH",
      sample_size: { impressions: 20000 }, limitations: [], expected: { ctr_lift: 0.2 }, actual: { ctr_lift: 0.5 },
      meta_snapshot_id: raw.insights[1].id,
    },
    analysis_evidence: {
      analysis_id: "00000000-0000-4000-8000-000000000804", meta_experiment_evidence_id: "00000000-0000-4000-8000-000000000803", evidence_hash: "e".repeat(64),
    },
    lesson: {
      id: "00000000-0000-4000-8000-000000000805", lesson: decision.lesson.statement, category: "WINNING_PATTERN",
      evidence: [decision.decision_id], sample_size: { impressions: 20000 }, confidence: "HIGH", status: "SUPPORTED",
           applicable_topics: ["evidence-led-content"], changed_variable: "hook",
      creative_ids_used: raw.creative_profiles.map((item) => item.creative_id), metric_provenance: [raw.insights[0].id, raw.insights[1].id],
      limitations: [], meta_lesson_key: decision.lesson.lesson_key,
    },
    lesson_evidence: {
      lesson_id: "00000000-0000-4000-8000-000000000805", analysis_id: "00000000-0000-4000-8000-000000000804",
      meta_experiment_evidence_id: "00000000-0000-4000-8000-000000000803", evidence_hash: "f".repeat(64),
    },
  };
  await rehashLearning(learning);
  const learnedFirst = await db.query("select public.persist_meta_learning_result($1::jsonb) as result", [JSON.stringify(learning)]);
  const learnedSecond = await db.query("select public.persist_meta_learning_result($1::jsonb) as result", [JSON.stringify(learning)]);
  assert.deepEqual(learnedFirst.rows[0].result, learnedSecond.rows[0].result);
  const extraLearningKey = clone(learning); extraLearningKey.lesson.unexpected = "forbidden";
  await assert.rejects(() => db.query("select public.persist_meta_learning_result($1::jsonb)", [JSON.stringify(extraLearningKey)]), /META_LEARNING_RESULT_INVALID/);
  const conflictingLearning = clone(learning); conflictingLearning.hypothesis.expected_effect = "Contradictory replay";
  await rehashLearning(conflictingLearning);
  await assert.rejects(() => db.query("select public.persist_meta_learning_result($1::jsonb)", [JSON.stringify(conflictingLearning)]), /META_IMMUTABLE_CONFLICT/);
  const brokenLearningLineage = clone(learning); brokenLearningLineage.analysis.experiment_id = "00000000-0000-4000-8000-000000000999";
  await assert.rejects(() => db.query("select public.persist_meta_learning_result($1::jsonb)", [JSON.stringify(brokenLearningLineage)]), /META_LEARNING_LINEAGE_INVALID/);
  const tamperedLearningHash = clone(learning); tamperedLearningHash.lesson.lesson = "Tampered after evidence hashing";
  await assert.rejects(() => db.query("select public.persist_meta_learning_result($1::jsonb)", [JSON.stringify(tamperedLearningHash)]), /META_LEARNING_HASH_INVALID/);
  const extraExperimentNested = clone(learning); extraExperimentNested.experiment.constants.unexpected = "forbidden"; await rehashLearning(extraExperimentNested);
  await assert.rejects(() => db.query("select public.persist_meta_learning_result($1::jsonb)", [JSON.stringify(extraExperimentNested)]), /META_LEARNING_EXPERIMENT_INVALID/);
  const extraAnalysisNested = clone(learning); extraAnalysisNested.analysis.metrics.cpa.unexpected = "forbidden"; await rehashLearning(extraAnalysisNested);
  await assert.rejects(() => db.query("select public.persist_meta_learning_result($1::jsonb)", [JSON.stringify(extraAnalysisNested)]), /META_LEARNING_ANALYSIS_INVALID/);
  const extraLessonNested = clone(learning); extraLessonNested.lesson.sample_size.unexpected = 1; await rehashLearning(extraLessonNested);
  await assert.rejects(() => db.query("select public.persist_meta_learning_result($1::jsonb)", [JSON.stringify(extraLessonNested)]), /META_LEARNING_LESSON_INVALID/);
  await db.exec("reset role");
  const canonicalCounts = await db.query("select (select count(*) from public.experiments)::int experiments,(select count(*) from public.content_analysis_results)::int analyses,(select count(*) from public.content_lessons)::int lessons,(select count(*) from public.content_hypotheses)::int hypotheses");
  assert.deepEqual(canonicalCounts.rows[0], { experiments: 1, analyses: 1, lessons: 1, hypotheses: 1 });
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [raw.user_id]);
  const visible = await db.query("select count(*)::int as count from public.meta_creative_ad_bindings");
  assert.equal(visible.rows[0].count, 3);
  await assert.rejects(() => db.query("insert into public.meta_provider_objects(user_id,provider_account_id,object_kind,external_id,api_version,payload_hash,observed_at) values($1,'1','ACCOUNT','1','v26.0',$2,now())", [raw.user_id, "f".repeat(64)]));
  await db.exec("reset role");
  const orphan = clone(normalized); orphan.profiles[0].identity_map_id = "00000000-0000-4000-8000-000000000999"; await rehashBatch(orphan);
  await db.exec("set role service_role");
  await db.query("select set_config('request.jwt.claim.role','service_role',false)");
  await assert.rejects(() => db.query("select public.persist_meta_readonly_batch($1::jsonb)", [JSON.stringify(orphan)]), /META_IDENTITY_ANCHOR_UNKNOWN/);
  const mismatchedSnapshot = clone(normalized); mismatchedSnapshot.snapshots[0].provider_ad_id = normalized.snapshots[1].provider_ad_id; await rehashBatch(mismatchedSnapshot);
  await assert.rejects(() => db.query("select public.persist_meta_readonly_batch($1::jsonb)", [JSON.stringify(mismatchedSnapshot)]), /META_SNAPSHOT_BINDING_INVALID/);
  const tamperedObjectHash = clone(normalized); tamperedObjectHash.objects[0].payload_hash = "0".repeat(64); await rehashBatch(tamperedObjectHash);
  await assert.rejects(() => db.query("select public.persist_meta_readonly_batch($1::jsonb)", [JSON.stringify(tamperedObjectHash)]), /META_PROVIDER_HASH_INVALID/);
  const tamperedBindingHash = clone(normalized); tamperedBindingHash.bindings[0].binding_evidence_hash = "0".repeat(64); await rehashBatch(tamperedBindingHash);
  await assert.rejects(() => db.query("select public.persist_meta_readonly_batch($1::jsonb)", [JSON.stringify(tamperedBindingHash)]), /META_BINDING_HASH_INVALID/);
  const tamperedSnapshotHash = clone(normalized); tamperedSnapshotHash.snapshots[0].payload_hash = "0".repeat(64); await rehashBatch(tamperedSnapshotHash);
  await assert.rejects(() => db.query("select public.persist_meta_readonly_batch($1::jsonb)", [JSON.stringify(tamperedSnapshotHash)]), /META_SNAPSHOT_HASH_INVALID/);
  await db.exec("reset role");
  await db.close();
});
