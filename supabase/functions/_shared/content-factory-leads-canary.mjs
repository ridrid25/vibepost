import {
  buildMeetingDeepLink,
  digestCf1Token,
  generateCf1Token,
  readBoundedStrictJson,
  TelegramAttributionError,
} from "./telegram-lead-attribution.mjs";

const BOT_TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,80}$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HMAC_KEY_RE = /^[A-Za-z0-9_-]{43}$/u;
const START_RE =
  /^\/start(?:@ContentFactoryLeads_bot)? (cf1_[A-Za-z0-9_-]{43})$/u;
const CALLBACK_DATA = "post13c_confirm_v1";
const BOT_USERNAME = "ContentFactoryLeads_bot";
const DESTINATION = "content_factory_leads_canary";
const POLICY_VERSION = "POST13C_ISOLATED_CANARY_V1";

export function createCanaryToken() {
  return generateCf1Token();
}

export function digestCanaryToken(token) {
  return digestCf1Token(token);
}

export function buildCanaryDeepLink(token) {
  return buildMeetingDeepLink(BOT_USERNAME, token);
}

export async function readActivationBody(req) {
  const body = await readBoundedStrictJson(req, 256, ["bot_token"]);
  if (
    typeof body.bot_token !== "string" || !BOT_TOKEN_RE.test(body.bot_token)
  ) {
    throw new TelegramAttributionError("BOT_TOKEN_INVALID");
  }
  return Object.freeze({ botToken: body.bot_token });
}

export async function readCtaActivationBody(req) {
  const body = await readBoundedStrictJson(
    req,
    512,
    ["creative_identity_map_id", "telegram_post_id"],
  );
  if (
    !UUID_RE.test(body.creative_identity_map_id) ||
    !UUID_RE.test(body.telegram_post_id)
  ) {
    throw new TelegramAttributionError("CANARY_IDENTITY_INVALID");
  }
  return Object.freeze({
    creativeIdentityMapId: body.creative_identity_map_id,
    telegramPostId: body.telegram_post_id,
  });
}

export async function digestText(value) {
  const data = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return toHex(digest);
}

export async function deriveCanaryIdentity(keyText, namespace, value) {
  if (
    !HMAC_KEY_RE.test(keyText) || !["subject", "update"].includes(namespace) ||
    !(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  ) {
    throw new TelegramAttributionError("CANARY_IDENTITY_INPUT_INVALID");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${namespace}:${value}`),
    ),
  );
  return `${namespace}_${toHex(signature)}`;
}

export async function readTelegramUpdate(req) {
  const body = await readBoundedStrictJson(
    req,
    8192,
    ["update_id", "message", "callback_query"],
    ["update_id"],
  );
  if (!(Number.isSafeInteger(body.update_id) && body.update_id >= 0)) {
    throw new TelegramAttributionError("TELEGRAM_UPDATE_INVALID");
  }
  const hasMessage = "message" in body;
  const hasCallback = "callback_query" in body;
  if (hasMessage === hasCallback) {
    throw new TelegramAttributionError("TELEGRAM_UPDATE_INVALID");
  }
  if (hasMessage) return normalizeStartUpdate(body.update_id, body.message);
  return normalizeCallbackUpdate(body.update_id, body.callback_query);
}

export function webhookStartResponse(chatId) {
  return Object.freeze({
    method: "sendMessage",
    chat_id: chatId,
    text: "Источник зафиксирован. Нажмите кнопку, чтобы создать тестовый лид.",
    reply_markup: {
      inline_keyboard: [[{
        text: "✅ Создать тестовый лид",
        callback_data: CALLBACK_DATA,
      }]],
    },
  });
}

export function webhookCallbackResponse(callbackQueryId) {
  return Object.freeze({
    method: "answerCallbackQuery",
    callback_query_id: callbackQueryId,
    text: "Тестовый лид зафиксирован.",
  });
}

export function webhookNoopResponse() {
  return Object.freeze({ ok: true });
}

export function constantTimeHexEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length, 1);
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index % Math.max(a.length, 1)] ?? 0) ^
      (b[index % Math.max(b.length, 1)] ?? 0);
  }
  return diff === 0;
}

export function assertCanaryRuntime(value, requiredState) {
  const allowed = [
    "singleton_key",
    "bot_username",
    "state",
    "bot_credential_digest",
    "webhook_secret_digest",
    "webhook_config_hash",
    "activation_lease_id",
    "activation_lease_expires_at",
  ];
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    value.singleton_key !== "POST13C" || value.bot_username !== BOT_USERNAME ||
    value.state !== requiredState ||
    !DIGEST_RE.test(value.bot_credential_digest)
  ) {
    throw new TelegramAttributionError("CANARY_RUNTIME_INVALID");
  }
  if (
    requiredState === "ACTIVE" && !DIGEST_RE.test(value.webhook_secret_digest)
  ) {
    throw new TelegramAttributionError("CANARY_RUNTIME_INVALID");
  }
  return value;
}

export function normalizeTelegramApiIdentity(value) {
  if (
    !value || typeof value !== "object" || value.ok !== true ||
    !value.result || typeof value.result !== "object" ||
    value.result.is_bot !== true || value.result.username !== BOT_USERNAME
  ) {
    throw new TelegramAttributionError("CANARY_BOT_IDENTITY_MISMATCH");
  }
  return Object.freeze({ username: BOT_USERNAME, valid: true });
}

export function normalizeWebhookInfo(value, expectedUrl) {
  if (
    !value || typeof value !== "object" || value.ok !== true ||
    !value.result || typeof value.result !== "object" ||
    value.result.url !== expectedUrl || value.result.max_connections !== 1 ||
    !Array.isArray(value.result.allowed_updates) ||
    value.result.allowed_updates.length !== 2 ||
    value.result.allowed_updates[0] !== "message" ||
    value.result.allowed_updates[1] !== "callback_query"
  ) {
    throw new TelegramAttributionError("CANARY_WEBHOOK_VERIFICATION_FAILED");
  }
  return Object.freeze({
    url: expectedUrl,
    maxConnections: 1,
    allowedUpdates: Object.freeze(["message", "callback_query"]),
  });
}

export function normalizeEmptyWebhookInfo(value) {
  if (
    !value || typeof value !== "object" || value.ok !== true ||
    !value.result || typeof value.result !== "object" || value.result.url !== ""
  ) {
    throw new TelegramAttributionError("CANARY_WEBHOOK_NOT_EMPTY");
  }
  return Object.freeze({ empty: true });
}

export async function boundedTelegramApi(
  fetchImpl,
  botToken,
  method,
  body = {},
  options = {},
) {
  if (
    typeof fetchImpl !== "function" || !BOT_TOKEN_RE.test(botToken) ||
    !/^[A-Za-z][A-Za-z0-9]{1,63}$/u.test(method)
  ) {
    throw new TelegramAttributionError("TELEGRAM_API_INPUT_INVALID");
  }
  const response = await fetchImpl(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(10_000),
    },
  );
  const declaredLength = Number(
    response.headers?.get?.("content-length") ?? "0",
  );
  const acceptedStatuses = Array.isArray(options.acceptedStatuses)
    ? options.acceptedStatuses
    : [];
  if (
    (!response.ok && !acceptedStatuses.includes(response.status)) ||
    (Number.isFinite(declaredLength) && declaredLength > 65_536)
  ) {
    throw new TelegramAttributionError("TELEGRAM_API_RESPONSE_INVALID");
  }
  if (!response.body) {
    throw new TelegramAttributionError("TELEGRAM_API_RESPONSE_INVALID");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    total += chunk.byteLength;
    if (total > 65_536) {
      await reader.cancel().catch(() => undefined);
      throw new TelegramAttributionError("TELEGRAM_API_RESPONSE_INVALID");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.length === 0) {
    throw new TelegramAttributionError("TELEGRAM_API_RESPONSE_INVALID");
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TelegramAttributionError("TELEGRAM_API_RESPONSE_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TelegramAttributionError("TELEGRAM_API_RESPONSE_INVALID");
  }
  return value;
}

export function isVerifiedMarkupRemoval(
  value,
  expectedChatId,
  expectedMessageId,
) {
  if (
    value?.ok === true && value?.result &&
    value.result.message_id === expectedMessageId &&
    String(value.result.chat?.id) === String(expectedChatId) &&
    (value.result.reply_markup === undefined ||
      (Object.keys(value.result.reply_markup).length === 1 &&
        Array.isArray(value.result.reply_markup.inline_keyboard) &&
        value.result.reply_markup.inline_keyboard.length === 0))
  ) return true;
  return value?.ok === false && value?.error_code === 400 &&
    typeof value?.description === "string" &&
    value.description.toLowerCase().includes("message is not modified");
}

export function normalizeCanaryEvidencePage(value) {
  if (!Array.isArray(value) || value.length > 10) {
    throw new TelegramAttributionError("CANARY_EVIDENCE_INVALID");
  }
  const allowed = [
    "creative_id",
    "publication_id",
    "token_id",
    "token_digest",
    "event_id",
    "event_type",
    "subject_id",
    "occurred_at",
    "attribution_quality",
    "provenance",
  ];
  return Object.freeze(value.map((row) => {
    if (
      !row || typeof row !== "object" || Array.isArray(row) ||
      Object.keys(row).some((key) => !allowed.includes(key)) ||
      allowed.some((key) => !(key in row)) ||
      !/^creative-[0-9a-f]{64}$/u.test(row.creative_id) ||
      !UUID_RE.test(row.publication_id) || !UUID_RE.test(row.token_id) ||
      !DIGEST_RE.test(row.token_digest) || !UUID_RE.test(row.event_id) ||
      !["BOT_START", "CANARY_LEAD_CREATED"].includes(row.event_type) ||
      !/^subject_[0-9a-f]{64}$/u.test(row.subject_id) ||
      !Number.isFinite(Date.parse(row.occurred_at)) ||
      !["DIRECT_LINK", "DETERMINISTIC_CANARY"].includes(
        row.attribution_quality,
      ) ||
      row.provenance?.policy_version !== POLICY_VERSION ||
      row.provenance?.source_system !== "content_factory_leads_canary" ||
      row.provenance?.test_only !== true
    ) {
      throw new TelegramAttributionError("CANARY_EVIDENCE_INVALID");
    }
    return Object.freeze({ ...row });
  }));
}

function normalizeStartUpdate(updateId, message) {
  exactAllowed(message, [
    "message_id",
    "from",
    "chat",
    "date",
    "text",
    "entities",
  ]);
  if (
    !Number.isSafeInteger(message.message_id) ||
    !Number.isSafeInteger(message.date) ||
    typeof message.text !== "string"
  ) {
    throw new TelegramAttributionError("TELEGRAM_START_INVALID");
  }
  const from = normalizeActor(message.from);
  const chat = normalizePrivateChat(message.chat);
  if (
    from.id !== chat.id || !Array.isArray(message.entities) ||
    message.entities.length !== 1
  ) {
    throw new TelegramAttributionError("TELEGRAM_START_INVALID");
  }
  exactAllowed(message.entities[0], ["offset", "length", "type"]);
  if (
    message.entities[0].offset !== 0 || message.entities[0].length < 6 ||
    message.entities[0].type !== "bot_command"
  ) {
    throw new TelegramAttributionError("TELEGRAM_START_INVALID");
  }
  const match = START_RE.exec(message.text);
  if (!match) throw new TelegramAttributionError("TELEGRAM_START_INVALID");
  return Object.freeze({
    kind: "BOT_START",
    updateId,
    actorId: from.id,
    transientChatId: chat.id,
    token: match[1],
  });
}

function normalizeCallbackUpdate(updateId, query) {
  exactAllowed(query, ["id", "from", "message", "chat_instance", "data"]);
  if (
    typeof query.id !== "string" || query.id.length < 1 ||
    query.id.length > 256 ||
    typeof query.chat_instance !== "string" || query.chat_instance.length < 1 ||
    query.data !== CALLBACK_DATA
  ) {
    throw new TelegramAttributionError("TELEGRAM_CALLBACK_INVALID");
  }
  const from = normalizeActor(query.from);
  exactAllowed(query.message, [
    "message_id",
    "from",
    "chat",
    "date",
    "text",
    "reply_markup",
  ]);
  const chat = normalizePrivateChat(query.message.chat);
  if (from.id !== chat.id) {
    throw new TelegramAttributionError("TELEGRAM_CALLBACK_INVALID");
  }
  return Object.freeze({
    kind: "CANARY_LEAD_CREATED",
    updateId,
    actorId: from.id,
    callbackQueryId: query.id,
  });
}

function normalizeActor(value) {
  exactAllowed(value, [
    "id",
    "is_bot",
    "first_name",
    "last_name",
    "username",
    "language_code",
    "is_premium",
    "added_to_attachment_menu",
  ]);
  if (
    !Number.isSafeInteger(value.id) || value.id <= 0 || value.is_bot !== false
  ) {
    throw new TelegramAttributionError("TELEGRAM_ACTOR_INVALID");
  }
  return Object.freeze({ id: value.id });
}

function normalizePrivateChat(value) {
  exactAllowed(value, ["id", "type", "first_name", "last_name", "username"]);
  if (
    !Number.isSafeInteger(value.id) || value.id <= 0 || value.type !== "private"
  ) {
    throw new TelegramAttributionError("TELEGRAM_CHAT_INVALID");
  }
  return Object.freeze({ id: value.id });
}

function exactAllowed(value, allowed) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new TelegramAttributionError("TELEGRAM_SCHEMA_DRIFT");
  }
}

function toHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function fromBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export const CONTENT_FACTORY_LEADS_CANARY = Object.freeze({
  BOT_TOKEN_RE,
  DIGEST_RE,
  UUID_RE,
  HMAC_KEY_RE,
  START_RE,
  CALLBACK_DATA,
  BOT_USERNAME,
  DESTINATION,
  POLICY_VERSION,
});
