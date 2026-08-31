import { canonicalJson, sha256Hex } from "./tiktok-feedback-context.mjs";

export const MARKET_REFERENCE_SCHEMA_VERSION = 1;
export const MARKET_PREVIEW_VERSION = 1;
export const MAX_INGEST_URLS = 5;
export const MAX_OEMBED_BYTES = 65_536;
export const OEMBED_TIMEOUT_MS = 5_000;

export const DNA_FIELDS = Object.freeze([
  "hook_type",
  "first_frame_mechanic",
  "opening_action",
  "visual_pattern",
  "content_format",
  "setup",
  "conflict",
  "viewer_prediction",
  "violation",
  "escalation",
  "payoff",
  "loop_mechanic",
  "pacing_profile",
  "caption_style",
  "character_role",
  "camera_pattern",
  "sound_role",
  "CTA",
  "reusable_formula",
  "critical_fidelity_constraints",
]);

const ALLOWED_HOSTS = new Set(["www.tiktok.com", "m.tiktok.com"]);
const HANDLE = /^[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,22}[A-Za-z0-9_])$/;
const VIDEO_ID = /^[1-9][0-9]{4,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const URL_OR_HANDLE = /(?:(?:https?|ftp|ftps|file|data|tel|urn|mailto|javascript|blob|ws|wss):[^\s]+|\/\/[a-z0-9.-]+\.[a-z]{2,63}(?:[^\s]*)|www\.|tiktok\.com|\[[^\]]+\]\s*\(|@[A-Za-z0-9_.]{2,24}|(?:^|[\s([{,:;])(?:[a-z0-9-]+\.)+[a-z]{2,63}(?=[/?:),.;\]}\s]|$))/iu;
const LONG_EXTERNAL_ID = /(?:^|\D)[1-9][0-9]{9,31}(?:\D|$)/u;
const MARKUP = /<[^>]*>|&(?:lt|gt|quot|#\d+);|javascript:/iu;
const TIMECODE_OR_SHOT = /(?:\b\d{1,2}:\d{2}\b|\b\d+(?:\.\d+)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|sec|сек|с)(?:\s|$)|(?:^|\s)(?:shot|scene|frame|кадр|сцена)\s*#?\d+(?:\s|$))/iu;
const QUOTE = /["'«»“”„‟]/u;
const COPY_INSTRUCTION = /(?:\b(?:copy|clone|replicate|verbatim)\b|сделай\s+(?:точно\s+)?как|как\s+этот\s+tiktok|повтори\s+кадры|скопируй|клонируй)/iu;
const OEMBED_KEYS = new Set([
  "version", "type", "title", "author_url", "author_name", "width", "height",
  "html", "thumbnail_width", "thumbnail_height", "thumbnail_url",
  "provider_url", "provider_name",
]);

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  return object(value) && Object.keys(value).every((key) => allowed.has(key));
}

function fail(code) {
  throw new MarketReferenceError(code);
}

export class MarketReferenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "MarketReferenceError";
    this.code = code;
  }
}

export function validateTikTokReferenceUrl(input) {
  if (typeof input !== "string" || input.length < 1 || input.length > 2_048 ||
      !/^[\x21-\x7e]+$/.test(input) || input.includes("%") || input.includes("\\")) {
    fail("market_url_invalid");
  }
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    fail("market_url_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
      parsed.hash || !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase()) ||
      parsed.pathname.includes("//") || parsed.pathname.split("/").includes("..") ||
      parsed.pathname.split("/").includes(".")) {
    fail("market_url_invalid");
  }
  const match = parsed.pathname.match(/^\/@([^/]+)\/video\/([^/]+)\/?$/);
  if (!match || !HANDLE.test(match[1]) || match[1].includes("..") ||
      match[1].startsWith(".") || match[1].endsWith(".") || !VIDEO_ID.test(match[2])) {
    fail("market_url_invalid");
  }
  const handle = match[1].toLowerCase();
  return Object.freeze({
    external_reference_id: match[2],
    submitted_handle: handle,
    canonical_url: `https://www.tiktok.com/@${handle}/video/${match[2]}`,
  });
}

function validateDimension(value) {
  return value === "100%" || (Number.isSafeInteger(value) && value > 0 && value <= 16_384);
}

function boundedString(value, max, allowEmpty = false) {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0) &&
    !CONTROL_OR_BIDI.test(value);
}

function safeObservedString(value, max, allowEmpty = false) {
  return boundedString(value, max, allowEmpty) && !MARKUP.test(value);
}

function validateAuthorUrl(value) {
  if (typeof value !== "string" || value.length > 512 || value.includes("%") || value.includes("\\")) {
    fail("oembed_schema_invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("oembed_schema_invalid");
  }
  const match = parsed.pathname.match(/^\/@([^/]+)\/?$/);
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.tiktok.com" || parsed.port ||
      parsed.username || parsed.password || parsed.search || parsed.hash || !match ||
      !HANDLE.test(match[1]) || match[1].includes("..") || match[1].startsWith(".") ||
      match[1].endsWith(".")) {
    fail("oembed_schema_invalid");
  }
  return match[1].toLowerCase();
}

function normalizeOEmbed(reference, value, observedAt) {
  if (!exactKeys(value, OEMBED_KEYS) || value.version !== "1.0" || value.type !== "video" ||
      value.provider_name !== "TikTok" || value.provider_url !== "https://www.tiktok.com" ||
      !safeObservedString(value.title, 4_000, true) || !safeObservedString(value.author_name, 256) ||
      !boundedString(value.html, MAX_OEMBED_BYTES, true) || !validateDimension(value.width) ||
      !validateDimension(value.height)) {
    fail("oembed_schema_invalid");
  }
  const creatorHandle = validateAuthorUrl(value.author_url);
  for (const key of ["thumbnail_width", "thumbnail_height"]) {
    if (value[key] !== undefined && !(Number.isSafeInteger(value[key]) && value[key] > 0 && value[key] <= 16_384)) {
      fail("oembed_schema_invalid");
    }
  }
  if (value.thumbnail_url !== undefined && !boundedString(value.thumbnail_url, 4_096)) {
    fail("oembed_schema_invalid");
  }
  return Object.freeze({
    external_reference_id: reference.external_reference_id,
    canonical_url: `https://www.tiktok.com/@${creatorHandle}/video/${reference.external_reference_id}`,
    title: value.title.trim() || null,
    creator_name: value.author_name.trim(),
    creator_handle: creatorHandle,
    author_url: `https://www.tiktok.com/@${creatorHandle}`,
    provider_name: "TikTok",
    provider_url: "https://www.tiktok.com",
    observed_at: observedAt,
  });
}

async function readBoundedBody(response, maxBytes) {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && (!/^[0-9]+$/.test(lengthHeader) || Number(lengthHeader) > maxBytes)) {
    try { await response.body?.cancel(); } catch { /* no-op */ }
    fail("oembed_response_too_large");
  }
  if (!response.body || typeof response.body.getReader !== "function") fail("oembed_body_invalid");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail("oembed_body_invalid");
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        fail("oembed_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("oembed_encoding_invalid");
  }
}

export async function resolveTikTokOEmbed(reference, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? OEMBED_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_OEMBED_BYTES;
  const now = options.now ?? (() => new Date());
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MarketReferenceError("oembed_timeout"));
    }, timeoutMs);
  });
  const operation = (async () => {
    const endpoint = new URL("https://www.tiktok.com/oembed");
    endpoint.searchParams.set("url", reference.canonical_url);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      if (controller.signal.aborted) fail("oembed_timeout");
      fail("oembed_unavailable");
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      fail("oembed_redirect_rejected");
    }
    if (response.status === 429) fail("oembed_rate_limited");
    if (!response.ok) fail("oembed_unavailable");
    const type = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(type)) {
      fail("oembed_content_type_invalid");
    }
    const text = await readBoundedBody(response, maxBytes);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      fail("oembed_json_invalid");
    }
    return normalizeOEmbed(reference, value, now().toISOString());
  })();
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function fact(status, value, sourceLocator, observedAt) {
  return Object.freeze({
    status,
    value,
    source_kind: "TIKTOK_OEMBED",
    source_locator: sourceLocator,
    observed_at: observedAt,
  });
}

export function buildTikTokFactPayload(resolved) {
  const locator = resolved.canonical_url;
  const observed = (value) => fact(value == null ? "UNKNOWN" : "OBSERVED", value, locator, resolved.observed_at);
  const unknown = () => fact("UNKNOWN", null, locator, resolved.observed_at);
  const unsupported = () => fact("UNSUPPORTED", null, locator, resolved.observed_at);
  return Object.freeze({
    schema_version: MARKET_REFERENCE_SCHEMA_VERSION,
    source_type: "MARKET_REFERENCE",
    resolver: "TIKTOK_OEMBED",
    external_reference_id: resolved.external_reference_id,
    facts: {
      external_reference_id: observed(resolved.external_reference_id),
      canonical_url: observed(resolved.canonical_url),
      title: observed(resolved.title),
      creator_name: observed(resolved.creator_name),
      creator_handle: observed(resolved.creator_handle),
      author_url: observed(resolved.author_url),
      provider_name: observed(resolved.provider_name),
      provider_url: observed(resolved.provider_url),
      published_at: unknown(),
      views: unknown(), likes: unknown(), comments: unknown(), shares: unknown(), saves: unknown(),
      follower_baseline: unknown(), velocity: unknown(), outlier_ratio: unknown(),
      retention: unsupported(), completion: unsupported(), watch_time: unsupported(),
      traffic_source: unsupported(),
    },
  });
}

export function factHashMaterial(payload) {
  const facts = Object.fromEntries(Object.entries(payload.facts ?? {}).map(([key, value]) => [
    key,
    object(value) ? Object.fromEntries(Object.entries(value).filter(([name]) => name !== "observed_at")) : value,
  ]));
  return {
    kind: "FACT_OBSERVATION",
    schema_version: payload.schema_version,
    source_type: payload.source_type,
    resolver: payload.resolver,
    external_reference_id: payload.external_reference_id,
    facts,
  };
}

function normalizedText(value, max) {
  if (typeof value !== "string") fail("dna_text_invalid");
  const result = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!result || result.length > max || CONTROL_OR_BIDI.test(result)) fail("dna_text_invalid");
  return result;
}

function leakageSources(sourceFacts) {
  const values = [sourceFacts?.title, sourceFacts?.creator_name, sourceFacts?.creator_handle]
    .filter((value) => typeof value === "string")
    .map((value) => value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase())
    .filter((value) => value.length >= 3);
  return [...new Set(values)];
}

function validateAbstractText(value, max, sourceFacts) {
  const result = normalizedText(value, max);
  const lower = result.toLowerCase();
  if (URL_OR_HANDLE.test(result) || LONG_EXTERNAL_ID.test(result) || MARKUP.test(result) ||
      TIMECODE_OR_SHOT.test(result) || QUOTE.test(result) || COPY_INSTRUCTION.test(result) ||
      leakageSources(sourceFacts).some((source) => lower.includes(source))) {
    fail("dna_anti_copy_rejected");
  }
  return result;
}

export function validateHumanDna(input, options) {
  const allowed = new Set([
    "schema_version", "analysis_method", "analyzed_at", "confidence", "limitations",
    "reviewer_status", "evidence_version", "supersedes_evidence_id", "fact_evidence_ids", "fields",
  ]);
  if (!exactKeys(input, allowed) || input.schema_version !== 1 || input.analysis_method !== "HUMAN_REVIEW" ||
      !["LOW", "MEDIUM", "HIGH"].includes(input.confidence) ||
      !["DRAFT", "ACCEPTED", "REJECTED"].includes(input.reviewer_status) ||
      !Number.isSafeInteger(input.evidence_version) || input.evidence_version < 1 || input.evidence_version > 32_767 ||
      !Array.isArray(input.limitations) || input.limitations.length > 10 || !object(input.fields) ||
      Object.keys(input.fields).length !== DNA_FIELDS.length ||
      !DNA_FIELDS.every((field) => Object.hasOwn(input.fields, field)) ||
      typeof input.analyzed_at !== "string" || !Number.isFinite(Date.parse(input.analyzed_at)) ||
      !Array.isArray(input.fact_evidence_ids) || input.fact_evidence_ids.length < 1 ||
      input.fact_evidence_ids.length > 10 || !input.fact_evidence_ids.every((id) => UUID.test(String(id))) ||
      new Set(input.fact_evidence_ids).size !== input.fact_evidence_ids.length ||
      (input.supersedes_evidence_id !== null && !UUID.test(String(input.supersedes_evidence_id))) ||
      !UUID.test(String(options.marketReferenceId))) {
    fail("dna_schema_invalid");
  }
  if (input.evidence_version === 1 && input.supersedes_evidence_id !== null) fail("dna_version_invalid");
  if (input.evidence_version > 1 && input.supersedes_evidence_id === null) fail("dna_version_invalid");
  const limitations = input.limitations.map((value) => validateAbstractText(value, 200, options.sourceFacts));
  const fields = {};
  let inferred = 0;
  let total = 0;
  for (const name of DNA_FIELDS) {
    const entry = input.fields[name];
    if (!exactKeys(entry, new Set(["status", "value"])) || !["INFERENCE", "UNKNOWN"].includes(entry.status)) {
      fail("dna_schema_invalid");
    }
    if (entry.status === "UNKNOWN") {
      if (entry.value !== null) fail("dna_schema_invalid");
      fields[name] = { status: "UNKNOWN", value: null };
    } else {
      const value = validateAbstractText(entry.value, 500, options.sourceFacts);
      total += value.length;
      inferred += 1;
      fields[name] = { status: "INFERENCE", value };
    }
  }
  if (inferred < 1 || total > 4_000) fail("dna_schema_invalid");
  return Object.freeze({
    schema_version: 1,
    market_reference_id: options.marketReferenceId,
    fact_evidence_ids: [...input.fact_evidence_ids].sort(),
    analysis_method: "HUMAN_REVIEW",
    analyzed_at: new Date(input.analyzed_at).toISOString(),
    confidence: input.confidence,
    limitations,
    reviewer_status: input.reviewer_status,
    evidence_version: input.evidence_version,
    supersedes_evidence_id: input.supersedes_evidence_id,
    fields,
  });
}

export function dnaContentHashMaterial(payload) {
  return {
    kind: "DNA_INFERENCE",
    schema_version: payload.schema_version,
    market_reference_id: payload.market_reference_id,
    fact_evidence_ids: payload.fact_evidence_ids,
    fields: payload.fields,
  };
}

export function dnaFullHashMaterial(payload) {
  return {
    ...dnaContentHashMaterial(payload),
    analyzed_at: payload.analyzed_at,
    confidence: payload.confidence,
    limitations: payload.limitations,
    reviewer_status: payload.reviewer_status,
    evidence_version: payload.evidence_version,
    supersedes_evidence_id: payload.supersedes_evidence_id,
  };
}

export async function buildTikTokMarketPreview(baseContext, input) {
  if (!object(baseContext) || !object(baseContext.OWN_PERFORMANCE) ||
      !object(baseContext.OWNER_PREFERENCE) || typeof baseContext.context_hash !== "string" ||
      !object(input.reference) || !object(input.factEvidence) || !object(input.dnaEvidence) ||
      !["TAKE", "INTERESTING_MECHANIC"].includes(input.reference.owner_disposition) ||
      input.factEvidence.evidence_kind !== "FACT_OBSERVATION" ||
      input.dnaEvidence.evidence_kind !== "DNA_INFERENCE" ||
      input.dnaEvidence.payload?.reviewer_status !== "ACCEPTED") {
    fail("market_preview_ineligible");
  }
  const own = JSON.parse(JSON.stringify(baseContext.OWN_PERFORMANCE));
  const owner = JSON.parse(JSON.stringify(baseContext.OWNER_PREFERENCE));
  owner.MARKET_REFERENCE_DISPOSITIONS = [{
    market_reference_id: input.reference.id,
    disposition: input.reference.owner_disposition,
  }];
  const market = {
    source_type: "MARKET_REFERENCE",
    market_reference_ids: [input.reference.id],
    fact_evidence_ids: [input.factEvidence.id],
    dna_evidence_ids: [input.dnaEvidence.id],
    observed_facts: input.factEvidence.payload.facts,
    inferred_mechanics: input.dnaEvidence.payload.fields,
    confidence: input.dnaEvidence.payload.confidence,
    limitations: input.dnaEvidence.payload.limitations,
  };
  const hashMaterial = {
    preview_version: MARKET_PREVIEW_VERSION,
    base_context_hash: baseContext.context_hash,
    market_reference_id: input.reference.id,
    fact_evidence_id: input.factEvidence.id,
    dna_evidence_id: input.dnaEvidence.id,
    disposition: input.reference.owner_disposition,
  };
  return {
    preview_version: MARKET_PREVIEW_VERSION,
    preview_hash: await sha256Hex(canonicalJson(hashMaterial)),
    platform: "tiktok",
    base_context_hash: baseContext.context_hash,
    OWN_PERFORMANCE: own,
    OWNER_PREFERENCE: owner,
    MARKET_REFERENCE: market,
  };
}
