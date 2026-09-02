const META_ORIGIN = "https://graph.facebook.com";
const EDGES = Object.freeze({
  campaigns: "id,objective",
  adsets: "id,campaign_id,optimization_goal",
  ads: "id,campaign_id,adset_id,creative{id}",
  adcreatives: "id",
  insights: "campaign_id,adset_id,ad_id,spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions,action_values,account_currency,date_start,date_stop,attribution_setting",
});
const HASH_RE = /^[0-9a-f]{64}$/;
const CREATIVE_RE = /^creative-[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID_RE = /^[0-9]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_KEYS = new Set([
  "name", "email", "phone", "ip", "device_id", "headline", "description",
  "message", "body", "copy", "url", "link_url", "targeting", "custom_audiences",
  "lead_form", "comments", "raw", "raw_payload", "access_token",
]);
const METRIC_KEYS = Object.freeze([
  "spend", "impressions", "reach", "frequency", "clicks", "ctr", "cpc", "cpm",
]);

export class MetaReadonlyError extends Error {
  constructor(code) {
    super(code);
    this.name = "MetaReadonlyError";
    this.code = code;
  }
}

function fail(code) {
  throw new MetaReadonlyError(code);
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("META_SCHEMA_INVALID");
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function object(value, keys, code = "META_SCHEMA_INVALID") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(code);
  return value;
}

function noForbiddenKeys(value) {
  if (Array.isArray(value)) {
    value.forEach(noForbiddenKeys);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) fail("META_FIELD_FORBIDDEN");
      noForbiddenKeys(nested);
    }
  }
}

function id(value, pattern = KEY_RE) {
  if (typeof value !== "string" || !pattern.test(value)) fail("META_ID_INVALID");
  return value;
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    fail("META_TIME_INVALID");
  }
  return value;
}

function date(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail("META_TIME_INVALID");
  }
  return value;
}

function optionalKey(value) {
  if (value === null) return null;
  return id(value);
}

function metric(value, integer = false) {
  if (value === null) return Object.freeze({ state: "UNKNOWN", value: null });
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) fail("META_METRIC_INVALID");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isSafeInteger(parsed))) fail("META_METRIC_INVALID");
  return Object.freeze({ state: "KNOWN", value: parsed });
}

function assertProviderId(value) {
  return id(value, PROVIDER_ID_RE);
}

function requestUrl({ accountId, apiVersion, edge, dateStart, dateStop }) {
  if (!/^v\d+\.\d+$/.test(apiVersion)) fail("META_CONFIG_INVALID");
  assertProviderId(accountId);
  if (!(edge in EDGES)) fail("META_EDGE_FORBIDDEN");
  const url = new URL(`${META_ORIGIN}/${apiVersion}/act_${accountId}/${edge}`);
  url.searchParams.set("fields", EDGES[edge]);
  url.searchParams.set("limit", "100");
  if (edge === "insights") {
    url.searchParams.set("level", "ad");
    url.searchParams.set("time_range", JSON.stringify({ since: date(dateStart), until: date(dateStop) }));
  }
  return url.toString();
}

export function metaReadRequests({ accountId, apiVersion, dateStart, dateStop }) {
  return Object.keys(EDGES).map((edge) => Object.freeze({
    method: "GET",
    edge,
    url: requestUrl({ accountId, apiVersion, edge, dateStart, dateStop }),
  }));
}

export function assertMetaReadDescriptor(descriptor) {
  object(descriptor, ["method", "edge", "url"], "META_REQUEST_INVALID");
  if (descriptor.method !== "GET" || !(descriptor.edge in EDGES)) fail("META_WRITE_FORBIDDEN");
  const url = new URL(descriptor.url);
  if (url.origin !== META_ORIGIN || !new RegExp(`^/v\\d+\\.\\d+/act_[0-9]{1,64}/${descriptor.edge}$`).test(url.pathname)) {
    fail("META_REQUEST_INVALID");
  }
  const expectedParams = descriptor.edge === "insights"
    ? ["fields", "level", "limit", "time_range"]
    : ["fields", "limit"];
  const actualParams = [...url.searchParams.keys()].sort();
  if (canonicalJson(actualParams) !== canonicalJson(expectedParams.sort())) fail("META_FIELDSET_FORBIDDEN");
  if (url.searchParams.getAll("fields").length !== 1 || url.searchParams.get("fields") !== EDGES[descriptor.edge]) {
    fail("META_FIELDSET_FORBIDDEN");
  }
  if (url.searchParams.getAll("limit").length !== 1 || url.searchParams.get("limit") !== "100") fail("META_REQUEST_INVALID");
  if (descriptor.edge === "insights") {
    if (url.searchParams.getAll("level").length !== 1 || url.searchParams.get("level") !== "ad") fail("META_FIELDSET_FORBIDDEN");
    let range;
    try { range = JSON.parse(url.searchParams.get("time_range")); } catch { fail("META_REQUEST_INVALID"); }
    object(range, ["since", "until"], "META_REQUEST_INVALID");
    date(range.since); date(range.until);
  }
  return descriptor;
}

function assertPaginationUrl(candidate, descriptor) {
  const pageUrl = new URL(candidate);
  const originalUrl = new URL(descriptor.url);
  if (pageUrl.origin !== META_ORIGIN || pageUrl.pathname !== originalUrl.pathname) {
    fail("META_PAGINATION_FORBIDDEN");
  }
  if (pageUrl.searchParams.has("access_token")) fail("META_SECRET_LOCATION_FORBIDDEN");
  const allowed = new Set([...originalUrl.searchParams.keys(), "after", "before", "__paging_token"]);
  if ([...pageUrl.searchParams.keys()].some((key) => !allowed.has(key))) fail("META_PAGINATION_FORBIDDEN");
  if ([...new Set(pageUrl.searchParams.keys())].some((key) => pageUrl.searchParams.getAll(key).length !== 1)) fail("META_PAGINATION_FORBIDDEN");
  if (pageUrl.searchParams.get("fields") !== EDGES[descriptor.edge]) fail("META_FIELDSET_FORBIDDEN");
  for (const key of ["fields", "limit", "level", "time_range"]) {
    if (originalUrl.searchParams.has(key) && pageUrl.searchParams.get(key) !== originalUrl.searchParams.get(key)) {
      fail("META_PAGINATION_FORBIDDEN");
    }
  }
  return pageUrl.toString();
}

export async function executeMetaRead({ descriptors, accessToken, fetchImpl = fetch }) {
  if (typeof accessToken !== "string" || accessToken.length < 16) fail("META_CONFIG_INVALID");
  const result = {};
  for (const original of descriptors) {
    const descriptor = assertMetaReadDescriptor(original);
    let next = descriptor.url;
    const rows = [];
    for (let page = 0; next && page < 50; page += 1) {
      const response = await fetchImpl(next, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (!response.ok) fail("META_READ_FAILED");
      const body = await response.json();
      object(body, body.paging === undefined ? ["data"] : ["data", "paging"], "META_RESPONSE_INVALID");
      if (!Array.isArray(body.data)) fail("META_RESPONSE_INVALID");
      rows.push(...body.data);
      const candidate = body.paging?.next ?? null;
      if (candidate !== null) {
        next = assertPaginationUrl(candidate, descriptor);
      } else {
        next = null;
      }
    }
    if (next !== null) fail("META_PAGINATION_LIMIT");
    result[descriptor.edge] = rows;
  }
  return result;
}

const PROFILE_KEYS = ["id", "identity_map_id", "creative_id", "product_key", "audience_key", "topic_key", "format_key", "angle_key", "source_kind", "source_ref", "source_hash"];
const BINDING_KEYS = ["id", "identity_map_id", "creative_id", "account_id", "ad_id", "provider_creative_id", "binding_source", "bound_at"];
const INSIGHT_KEYS = ["id", "binding_id", "account_id", "ad_id", "date_start", "date_stop", "collected_at", "currency", "attribution_setting", "placement_key", "audience_key", "optimization_goal", "cohort_hash", "metrics", "actions", "limitations"];
const ACTION_KEYS = ["id", "action_type", "value", "currency", "authoritative"];

export async function normalizeMetaReadBundle(input) {
  noForbiddenKeys(input);
  object(input, ["schema", "api_version", "field_set_version", "user_id", "creative_profiles", "accounts", "campaigns", "adsets", "creatives", "ads", "bindings", "insights"]);
  if (input.schema !== "meta-read-bundle-v1") fail("META_SCHEMA_INVALID");
  id(input.user_id, UUID_RE);
  id(input.api_version);
  id(input.field_set_version);
  for (const key of ["creative_profiles", "accounts", "campaigns", "adsets", "creatives", "ads", "bindings", "insights"]) {
    if (!Array.isArray(input[key])) fail("META_SCHEMA_INVALID");
  }

  const profiles = [];
  const profileByCreative = new Map();
  for (const value of input.creative_profiles) {
    const row = object(value, PROFILE_KEYS);
    id(row.id, UUID_RE); id(row.identity_map_id, UUID_RE); id(row.creative_id, CREATIVE_RE);
    [row.product_key, row.audience_key, row.topic_key, row.format_key, row.angle_key, row.source_ref].forEach((item) => id(item));
    if (!["OWNER_ASSERTED", "TEXT_HANDOFF"].includes(row.source_kind) || !HASH_RE.test(row.source_hash)) fail("META_PROFILE_INVALID");
    if (profileByCreative.has(row.creative_id)) fail("META_PROFILE_CONFLICT");
    const normalized = { ...row, user_id: input.user_id };
    profiles.push(normalized);
    profileByCreative.set(row.creative_id, normalized);
  }

  const accounts = new Map();
  const campaigns = new Map();
  const adsets = new Map();
  const creatives = new Map();
  const ads = new Map();
  const objects = [];
  const pushObject = async (row, material) => {
    const payload_hash = await sha256Hex(canonicalJson(material));
    objects.push({ ...material, id: row.row_id, user_id: input.user_id, api_version: input.api_version, payload_hash, observed_at: input.insights[0]?.collected_at ?? "1970-01-01T00:00:00Z" });
  };

  for (const value of input.accounts) {
    const row = object(value, ["row_id", "id"]); id(row.row_id, UUID_RE); assertProviderId(row.id);
    if (accounts.has(row.id)) fail("META_OBJECT_CONFLICT"); accounts.set(row.id, row);
    await pushObject(row, { provider_account_id: row.id, object_kind: "ACCOUNT", external_id: row.id, parent_external_id: null, campaign_external_id: null, adset_external_id: null, creative_external_id: null, objective_key: null, optimization_goal: null });
  }
  for (const value of input.campaigns) {
    const row = object(value, ["row_id", "id", "account_id", "objective"]); id(row.row_id, UUID_RE); [row.id, row.account_id].forEach(assertProviderId); optionalKey(row.objective);
    if (!accounts.has(row.account_id) || campaigns.has(row.id)) fail("META_OBJECT_CONFLICT"); campaigns.set(row.id, row);
    await pushObject(row, { provider_account_id: row.account_id, object_kind: "CAMPAIGN", external_id: row.id, parent_external_id: row.account_id, campaign_external_id: row.id, adset_external_id: null, creative_external_id: null, objective_key: row.objective, optimization_goal: null });
  }
  for (const value of input.adsets) {
    const row = object(value, ["row_id", "id", "account_id", "campaign_id", "optimization_goal"]); id(row.row_id, UUID_RE); [row.id, row.account_id, row.campaign_id].forEach(assertProviderId); optionalKey(row.optimization_goal);
    const campaign = campaigns.get(row.campaign_id);
    if (!campaign || campaign.account_id !== row.account_id || adsets.has(row.id)) fail("META_OBJECT_CONFLICT"); adsets.set(row.id, row);
    await pushObject(row, { provider_account_id: row.account_id, object_kind: "ADSET", external_id: row.id, parent_external_id: row.campaign_id, campaign_external_id: row.campaign_id, adset_external_id: row.id, creative_external_id: null, objective_key: null, optimization_goal: row.optimization_goal });
  }
  for (const value of input.creatives) {
    const row = object(value, ["row_id", "id", "account_id"]); id(row.row_id, UUID_RE); [row.id, row.account_id].forEach(assertProviderId);
    if (!accounts.has(row.account_id) || creatives.has(row.id)) fail("META_OBJECT_CONFLICT"); creatives.set(row.id, row);
    await pushObject(row, { provider_account_id: row.account_id, object_kind: "CREATIVE", external_id: row.id, parent_external_id: row.account_id, campaign_external_id: null, adset_external_id: null, creative_external_id: row.id, objective_key: null, optimization_goal: null });
  }
  for (const value of input.ads) {
    const row = object(value, ["row_id", "id", "account_id", "campaign_id", "adset_id", "creative_id"]); id(row.row_id, UUID_RE); [row.id, row.account_id, row.campaign_id, row.adset_id, row.creative_id].forEach(assertProviderId);
    const adset = adsets.get(row.adset_id); const creative = creatives.get(row.creative_id);
    if (!adset || !creative || adset.account_id !== row.account_id || adset.campaign_id !== row.campaign_id || creative.account_id !== row.account_id || ads.has(row.id)) fail("META_OBJECT_CONFLICT"); ads.set(row.id, row);
    await pushObject(row, { provider_account_id: row.account_id, object_kind: "AD", external_id: row.id, parent_external_id: row.adset_id, campaign_external_id: row.campaign_id, adset_external_id: row.adset_id, creative_external_id: row.creative_id, objective_key: null, optimization_goal: adset.optimization_goal });
  }

  const bindings = [];
  const bindingById = new Map();
  const bindingByAd = new Map();
  for (const value of input.bindings) {
    const row = object(value, BINDING_KEYS); id(row.id, UUID_RE); id(row.identity_map_id, UUID_RE); id(row.creative_id, CREATIVE_RE); [row.account_id, row.ad_id, row.provider_creative_id].forEach(assertProviderId); timestamp(row.bound_at);
    const profile = profileByCreative.get(row.creative_id); const ad = ads.get(row.ad_id); const creative = creatives.get(row.provider_creative_id);
    if (!profile || profile.identity_map_id !== row.identity_map_id || !ad || !creative || ad.account_id !== row.account_id || ad.creative_id !== row.provider_creative_id || !["OWNER_ASSERTED", "TEXT_HANDOFF"].includes(row.binding_source)) fail("META_BINDING_UNKNOWN");
    if (bindingById.has(row.id) || bindingByAd.has(`${row.account_id}:${row.ad_id}`)) fail("META_BINDING_CONFLICT");
    const binding_evidence_hash = await sha256Hex(canonicalJson(row));
    const normalized = { id: row.id, user_id: input.user_id, identity_map_id: row.identity_map_id, creative_id: row.creative_id, provider_account_id: row.account_id, provider_ad_id: row.ad_id, provider_creative_id: row.provider_creative_id, ad_object_id: ad.row_id, creative_object_id: creative.row_id, binding_source: row.binding_source, binding_evidence_hash, bound_at: row.bound_at };
    bindings.push(normalized); bindingById.set(row.id, normalized); bindingByAd.set(`${row.account_id}:${row.ad_id}`, normalized);
  }

  const snapshots = [];
  const actions = [];
  const snapshotById = new Map();
  for (const value of input.insights) {
    const row = object(value, INSIGHT_KEYS); id(row.id, UUID_RE); id(row.binding_id, UUID_RE); [row.account_id, row.ad_id].forEach(assertProviderId); date(row.date_start); date(row.date_stop); timestamp(row.collected_at);
    if (row.date_start > row.date_stop || typeof row.currency !== "string" || !/^(?:[A-Z]{3}|UNKNOWN)$/.test(row.currency) || !HASH_RE.test(row.cohort_hash)) fail("META_SNAPSHOT_INVALID");
    [row.placement_key, row.audience_key].forEach((item) => id(item)); optionalKey(row.optimization_goal); if (row.attribution_setting !== null) id(row.attribution_setting);
    const binding = bindingById.get(row.binding_id); if (!binding || binding.provider_account_id !== row.account_id || binding.provider_ad_id !== row.ad_id || snapshotById.has(row.id)) fail("META_SNAPSHOT_INVALID");
    const rawMetrics = object(row.metrics, METRIC_KEYS);
    const metrics = {};
    for (const key of METRIC_KEYS) metrics[key] = metric(rawMetrics[key], ["impressions", "reach", "clicks"].includes(key));
    if (!Array.isArray(row.actions) || !Array.isArray(row.limitations) || row.limitations.some((item) => typeof item !== "string" || !KEY_RE.test(item))) fail("META_SNAPSHOT_INVALID");
    const normalizedActions = [];
    const actionTypes = new Set();
    for (const actionValue of row.actions) {
      const action = object(actionValue, ACTION_KEYS); id(action.id, UUID_RE); id(action.action_type); if (action.currency !== null && !/^[A-Z]{3}$/.test(action.currency)) fail("META_ACTION_INVALID"); if (typeof action.authoritative !== "boolean" || actionTypes.has(action.action_type)) fail("META_ACTION_INVALID");
      actionTypes.add(action.action_type);
      normalizedActions.push({ id: action.id, user_id: input.user_id, snapshot_id: row.id, action_type: action.action_type, ...metric(action.value), currency: action.currency, authoritative: action.authoritative });
    }
    const payloadActions = normalizedActions
      .map(({ action_type, value, state, currency, authoritative }) => ({ action_type, value, state, currency, authoritative }))
      .sort((left, right) => left.action_type.localeCompare(right.action_type));
    const payloadMaterial = { provider_account_id: row.account_id, provider_ad_id: row.ad_id, date_start: row.date_start, date_stop: row.date_stop, currency: row.currency, attribution_setting: row.attribution_setting, placement_key: row.placement_key, audience_key: row.audience_key, optimization_goal: row.optimization_goal, cohort_hash: row.cohort_hash, metrics, actions: payloadActions, limitations: row.limitations };
    const payload_hash = await sha256Hex(canonicalJson(payloadMaterial));
    const snapshot_key = await sha256Hex(canonicalJson({ binding_id: row.binding_id, date_start: row.date_start, date_stop: row.date_stop, cohort_hash: row.cohort_hash, field_set_version: input.field_set_version, payload_hash }));
    const normalized = { id: row.id, user_id: input.user_id, binding_id: row.binding_id, provider_account_id: row.account_id, provider_ad_id: row.ad_id, date_start: row.date_start, date_stop: row.date_stop, collected_at: row.collected_at, currency: row.currency, attribution_setting: row.attribution_setting, placement_key: row.placement_key, audience_key: row.audience_key, optimization_goal: row.optimization_goal, cohort_hash: row.cohort_hash, field_set_version: input.field_set_version, api_version: input.api_version, payload_hash, snapshot_key, metrics, limitations: [...row.limitations] };
    snapshots.push(normalized); snapshotById.set(row.id, normalized);
    actions.push(...normalizedActions);
  }

  const stable = { schema: "meta-normalized-batch-v1", user_id: input.user_id, profiles, objects, bindings, snapshots, actions };
  return { ...stable, batch_hash: await sha256Hex(canonicalJson(stable)) };
}

function providerRow(value, required, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("META_RESPONSE_INVALID");
  const keys = Object.keys(value);
  if (required.some((key) => !(key in value)) || keys.some((key) => !allowed.includes(key))) fail("META_RESPONSE_INVALID");
  return value;
}

async function deterministicUuid(namespace, material) {
  const value = (await sha256Hex(canonicalJson({ namespace, material }))).slice(0, 32).split("");
  value[12] = "4";
  value[16] = ["8", "9", "a", "b"][Number.parseInt(value[16], 16) % 4];
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function normalizeMetaGraphResult({ graph, context, apiVersion, dateStart, dateStop }) {
  noForbiddenKeys(graph);
  object(graph, Object.keys(EDGES), "META_RESPONSE_INVALID");
  object(context, ["schema", "user_id", "account_id", "field_set_version", "collected_at", "placement_key", "creative_profiles", "bindings", "authoritative_actions"], "META_NORMALIZATION_CONTEXT_INVALID");
  if (context.schema !== "meta-normalization-context-v1" || context.field_set_version !== "meta-readonly-v1" || !/^v\d+\.\d+$/.test(apiVersion)) fail("META_NORMALIZATION_CONTEXT_INVALID");
  id(context.user_id, UUID_RE); assertProviderId(context.account_id); id(context.field_set_version);
  timestamp(context.collected_at); id(context.placement_key); date(dateStart); date(dateStop);
  if (!Array.isArray(context.creative_profiles) || !Array.isArray(context.bindings) || !Array.isArray(context.authoritative_actions)) fail("META_NORMALIZATION_CONTEXT_INVALID");
  const authority = new Map();
  for (const value of context.authoritative_actions) {
    const row = object(value, ["action_type", "currency"], "META_NORMALIZATION_CONTEXT_INVALID");
    id(row.action_type); if (row.currency !== null && !/^[A-Z]{3}$/.test(row.currency)) fail("META_NORMALIZATION_CONTEXT_INVALID");
    if (authority.has(row.action_type)) fail("META_NORMALIZATION_CONTEXT_INVALID");
    authority.set(row.action_type, row.currency);
  }
  for (const key of Object.keys(EDGES)) if (!Array.isArray(graph[key])) fail("META_RESPONSE_INVALID");

  const accounts = [{ row_id: await deterministicUuid("account", context.account_id), id: context.account_id }];
  const campaigns = [];
  for (const value of graph.campaigns) {
    const row = providerRow(value, ["id"], ["id", "objective"]); assertProviderId(row.id); optionalKey(row.objective ?? null);
    campaigns.push({ row_id: await deterministicUuid("campaign", [context.account_id, row.id]), id: row.id, account_id: context.account_id, objective: row.objective ?? null });
  }
  const adsets = [];
  for (const value of graph.adsets) {
    const row = providerRow(value, ["id", "campaign_id"], ["id", "campaign_id", "optimization_goal"]);
    [row.id, row.campaign_id].forEach(assertProviderId); optionalKey(row.optimization_goal ?? null);
    adsets.push({ row_id: await deterministicUuid("adset", [context.account_id, row.id]), id: row.id, account_id: context.account_id, campaign_id: row.campaign_id, optimization_goal: row.optimization_goal ?? null });
  }
  const creatives = [];
  for (const value of graph.adcreatives) {
    const row = providerRow(value, ["id"], ["id"]); assertProviderId(row.id);
    creatives.push({ row_id: await deterministicUuid("creative", [context.account_id, row.id]), id: row.id, account_id: context.account_id });
  }
  const ads = [];
  for (const value of graph.ads) {
    const row = providerRow(value, ["id", "campaign_id", "adset_id", "creative"], ["id", "campaign_id", "adset_id", "creative"]);
    providerRow(row.creative, ["id"], ["id"]); [row.id, row.campaign_id, row.adset_id, row.creative.id].forEach(assertProviderId);
    ads.push({ row_id: await deterministicUuid("ad", [context.account_id, row.id]), id: row.id, account_id: context.account_id, campaign_id: row.campaign_id, adset_id: row.adset_id, creative_id: row.creative.id });
  }
  const bindingByAd = new Map();
  for (const value of context.bindings) {
    const row = object(value, BINDING_KEYS, "META_NORMALIZATION_CONTEXT_INVALID");
    if (row.account_id !== context.account_id || bindingByAd.has(row.ad_id)) fail("META_NORMALIZATION_CONTEXT_INVALID");
    bindingByAd.set(row.ad_id, row);
  }
  const profileByCreative = new Map(context.creative_profiles.map((row) => [row.creative_id, row]));
  const insights = [];
  const insightKeys = ["campaign_id", "adset_id", "ad_id", "spend", "impressions", "reach", "frequency", "clicks", "ctr", "cpc", "cpm", "actions", "action_values", "account_currency", "date_start", "date_stop", "attribution_setting"];
  for (const value of graph.insights) {
    const row = providerRow(value, ["campaign_id", "adset_id", "ad_id", "date_start", "date_stop"], insightKeys);
    [row.campaign_id, row.adset_id, row.ad_id].forEach(assertProviderId);
    if (row.date_start !== dateStart || row.date_stop !== dateStop) fail("META_RESPONSE_INVALID");
    const binding = bindingByAd.get(row.ad_id); const profile = binding ? profileByCreative.get(binding.creative_id) : null;
    if (!binding || !profile) fail("META_BINDING_UNKNOWN");
    const rawActions = [];
    const appendActions = (values, suffix, currency) => {
      if (values === undefined) return;
      if (!Array.isArray(values)) fail("META_RESPONSE_INVALID");
      for (const entry of values) {
        const action = providerRow(entry, ["action_type", "value"], ["action_type", "value"]);
        id(action.action_type); const actionType = `${action.action_type}${suffix}`;
        rawActions.push({ action_type: actionType, value: action.value, currency, authoritative: authority.has(actionType) && authority.get(actionType) === currency });
      }
    };
    appendActions(row.actions, "", null);
    appendActions(row.action_values, "_value", row.account_currency ?? null);
    if (new Set(rawActions.map((item) => item.action_type)).size !== rawActions.length) fail("META_ACTION_INVALID");
    const insightId = await deterministicUuid("insight", [context.account_id, row.ad_id, row.date_start, row.date_stop, context.collected_at]);
    insights.push({
      id: insightId, binding_id: binding.id, account_id: context.account_id, ad_id: row.ad_id,
      date_start: row.date_start, date_stop: row.date_stop, collected_at: context.collected_at,
      currency: row.account_currency ?? "UNKNOWN", attribution_setting: row.attribution_setting ?? null,
      placement_key: context.placement_key, audience_key: profile.audience_key,
      optimization_goal: adsets.find((item) => item.id === row.adset_id)?.optimization_goal ?? null,
      cohort_hash: await sha256Hex(canonicalJson({ account_id: context.account_id, audience_key: profile.audience_key, placement_key: context.placement_key, attribution_setting: row.attribution_setting ?? null, date_start: row.date_start, date_stop: row.date_stop })),
      metrics: Object.fromEntries(METRIC_KEYS.map((key) => [key, row[key] ?? null])),
      actions: await Promise.all(rawActions.map(async (action) => ({ id: await deterministicUuid("action", [insightId, action.action_type]), ...action }))),
      limitations: row.account_currency === undefined ? ["ACCOUNT_CURRENCY_UNKNOWN"] : [],
    });
  }
  return normalizeMetaReadBundle({
    schema: "meta-read-bundle-v1", api_version: apiVersion, field_set_version: context.field_set_version,
    user_id: context.user_id, creative_profiles: context.creative_profiles, accounts, campaigns, adsets,
    creatives, ads, bindings: context.bindings, insights,
  });
}

export const META_READ_EDGES = Object.freeze({ ...EDGES });
