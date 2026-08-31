import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DNA_FIELDS,
  MarketReferenceError,
  buildTikTokFactPayload,
  buildTikTokMarketPreview,
  dnaContentHashMaterial,
  dnaFullHashMaterial,
  factHashMaterial,
  resolveTikTokOEmbed,
  validateHumanDna,
  validateTikTokReferenceUrl,
} from "../supabase/functions/_shared/tiktok-market-reference.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const migration = fs.readFileSync(path.join(root,
  "supabase/migrations/20260831000004_tiktok_market_reference_v1.sql"), "utf8");
const edge = fs.readFileSync(path.join(root,
  "supabase/functions/tiktok-market-reference/index.ts"), "utf8");

const ids = Array.from({ length: 12 }, (_, index) =>
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);

function oembed(overrides = {}) {
  return {
    version: "1.0", type: "video", title: "Три действия и неожиданный финал",
    author_url: "https://www.tiktok.com/@safe.creator", author_name: "Safe Creator",
    width: "100%", height: "100%", html: "<blockquote>discard me</blockquote>",
    thumbnail_width: 720, thumbnail_height: 1280,
    thumbnail_url: "https://example.invalid/transient.jpg",
    provider_url: "https://www.tiktok.com", provider_name: "TikTok", ...overrides,
  };
}

function response(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });
}

async function resolvedFor(n = 1, overrides = {}) {
  const reference = validateTikTokReferenceUrl(`https://www.tiktok.com/@owner_${n}/video/${7000000000000000000n + BigInt(n)}`);
  return await resolveTikTokOEmbed(reference, {
    fetchImpl: async () => response(oembed({ author_url: `https://www.tiktok.com/@owner_${n}`, ...overrides })),
    now: () => new Date("2026-08-31T06:00:00.000Z"),
  });
}

function dnaInput(overrides = {}) {
  const fields = Object.fromEntries(DNA_FIELDS.map((name) => [name,
    name === "reusable_formula"
      ? { status: "INFERENCE", value: "Дважды установить ожидание, затем изменить один параметр ради развязки" }
      : { status: "UNKNOWN", value: null }]));
  return {
    schema_version: 1,
    analysis_method: "HUMAN_REVIEW",
    analyzed_at: "2026-08-31T06:05:00.000Z",
    confidence: "MEDIUM",
    limitations: ["Ручное наблюдение ограничено одним просмотром"],
    reviewer_status: "ACCEPTED",
    evidence_version: 1,
    supersedes_evidence_id: null,
    fact_evidence_ids: [ids[1]],
    fields,
    ...overrides,
  };
}

test("strict URL validation accepts only canonical supported TikTok video paths", () => {
  assert.deepEqual(validateTikTokReferenceUrl("https://m.tiktok.com/@Safe.Creator/video/7123456789012345678/"), {
    external_reference_id: "7123456789012345678",
    submitted_handle: "safe.creator",
    canonical_url: "https://www.tiktok.com/@safe.creator/video/7123456789012345678",
  });
});

test("strict URL validation rejects unknown domains and deceptive suffixes", () => {
  for (const value of [
    "https://evil.example/@safe/video/7123456789012345678",
    "https://www.tiktok.com.evil.example/@safe/video/7123456789012345678",
    "http://www.tiktok.com/@safe/video/7123456789012345678",
  ]) assert.throws(() => validateTikTokReferenceUrl(value), { code: "market_url_invalid" });
});

test("strict URL validation rejects malformed, redirect, encoded and traversal paths", () => {
  for (const value of [
    "not-a-url", "https://www.tiktok.com/t/ZShort/",
    "https://www.tiktok.com/@safe/video/012345",
    "https://www.tiktok.com/@safe/video/712345%2F6789",
    "https://www.tiktok.com/@safe/../video/7123456789012345678",
    "https://user@www.tiktok.com/@safe/video/7123456789012345678",
    "https://www.tiktok.com:444/@safe/video/7123456789012345678",
  ]) assert.throws(() => validateTikTokReferenceUrl(value), MarketReferenceError);
});

test("oEmbed resolver uses one exact official endpoint with manual redirects", async () => {
  const reference = validateTikTokReferenceUrl("https://www.tiktok.com/@safe/video/7123456789012345678");
  let call;
  const result = await resolveTikTokOEmbed(reference, {
    fetchImpl: async (url, init) => { call = { url: String(url), init }; return response(oembed({
      author_url: "https://www.tiktok.com/@safe",
    })); },
    now: () => new Date("2026-08-31T06:00:00Z"),
  });
  assert.equal(call.url, "https://www.tiktok.com/oembed?url=https%3A%2F%2Fwww.tiktok.com%2F%40safe%2Fvideo%2F7123456789012345678");
  assert.equal(call.init.redirect, "manual");
  assert.equal(call.init.method, "GET");
  assert.equal(result.external_reference_id, "7123456789012345678");
});

test("oEmbed normalization discards provider HTML and thumbnail media", async () => {
  const result = await resolvedFor();
  assert.equal(Object.hasOwn(result, "html"), false);
  assert.equal(Object.hasOwn(result, "thumbnail_url"), false);
  const payload = buildTikTokFactPayload(result);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /<blockquote|"html"|"thumbnail_(?:url|width|height)"|<script/i);
});

test("oEmbed missing optional title becomes UNKNOWN and never synthetic zero", async () => {
  const payload = buildTikTokFactPayload(await resolvedFor(2, { title: "" }));
  assert.equal(payload.facts.title.status, "UNKNOWN");
  assert.equal(payload.facts.title.value, null);
  for (const name of ["views", "likes", "comments", "shares", "saves", "published_at",
    "follower_baseline", "velocity", "outlier_ratio"]) {
    assert.equal(payload.facts[name].status, "UNKNOWN");
    assert.equal(payload.facts[name].value, null);
  }
});

test("unsupported private metrics remain explicit UNSUPPORTED", async () => {
  const payload = buildTikTokFactPayload(await resolvedFor(3));
  for (const name of ["retention", "completion", "watch_time", "traffic_source"]) {
    assert.equal(payload.facts[name].status, "UNSUPPORTED");
    assert.equal(payload.facts[name].value, null);
  }
});

test("one observation never manufactures velocity", async () => {
  const payload = buildTikTokFactPayload(await resolvedFor(4));
  assert.deepEqual(payload.facts.velocity, {
    status: "UNKNOWN", value: null, source_kind: "TIKTOK_OEMBED",
    source_locator: payload.facts.canonical_url.value,
    observed_at: "2026-08-31T06:00:00.000Z",
  });
});

test("FACT identity hash deliberately excludes observed_at", async () => {
  const payload = buildTikTokFactPayload(await resolvedFor(5));
  const later = structuredClone(payload);
  for (const item of Object.values(later.facts)) item.observed_at = "2026-09-01T00:00:00Z";
  assert.deepEqual(factHashMaterial(payload), factHashMaterial(later));
});

test("oEmbed fails closed on redirects, 429, wrong content type and schema drift", async () => {
  const ref = validateTikTokReferenceUrl("https://www.tiktok.com/@safe/video/7123456789012345678");
  const cases = [
    [() => response({}, { status: 302 }), "oembed_redirect_rejected"],
    [() => response({}, { status: 429 }), "oembed_rate_limited"],
    [() => response(oembed(), { headers: { "content-type": "text/html" } }), "oembed_content_type_invalid"],
    [() => response({ ...oembed(), unexpected: true }), "oembed_schema_invalid"],
  ];
  for (const [fetchImpl, code] of cases) {
    await assert.rejects(resolveTikTokOEmbed(ref, { fetchImpl }), { code });
  }
});

test("oEmbed rejects markup hidden in persisted title or author identity", async () => {
  const ref = validateTikTokReferenceUrl("https://www.tiktok.com/@safe/video/7123456789012345678");
  for (const value of [
    oembed({ title: "<script>alert(1)</script>", author_url: "https://www.tiktok.com/@safe" }),
    oembed({ author_name: "<b>Creator</b>", author_url: "https://www.tiktok.com/@safe" }),
  ]) await assert.rejects(resolveTikTokOEmbed(ref, {
    fetchImpl: async () => response(value),
  }), { code: "oembed_schema_invalid" });
});

test("oEmbed rejects JSON-null required identity scalars", async () => {
  const ref = validateTikTokReferenceUrl("https://www.tiktok.com/@safe/video/7123456789012345678");
  for (const override of [{ author_name: null }, { author_url: null }, { provider_name: null }]) {
    await assert.rejects(resolveTikTokOEmbed(ref, {
      fetchImpl: async () => response(oembed(override)),
    }), { code: "oembed_schema_invalid" });
  }
});

test("oEmbed rejects oversized chunked responses before persistence", async () => {
  const ref = validateTikTokReferenceUrl("https://www.tiktok.com/@safe/video/7123456789012345678");
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(40_000));
    controller.enqueue(new Uint8Array(40_000));
    controller.close();
  } });
  await assert.rejects(resolveTikTokOEmbed(ref, {
    fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } }),
  }), { code: "oembed_response_too_large" });
});

test("oEmbed has a bounded timeout", async () => {
  const ref = validateTikTokReferenceUrl("https://www.tiktok.com/@safe/video/7123456789012345678");
  await assert.rejects(resolveTikTokOEmbed(ref, {
    fetchImpl: async () => await new Promise(() => {}), timeoutMs: 5,
  }), { code: "oembed_timeout" });
});

test("DNA schema preserves FACT and INFERENCE separation", () => {
  const result = validateHumanDna(dnaInput(), {
    marketReferenceId: ids[0], sourceFacts: { title: "Исходное название", creator_name: "Автор" },
  });
  assert.equal(result.market_reference_id, ids[0]);
  assert.equal(result.analysis_method, "HUMAN_REVIEW");
  assert.equal(result.fields.reusable_formula.status, "INFERENCE");
  assert.equal(result.fields.hook_type.status, "UNKNOWN");
  assert.equal(Object.hasOwn(result, "observed_facts"), false);
});

test("DNA can leave any structural field UNKNOWN", () => {
  const result = validateHumanDna(dnaInput(), {
    marketReferenceId: ids[0], sourceFacts: {},
  });
  assert.equal(DNA_FIELDS.filter((name) => result.fields[name].status === "UNKNOWN").length, 19);
});

test("anti-copy rejects URLs, handles, quotations, shot sequences and copy instructions", () => {
  const values = [
    "https://www.tiktok.com/reference", "@creator repeat", "Точная фраза «автора»",
    "Кадр 1 затем кадр 2", "Сделай точно как этот TikTok",
  ];
  for (const value of values) {
    const input = dnaInput();
    input.fields.reusable_formula.value = value;
    assert.throws(() => validateHumanDna(input, {
      marketReferenceId: ids[0], sourceFacts: {},
    }), { code: "dna_anti_copy_rejected" });
  }
});

test("anti-copy rejects generic domains and URI schemes at punctuation boundaries", () => {
  for (const value of ["example.com/path", "evil.example/path", "ftp://evil.example/path",
    "Смотри(example.com/path)", "example.com,", "//evil.example/path",
    "data:text/plain,hello", "tel:12345", "urn:isbn:abc"]) {
    const input = dnaInput();
    input.fields.reusable_formula.value = value;
    assert.throws(() => validateHumanDna(input, {
      marketReferenceId: ids[0], sourceFacts: {},
    }), { code: "dna_anti_copy_rejected" });
  }
  const safe = dnaInput();
  safe.fields.reusable_formula.value = "Усилить развязку после третьего повторения действия";
  assert.doesNotThrow(() => validateHumanDna(safe, {
    marketReferenceId: ids[0], sourceFacts: {},
  }));
  for (const prose of ["CTA: попросить подписаться", "Setup: три последовательных действия",
    "Формат: короткая развязка после повтора"]) {
    const labeled = dnaInput();
    labeled.fields.reusable_formula.value = prose;
    assert.doesNotThrow(() => validateHumanDna(labeled, {
      marketReferenceId: ids[0], sourceFacts: {},
    }));
  }
});

test("anti-copy also covers limitations and source title leakage", () => {
  const limitation = dnaInput({ limitations: ["Сделай точно как этот TikTok"] });
  assert.throws(() => validateHumanDna(limitation, {
    marketReferenceId: ids[0], sourceFacts: {},
  }), { code: "dna_anti_copy_rejected" });
  const leaked = dnaInput();
  leaked.fields.reusable_formula.value = "Уникальный заголовок автора";
  assert.throws(() => validateHumanDna(leaked, {
    marketReferenceId: ids[0], sourceFacts: { title: "Уникальный заголовок автора" },
  }), { code: "dna_anti_copy_rejected" });
});

test("DNA has separate structural and full immutable replay hashes", () => {
  const a = validateHumanDna(dnaInput(), { marketReferenceId: ids[0], sourceFacts: {} });
  const b = structuredClone(a);
  b.analyzed_at = "2026-09-01T00:00:00.000Z";
  b.confidence = "HIGH";
  assert.deepEqual(dnaContentHashMaterial(a), dnaContentHashMaterial(b));
  assert.notDeepEqual(dnaFullHashMaterial(a), dnaFullHashMaterial(b));
  assert.deepEqual(dnaFullHashMaterial(a), dnaFullHashMaterial(structuredClone(a)));
});

test("DNA rejects JSON-null top-level and nested required scalars", () => {
  const top = dnaInput({ reviewer_status: null });
  assert.throws(() => validateHumanDna(top, {
    marketReferenceId: ids[0], sourceFacts: {},
  }), { code: "dna_schema_invalid" });
  const nested = dnaInput();
  nested.fields.reusable_formula = { status: null, value: "Безопасная абстрактная механика" };
  assert.throws(() => validateHumanDna(nested, {
    marketReferenceId: ids[0], sourceFacts: {},
  }), { code: "dna_schema_invalid" });
});

test("preview includes only an accepted DNA and keeps three roots separate", async () => {
  const base = { context_hash: "a".repeat(64), OWN_PERFORMANCE: { source_type: "OWN_PERFORMANCE" },
    OWNER_PREFERENCE: { source_type: "OWNER_PREFERENCE", approved: [], rejected: [] } };
  const fact = { id: ids[1], evidence_kind: "FACT_OBSERVATION", payload: { facts: { views: { status: "UNKNOWN" } } } };
  const dna = { id: ids[2], evidence_kind: "DNA_INFERENCE", payload: {
    reviewer_status: "ACCEPTED", fields: { reusable_formula: { status: "INFERENCE", value: "Абстрактный механизм" } },
    confidence: "MEDIUM", limitations: [],
  } };
  const preview = await buildTikTokMarketPreview(base, {
    reference: { id: ids[0], owner_disposition: "TAKE" }, factEvidence: fact, dnaEvidence: dna,
  });
  assert.deepEqual(Object.keys(preview).sort(), ["MARKET_REFERENCE", "OWNER_PREFERENCE",
    "OWN_PERFORMANCE", "base_context_hash", "platform", "preview_hash", "preview_version"].sort());
  assert.equal(preview.MARKET_REFERENCE.source_type, "MARKET_REFERENCE");
  assert.equal(preview.OWN_PERFORMANCE.source_type, "OWN_PERFORMANCE");
  assert.equal(preview.OWNER_PREFERENCE.source_type, "OWNER_PREFERENCE");
});

test("rejected or draft DNA is excluded from MARKET_REFERENCE preview", async () => {
  const base = { context_hash: "b".repeat(64), OWN_PERFORMANCE: {}, OWNER_PREFERENCE: {} };
  for (const status of ["DRAFT", "REJECTED"]) {
    await assert.rejects(buildTikTokMarketPreview(base, {
      reference: { id: ids[0], owner_disposition: "TAKE" },
      factEvidence: { id: ids[1], evidence_kind: "FACT_OBSERVATION", payload: { facts: {} } },
      dnaEvidence: { id: ids[2], evidence_kind: "DNA_INFERENCE", payload: {
        reviewer_status: status, fields: {}, confidence: "LOW", limitations: [],
      } },
    }), { code: "market_preview_ineligible" });
  }
});

test("market disposition is OWNER_PREFERENCE, never performance evidence", async () => {
  const base = { context_hash: "c".repeat(64), OWN_PERFORMANCE: { selected_lessons: [] },
    OWNER_PREFERENCE: { approved: [], rejected: [] } };
  const result = await buildTikTokMarketPreview(base, {
    reference: { id: ids[0], owner_disposition: "INTERESTING_MECHANIC" },
    factEvidence: { id: ids[1], evidence_kind: "FACT_OBSERVATION", payload: { facts: {} } },
    dnaEvidence: { id: ids[2], evidence_kind: "DNA_INFERENCE", payload: {
      reviewer_status: "ACCEPTED", fields: {}, confidence: "LOW", limitations: [],
    } },
  });
  assert.equal(result.OWNER_PREFERENCE.MARKET_REFERENCE_DISPOSITIONS[0].disposition,
    "INTERESTING_MECHANIC");
  assert.equal(Object.hasOwn(result.OWN_PERFORMANCE, "owner_disposition"), false);
});

test("migration has two additive stores, same-owner RLS and append-only evidence", () => {
  assert.match(migration, /create table public\.market_references/i);
  assert.match(migration, /create table public\.market_reference_evidence/i);
  assert.equal((migration.match(/create table public\./gi) ?? []).length, 2);
  assert.match(migration, /auth\.uid\(\)=user_id/g);
  assert.match(migration, /market_reference_evidence_append_only/);
  assert.match(migration, /unique \(user_id,platform,external_reference_id\)/);
  assert.match(migration, /grant execute[\s\S]+service_role/);
});

test("service RPCs enforce exact nested FACT and DNA schemas", () => {
  assert.match(migration, /jsonb_has_exact_keys\(p_payload/);
  assert.match(migration, /market_fact_payload_valid/);
  assert.match(migration, /market_dna_payload_valid/);
  assert.match(migration, /array\['observed_at','source_kind','source_locator','status','value'\]/);
  assert.match(migration, /array\['status','value'\]/);
  assert.match(migration, /v_total between 1 and 4000/);
});

test("SQL exact-schema validators fail closed on JSON null", () => {
  assert.match(migration, /select coalesce\(jsonb_typeof\(p_value\)='object'[\s\S]+,false\)/);
  assert.ok((migration.match(/is not true/g) ?? []).length >= 4);
  assert.ok((migration.match(/is distinct from/g) ?? []).length >= 15);
  assert.match(migration, /jsonb_typeof\(v_envelope->'status'\) is distinct from 'string'/);
  assert.match(migration, /jsonb_typeof\(v_field->'status'\) is distinct from 'string'/);
  assert.match(migration, /coalesce\(p_payload->>'reviewer_status',''\) not in/);
});

test("FACT replay compares normalized payload and identity under lock", () => {
  const lock = migration.indexOf("pg_advisory_xact_lock");
  const hash = migration.indexOf("v_hash:=encode", lock);
  const lookup = migration.indexOf("select * into v_existing", hash);
  const compare = migration.indexOf("market_fact_replay_conflict", lookup);
  assert.ok(lock >= 0 && lock < hash && hash < lookup && lookup < compare);
  assert.match(migration, /creator_name is distinct from nullif/);
});

test("immutable DNA DRAFT transition requires exact content and full replay identity", () => {
  assert.match(migration, /'content_hash',v_content_hash/);
  assert.match(migration, /'reviewer_status',p_payload->'reviewer_status'/);
  assert.match(migration, /'evidence_version',p_payload->'evidence_version'/);
  assert.match(migration, /market_dna_version_conflict/);
  assert.match(migration, /v_prior\.payload->'fact_evidence_ids'[\s\S]+p_payload->'fact_evidence_ids'/);
  assert.match(migration, /v_prior\.payload->'fields'[\s\S]+p_payload->'fields'/);
  assert.match(migration, /e\.payload->>'reviewer_status'='DRAFT'/);
});

test("database contract cannot write market verdicts or lessons", () => {
  const stripped = migration.replace(/comment on[\s\S]*$/i, "");
  assert.doesNotMatch(stripped, /insert into public\.(?:experiments|content_lessons|content_analysis_results)/i);
  assert.doesNotMatch(stripped, /update public\.(?:experiments|content_lessons|content_analysis_results)/i);
  assert.doesNotMatch(stripped, /(?:insert into|update|delete from) public\.(?:experiments|content_lessons|content_analysis_results)/i);
});

test("Edge boundary authenticates configured owner and rejects caller user_id", () => {
  assert.match(edge, /admin\.auth\.getUser/);
  assert.match(edge, /vibepost_content_brigade_owner/);
  assert.match(edge, /owner === data\.user\.id/);
  assert.match(edge, /Object\.hasOwn\(body, "user_id"\)/);
  assert.match(edge, /p_user_id: userId/g);
});

test("Edge boundary does not scrape, crawl, download, publish or invoke learning writes", () => {
  assert.doesNotMatch(edge, /from\("(?:experiments|content_lessons|content_analysis_results)"\)\.(?:insert|update|upsert|delete)/);
  assert.doesNotMatch(edge, /(?:download|crawler|scraper|publish_video|create_content_experiment|insert_content_lesson)\s*\(/i);
  assert.doesNotMatch(edge, /from "\.\.\/suggest-ideas|invoke\(["'](?:suggest-ideas|generator)|ffmpeg\s*\(|whisper\s*\(/i);
  assert.match(edge, /resolveTikTokOEmbed/);
});

test("deterministic E2E: five manual URLs to selected human DNA and three-root preview", async () => {
  const references = [];
  const facts = [];
  for (let index = 1; index <= 5; index++) {
    const resolved = await resolvedFor(index);
    references.push({ id: ids[index + 4], owner_disposition: index === 1 ? "TAKE" : "SKIP" });
    facts.push({ id: ids[index], evidence_kind: "FACT_OBSERVATION", payload: buildTikTokFactPayload(resolved) });
  }
  assert.equal(references.length, 5);
  assert.equal(new Set(facts.map((row) => row.payload.external_reference_id)).size, 5);
  const accepted = validateHumanDna(dnaInput({ fact_evidence_ids: [facts[0].id] }), {
    marketReferenceId: references[0].id, sourceFacts: {},
  });
  const preview = await buildTikTokMarketPreview({
    context_hash: "d".repeat(64),
    OWN_PERFORMANCE: { source_type: "OWN_PERFORMANCE", selected_lessons: [] },
    OWNER_PREFERENCE: { source_type: "OWNER_PREFERENCE", approved: [], rejected: [] },
  }, {
    reference: references[0], factEvidence: facts[0],
    dnaEvidence: { id: ids[11], evidence_kind: "DNA_INFERENCE", payload: accepted },
  });
  assert.deepEqual(preview.MARKET_REFERENCE.market_reference_ids, [references[0].id]);
  assert.deepEqual(preview.MARKET_REFERENCE.fact_evidence_ids, [facts[0].id]);
  assert.deepEqual(preview.MARKET_REFERENCE.dna_evidence_ids, [ids[11]]);
  assert.equal(Object.hasOwn(preview, "hypothesis_candidate"), false);
});
