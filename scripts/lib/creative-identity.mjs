import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

const MAX_ARTIFACT_BYTES = 1_048_576;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATIVE = /^creative-[0-9a-f]{64}$/;
const HANDOFF = /^handoff-[0-9a-f]{64}$/;
const ASSET = /^sha256:[0-9a-f]{64}$/;
const DRAFT = /^vibepost:incoming_videos:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

export class CreativeIdentityError extends Error {
  constructor(code) {
    super(code);
    this.name = "CreativeIdentityError";
    this.code = code;
  }
}

function fail(code) {
  throw new CreativeIdentityError(code);
}

// JSON.parse discards duplicate keys. This bounded parser rejects them before
// any identity material is trusted and accepts the same scalar subset as POST-01.
export function parseStrictJson(text) {
  if (typeof text !== "string" || text.length === 0) fail("CREATIVE_IDENTITY_JSON_INVALID");
  let offset = 0;
  const ws = () => {
    while ([" ", "\t", "\r", "\n"].includes(text[offset] ?? "")) offset += 1;
  };
  const stringValue = () => {
    if (text[offset] !== '"') fail("CREATIVE_IDENTITY_JSON_INVALID");
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') {
        try { return JSON.parse(text.slice(start, offset)); } catch { fail("CREATIVE_IDENTITY_JSON_INVALID"); }
      }
      if (char === "\\") {
        const escaped = text[offset++];
        if (!'"\\/bfnrtu'.includes(escaped ?? "")) fail("CREATIVE_IDENTITY_JSON_INVALID");
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset, offset + 4))) fail("CREATIVE_IDENTITY_JSON_INVALID");
          offset += 4;
        }
      } else if (char.charCodeAt(0) < 32) {
        fail("CREATIVE_IDENTITY_JSON_INVALID");
      }
    }
    fail("CREATIVE_IDENTITY_JSON_INVALID");
  };
  const value = () => {
    ws();
    if (text[offset] === '{') {
      offset += 1;
      const object = Object.create(null);
      const keys = new Set();
      ws();
      if (text[offset] === '}') { offset += 1; return object; }
      while (true) {
        ws();
        const key = stringValue();
        if (keys.has(key)) fail("CREATIVE_IDENTITY_DUPLICATE_FIELD");
        keys.add(key);
        ws();
        if (text[offset++] !== ':') fail("CREATIVE_IDENTITY_JSON_INVALID");
        object[key] = value();
        ws();
        const separator = text[offset++];
        if (separator === '}') return object;
        if (separator !== ',') fail("CREATIVE_IDENTITY_JSON_INVALID");
      }
    }
    if (text[offset] === '[') {
      offset += 1;
      const array = [];
      ws();
      if (text[offset] === ']') { offset += 1; return array; }
      while (true) {
        array.push(value());
        ws();
        const separator = text[offset++];
        if (separator === ']') return array;
        if (separator !== ',') fail("CREATIVE_IDENTITY_JSON_INVALID");
      }
    }
    if (text[offset] === '"') return stringValue();
    for (const [literal, result] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(text.slice(offset));
    if (!match) fail("CREATIVE_IDENTITY_JSON_INVALID");
    offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number)) fail("CREATIVE_IDENTITY_JSON_INVALID");
    return number;
  };
  try {
    const parsed = value();
    ws();
    if (offset !== text.length) fail("CREATIVE_IDENTITY_JSON_INVALID");
    return parsed;
  } catch (error) {
    if (error instanceof CreativeIdentityError) throw error;
    fail("CREATIVE_IDENTITY_JSON_INVALID");
  }
}

function exactObject(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CREATIVE_IDENTITY_SCHEMA_INVALID");
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || actual.some((key) => !allowed.has(key))) {
    fail("CREATIVE_IDENTITY_SCHEMA_INVALID");
  }
  return value;
}

function safeText(value, { empty = false, max = 100_000 } = {}) {
  if (typeof value !== "string" || !value.isWellFormed() || value.length > max || (!empty && value.length === 0)) fail("CREATIVE_IDENTITY_SCHEMA_INVALID");
  if ([...value].some((char) => char.codePointAt(0) < 32 && char !== "\n" && char !== "\t")) fail("CREATIVE_IDENTITY_SCHEMA_INVALID");
  return value;
}

function timestamp(value) {
  if (typeof value !== "string" || value.length > 64) {
    fail("CREATIVE_IDENTITY_SCHEMA_INVALID");
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,]\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail("CREATIVE_IDENTITY_SCHEMA_INVALID");
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = match[7];
  const zoneHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > monthDays[month] ||
      hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) {
    fail("CREATIVE_IDENTITY_SCHEMA_INVALID");
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bodyHash(script) {
  const normalized = script.replace(/\r\n?/g, "\n").normalize("NFC")
    .replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, "");
  return sha256(canonicalJson({ body: normalized }));
}

export function validatePost01Artifacts(handoff, result) {
  exactObject(handoff, [
    "handoff_version", "handoff_id", "creative_id", "source_task_id",
    "source_revision_id", "source_hash", "created_at", "script", "video_input", "lineage",
  ]);
  if (handoff.handoff_version !== 1 || !ID.test(handoff.source_task_id) ||
      !ID.test(handoff.source_revision_id) || !HASH.test(handoff.source_hash) ||
      !CREATIVE.test(handoff.creative_id) || !HANDOFF.test(handoff.handoff_id)) {
    fail("CREATIVE_IDENTITY_HANDOFF_INVALID");
  }
  timestamp(handoff.created_at);
  safeText(handoff.script);
  if (bodyHash(handoff.script) !== handoff.source_hash) fail("CREATIVE_IDENTITY_SOURCE_HASH_MISMATCH");

  const video = exactObject(handoff.video_input,
    ["slug", "animal", "topic", "text", "hook", "prompt", "approved", "createdAt"],
    ["approvedAt"]);
  if (!SLUG.test(video.slug) || video.approved !== true) fail("CREATIVE_IDENTITY_VIDEO_INPUT_INVALID");
  for (const key of ["animal", "topic", "hook", "prompt"]) safeText(video[key], { empty: true });
  safeText(video.text);
  timestamp(video.createdAt);
  if ("approvedAt" in video) timestamp(video.approvedAt);
  if (video.text !== handoff.script) fail("CREATIVE_IDENTITY_VIDEO_INPUT_INVALID");

  const lineage = exactObject(handoff.lineage, [
    "source_input_revision_id", "source_input_hash", "source_package_id", "source_channel",
  ]);
  if (!ID.test(lineage.source_input_revision_id) || !HASH.test(lineage.source_input_hash) ||
      !ID.test(lineage.source_package_id) || !ID.test(lineage.source_channel)) {
    fail("CREATIVE_IDENTITY_HANDOFF_INVALID");
  }

  const expectedCreative = `creative-${sha256(canonicalJson({
    domain: "content-factory:creative:v1",
    source_hash: handoff.source_hash,
    source_revision_id: handoff.source_revision_id,
    source_task_id: handoff.source_task_id,
  }))}`;
  const expectedHandoff = `handoff-${sha256(canonicalJson({
    creative_id: expectedCreative,
    domain: "content-factory:handoff:v1",
    handoff_version: 1,
    video_input_hash: sha256(canonicalJson(video)),
  }))}`;
  if (handoff.creative_id !== expectedCreative) fail("CREATIVE_IDENTITY_CREATIVE_ID_MISMATCH");
  if (handoff.handoff_id !== expectedHandoff) fail("CREATIVE_IDENTITY_HANDOFF_ID_MISMATCH");

  exactObject(result, [
    "result_version", "status", "handoff_id", "creative_id", "existing_video_input_id",
    "final_asset_ref", "completed_at", "source_task_id", "source_revision_id", "source_hash",
    "source_input_revision_id", "source_input_hash", "source_package_id", "source_channel",
  ], ["vibepost_draft_ref"]);
  if (result.result_version !== 1 || result.status !== "COMPLETED" ||
      !HANDOFF.test(result.handoff_id) || !CREATIVE.test(result.creative_id) ||
      !SLUG.test(result.existing_video_input_id) || !ASSET.test(result.final_asset_ref)) {
    fail("CREATIVE_IDENTITY_RESULT_INVALID");
  }
  timestamp(result.completed_at);
  if ("vibepost_draft_ref" in result && !DRAFT.test(result.vibepost_draft_ref)) fail("CREATIVE_IDENTITY_RESULT_INVALID");

  const pairs = [
    [result.handoff_id, handoff.handoff_id], [result.creative_id, handoff.creative_id],
    [result.existing_video_input_id, video.slug], [result.source_task_id, handoff.source_task_id],
    [result.source_revision_id, handoff.source_revision_id], [result.source_hash, handoff.source_hash],
    [result.source_input_revision_id, lineage.source_input_revision_id],
    [result.source_input_hash, lineage.source_input_hash],
    [result.source_package_id, lineage.source_package_id], [result.source_channel, lineage.source_channel],
  ];
  if (pairs.some(([left, right]) => left !== right)) fail("CREATIVE_IDENTITY_RESULT_MISMATCH");
  return { handoff, result };
}

export function buildMappingArguments({
  handoff, result, userId, platform, videoIdeaId = null, incomingVideoId = null,
  tiktokVideoRowId = null, youtubeShortRowId = null,
}) {
  validatePost01Artifacts(handoff, result);
  if (!UUID.test(userId) || !["tiktok", "youtube_shorts"].includes(platform)) fail("CREATIVE_IDENTITY_ARGUMENT_INVALID");
  for (const value of [videoIdeaId, incomingVideoId, tiktokVideoRowId, youtubeShortRowId]) {
    if (value !== null && !UUID.test(value)) fail("CREATIVE_IDENTITY_ARGUMENT_INVALID");
  }
  const match = result.vibepost_draft_ref?.match(DRAFT);
  const receiptIncoming = match?.[1] ?? null;
  if (receiptIncoming !== null && !UUID.test(receiptIncoming)) fail("CREATIVE_IDENTITY_INCOMING_REF_INVALID");
  if (incomingVideoId !== null && receiptIncoming !== null && incomingVideoId !== receiptIncoming) fail("CREATIVE_IDENTITY_RESULT_MISMATCH");
  if (platform === "tiktok" && youtubeShortRowId !== null) fail("CREATIVE_IDENTITY_ARGUMENT_INVALID");
  if (platform === "youtube_shorts" && tiktokVideoRowId !== null) fail("CREATIVE_IDENTITY_ARGUMENT_INVALID");
  return {
    p_user_id: userId,
    p_creative_id: handoff.creative_id,
    p_source_task_id: handoff.source_task_id,
    p_source_revision_id: handoff.source_revision_id,
    p_source_hash: handoff.source_hash,
    p_handoff_id: handoff.handoff_id,
    p_platform: platform,
    p_video_idea_id: videoIdeaId,
    p_incoming_video_id: incomingVideoId ?? receiptIncoming,
    p_tiktok_video_row_id: tiktokVideoRowId,
    p_youtube_short_row_id: youtubeShortRowId,
  };
}

export function readStrictArtifact(path) {
  let stat;
  try { stat = lstatSync(path); } catch { fail("CREATIVE_IDENTITY_FILE_INVALID"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) fail("CREATIVE_IDENTITY_FILE_INVALID");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)); }
  catch { fail("CREATIVE_IDENTITY_FILE_INVALID"); }
  return parseStrictJson(text);
}
