const TOKEN_RE = /^cf1_[A-Za-z0-9_-]{43}$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const BOT_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/u;

export class TelegramAttributionError extends Error {
  constructor(code) {
    super(code);
    this.name = "TelegramAttributionError";
    this.code = code;
  }
}

export function generateCf1Token(random = crypto) {
  const bytes = new Uint8Array(32);
  random.getRandomValues(bytes);
  const body = toBase64Url(bytes);
  const token = `cf1_${body}`;
  if (!TOKEN_RE.test(token)) throw new TelegramAttributionError("TOKEN_GENERATION_FAILED");
  return token;
}

export async function digestCf1Token(token) {
  if (!TOKEN_RE.test(token)) throw new TelegramAttributionError("TOKEN_INVALID");
  const bytes = new TextEncoder().encode(token);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function readBoundedStrictJson(req, maxBytes, allowedKeys, requiredKeys = allowedKeys) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new TelegramAttributionError("CONTENT_TYPE_INVALID");
  }
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d{1,9}$/u.test(declared) || Number(declared) > maxBytes)) {
    throw new TelegramAttributionError("REQUEST_TOO_LARGE");
  }
  if (!req.body) throw new TelegramAttributionError("REQUEST_SCHEMA_INVALID");
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new TelegramAttributionError("REQUEST_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new TelegramAttributionError("REQUEST_SCHEMA_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowedKeys.includes(key)) ||
      requiredKeys.some((key) => !(key in value))) {
    throw new TelegramAttributionError("REQUEST_SCHEMA_INVALID");
  }
  return value;
}

export function buildMeetingDeepLink(botUsername, token) {
  if (!BOT_USERNAME_RE.test(botUsername) || !TOKEN_RE.test(token)) {
    throw new TelegramAttributionError("DEEPLINK_INVALID");
  }
  const url = new URL(`https://t.me/${botUsername}`);
  url.searchParams.set("start", token);
  return url.toString();
}

export function normalizeTokenValidation(value) {
  const keys = ["active", "token_digest", "token_version", "destination"];
  exactObject(value, keys, "VALIDATION_SCHEMA_INVALID");
  if (value.active !== true || !DIGEST_RE.test(value.token_digest) ||
      value.token_version !== "cf1" || value.destination !== "meeting_assistant") {
    throw new TelegramAttributionError("TOKEN_UNKNOWN_OR_REVOKED");
  }
  return Object.freeze({ ...value });
}

export async function handleInternalTokenValidation(req, options) {
  if (req.method !== "POST") return boundaryJson(405, { error: "METHOD_NOT_ALLOWED" });
  const supplied = req.headers.get("x-meeting-attribution-secret") ?? "";
  if (typeof options.expectedSecret !== "string" || options.expectedSecret.length < 32 ||
      !constantTimeEqual(options.expectedSecret, supplied)) {
    return boundaryJson(401, { error: "UNAUTHORIZED" });
  }
  try {
    const body = await readBoundedStrictJson(req, 512, ["token_digest"]);
    if (typeof body.token_digest !== "string" || !DIGEST_RE.test(body.token_digest)) {
      return boundaryJson(400, { error: "DIGEST_INVALID" });
    }
    const row = await options.resolve(body.token_digest);
    if (!row) return boundaryJson(404, { active: false });
    return boundaryJson(200, {
      active: true,
      token_digest: body.token_digest,
      token_version: row.token_version,
      destination: row.destination,
    });
  } catch {
    return boundaryJson(400, { error: "REQUEST_INVALID" });
  }
}

export function normalizePiiFreeOutcomePage(value) {
  exactObject(value, ["status", "events", "complete", "next_cursor"], "OUTCOME_SCHEMA_INVALID");
  if (!Array.isArray(value.events) || value.events.length > 100 || typeof value.complete !== "boolean" ||
      !["OK", "NO_EVENTS"].includes(value.status) ||
      !(value.next_cursor === null || (typeof value.next_cursor === "string" &&
        /^[A-Za-z0-9_-]{1,512}$/u.test(value.next_cursor))) ||
      (value.status === "NO_EVENTS" && (value.events.length !== 0 || value.complete !== true || value.next_cursor !== null)) ||
      (value.status === "OK" && value.events.length === 0) ||
      (value.complete && value.next_cursor !== null) || (!value.complete && value.next_cursor === null)) {
    throw new TelegramAttributionError("OUTCOME_SCHEMA_INVALID");
  }
  const allowed = ["event_id", "event_type", "token_digest", "source_system", "subject_id",
    "booking_id", "occurred_at", "status", "attribution_quality", "provenance"];
  const events = value.events.map((event) => {
    exactObject(event, allowed, "OUTCOME_SCHEMA_INVALID");
    exactObject(event.provenance, ["policy_version", "source_record_id"], "OUTCOME_SCHEMA_INVALID");
    const canonicalTime = typeof event.occurred_at === "string" &&
      Number.isFinite(Date.parse(event.occurred_at)) && new Date(event.occurred_at).toISOString() === event.occurred_at;
    const id = (input) => typeof input === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(input);
    const eventType = ["BOT_START", "LEAD_CREATED", "LEAD_CONFIRMED"].includes(event.event_type);
    const quality = ["DIRECT_LINK", "DETERMINISTIC", "AMBIGUOUS", "UNKNOWN"].includes(event.attribution_quality);
    const eventShape = event.event_type === "BOT_START"
      ? event.attribution_quality === "DIRECT_LINK" && event.booking_id === null && event.status === "ACTIVE"
      : event.attribution_quality !== "DIRECT_LINK" && id(event.booking_id) && event.status === "RECORDED";
    if (!eventType || !quality || !eventShape || event.source_system !== "meeting_assistant" ||
        !DIGEST_RE.test(event.token_digest) || typeof event.event_id !== "string" ||
        !id(event.event_id) || !id(event.subject_id) || !canonicalTime ||
        event.provenance.policy_version !== "TELEGRAM_LEAD_ATTRIBUTION_V1" ||
        !id(event.provenance.source_record_id)) {
      throw new TelegramAttributionError("OUTCOME_SCHEMA_INVALID");
    }
    return Object.freeze({ ...event });
  });
  return Object.freeze({ ...value, events: Object.freeze(events) });
}

export function mapBusinessEvidence(mapping, event) {
  if (!mapping || mapping.token_digest !== event.token_digest) {
    throw new TelegramAttributionError("ATTRIBUTION_GAP");
  }
  return Object.freeze({
    evidence_root: "BUSINESS_PERFORMANCE",
    creative_id: mapping.creative_id,
    publication_id: mapping.publication_id,
    platform: "telegram",
    token_id: mapping.token_id,
    business_event_type: event.event_type,
    source_event_id: event.event_id,
    booking_id: event.booking_id ?? null,
    occurred_at: event.occurred_at,
    attribution_quality: event.attribution_quality,
    provenance: event.provenance,
  });
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)) ||
      keys.some((key) => !(key in value))) {
    throw new TelegramAttributionError(code);
  }
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % Math.max(a.length, 1)] ?? 0) ^
      (b[index % Math.max(b.length, 1)] ?? 0);
  }
  return difference === 0;
}

function boundaryJson(status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const TELEGRAM_ATTRIBUTION = Object.freeze({
  TOKEN_RE,
  DIGEST_RE,
  TOKEN_VERSION: "cf1",
  DESTINATION: "meeting_assistant",
});
