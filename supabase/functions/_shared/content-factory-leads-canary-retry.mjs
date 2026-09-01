import {
  buildMeetingDeepLink,
  digestCf1Token,
  generateCf1Token,
  readBoundedStrictJson,
  TelegramAttributionError,
} from "./telegram-lead-attribution.mjs";
import {
  boundedTelegramApi,
  constantTimeHexEqual,
  deriveCanaryIdentity,
  digestText,
  isVerifiedMarkupRemoval,
} from "./content-factory-leads-canary.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const START_RE =
  /^\/start(?:@ContentFactoryLeads_bot)? (cf1_[A-Za-z0-9_-]{43})$/u;
const CALLBACK_RE = /^post13d_([0-9a-f]{32})$/u;
const BOT_USERNAME = "ContentFactoryLeads_bot";
const STAGE_KEY = "POST13D";
const DESTINATION = "content_factory_leads_canary";
const POLICY_VERSION = "POST13D_ISOLATED_CANARY_RETRY_V1";
const PUBLICATION_TEXT =
  "🧪 POST-13D — изолированная тестовая публикация. Кнопка создаёт только тестовый лид; Booking, Calendar, payment и revenue не создаются.";
const BOT_PROMPT_TEXT =
  "Источник зафиксирован. Нажмите кнопку, чтобы создать тестовый лид.";

export function createRetryToken() {
  return generateCf1Token();
}

export function digestRetryToken(token) {
  return digestCf1Token(token);
}

export function buildRetryDeepLink(token) {
  return buildMeetingDeepLink(BOT_USERNAME, token);
}

export function buildRetryCallbackData(runId) {
  if (!UUID_RE.test(runId)) {
    throw new TelegramAttributionError("POST13D_RUN_ID_INVALID");
  }
  return `post13d_${runId.replaceAll("-", "").toLowerCase()}`;
}

export function parseRetryCallbackData(value) {
  const match = CALLBACK_RE.exec(value ?? "");
  if (!match) throw new TelegramAttributionError("POST13D_CALLBACK_INVALID");
  const compact = match[1];
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export async function readRetryControlBody(req) {
  const body = await readBoundedStrictJson(req, 128, ["action"]);
  if (
    !["prepare", "negative_check", "complete", "rollback"].includes(
      body.action,
    )
  ) {
    throw new TelegramAttributionError("POST13D_ACTION_INVALID");
  }
  return Object.freeze({ action: body.action });
}

export async function readRetryTelegramUpdate(req, expectedRunId) {
  if (!UUID_RE.test(expectedRunId)) {
    throw new TelegramAttributionError("POST13D_RUN_ID_INVALID");
  }
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
  if (hasMessage) return normalizeStart(body.update_id, body.message);
  return normalizeCallback(body.update_id, body.callback_query, expectedRunId);
}

export function retryPublicationMarkup(rawToken) {
  return Object.freeze({
    inline_keyboard: [[Object.freeze({
      text: "🧪 Открыть тестовый лид",
      url: buildRetryDeepLink(rawToken),
    })]],
  });
}

export function retryStartResponse(chatId, runId) {
  return Object.freeze({
    method: "sendMessage",
    chat_id: chatId,
    text: BOT_PROMPT_TEXT,
    reply_markup: {
      inline_keyboard: [[{
        text: "✅ Создать тестовый лид",
        callback_data: buildRetryCallbackData(runId),
      }]],
    },
  });
}

export function retryCallbackResponse(callbackQueryId, duplicate = false) {
  return Object.freeze({
    method: "answerCallbackQuery",
    callback_query_id: callbackQueryId,
    text: duplicate ? "Тестовый лид уже зафиксирован." : "Тестовый лид зафиксирован.",
  });
}

export function retryNoopResponse() {
  return Object.freeze({ ok: true });
}

export function normalizeRetryRuntime(value, requiredState = "ACTIVE") {
  const allowed = [
    "canary_run_id",
    "stage_key",
    "user_id",
    "state",
    "bot_username",
    "webhook_secret_digest",
    "webhook_config_hash",
  ];
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !UUID_RE.test(value.canary_run_id) || value.stage_key !== STAGE_KEY ||
    value.bot_username !== BOT_USERNAME || value.state !== requiredState ||
    !DIGEST_RE.test(value.webhook_secret_digest) ||
    !DIGEST_RE.test(value.webhook_config_hash)
  ) {
    throw new TelegramAttributionError("POST13D_RUNTIME_INVALID");
  }
  return Object.freeze({ ...value });
}

export function normalizeRetrySendResult(value, expectedChatId, expectedText) {
  if (
    !value || typeof value !== "object" || value.ok !== true ||
    !value.result || typeof value.result !== "object" ||
    !Number.isSafeInteger(value.result.message_id) ||
    value.result.message_id <= 0 ||
    String(value.result.chat?.id) !== String(expectedChatId) ||
    value.result.text !== expectedText
  ) {
    throw new TelegramAttributionError("POST13D_SEND_RESPONSE_INVALID");
  }
  return Object.freeze({
    telegramChatId: String(expectedChatId),
    messageId: value.result.message_id,
  });
}

export function normalizeRetryEvidence(value) {
  if (!Array.isArray(value) || value.length > 2) {
    throw new TelegramAttributionError("POST13D_EVIDENCE_INVALID");
  }
  const allowed = [
    "canary_run_id",
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
      !UUID_RE.test(row.canary_run_id) ||
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
      row.provenance?.source_system !== "content_factory_leads_canary_retry" ||
      row.provenance?.test_only !== true
    ) {
      throw new TelegramAttributionError("POST13D_EVIDENCE_INVALID");
    }
    return Object.freeze({ ...row });
  }));
}

function normalizeStart(updateId, message) {
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
    !Number.isSafeInteger(message.date) || typeof message.text !== "string"
  ) {
    throw new TelegramAttributionError("TELEGRAM_START_INVALID");
  }
  const actor = normalizeHuman(message.from);
  const chat = normalizePrivateChat(message.chat);
  if (
    actor.id !== chat.id || !Array.isArray(message.entities) ||
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
    actorId: actor.id,
    transientChatId: chat.id,
    token: match[1],
  });
}

function normalizeCallback(updateId, query, expectedRunId) {
  exactAllowed(query, ["id", "from", "message", "chat_instance", "data"]);
  if (
    typeof query.id !== "string" || query.id.length < 1 ||
    query.id.length > 256 || typeof query.chat_instance !== "string" ||
    query.chat_instance.length < 1 ||
    parseRetryCallbackData(query.data) !== expectedRunId.toLowerCase()
  ) {
    throw new TelegramAttributionError("POST13D_CALLBACK_INVALID");
  }
  const actor = normalizeHuman(query.from);
  exactAllowed(query.message, [
    "message_id",
    "from",
    "chat",
    "date",
    "text",
    "reply_markup",
  ]);
  if (
    !Number.isSafeInteger(query.message.message_id) ||
    !Number.isSafeInteger(query.message.date) ||
    query.message.text !== BOT_PROMPT_TEXT
  ) {
    throw new TelegramAttributionError("POST13D_CALLBACK_INVALID");
  }
  normalizeCanaryBot(query.message.from);
  const chat = normalizePrivateChat(query.message.chat);
  if (actor.id !== chat.id) {
    throw new TelegramAttributionError("POST13D_CALLBACK_INVALID");
  }
  const keyboard = query.message.reply_markup?.inline_keyboard;
  if (
    !Array.isArray(keyboard) || keyboard.length !== 1 ||
    !Array.isArray(keyboard[0]) || keyboard[0].length !== 1
  ) {
    throw new TelegramAttributionError("POST13D_CALLBACK_INVALID");
  }
  exactAllowed(keyboard[0][0], ["text", "callback_data"]);
  if (
    keyboard[0][0].text !== "✅ Создать тестовый лид" ||
    keyboard[0][0].callback_data !== buildRetryCallbackData(expectedRunId)
  ) {
    throw new TelegramAttributionError("POST13D_CALLBACK_INVALID");
  }
  return Object.freeze({
    kind: "CANARY_LEAD_CREATED",
    updateId,
    actorId: actor.id,
    callbackQueryId: query.id,
    runId: expectedRunId,
  });
}

function normalizeHuman(value) {
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

function normalizeCanaryBot(value) {
  exactAllowed(value, ["id", "is_bot", "first_name", "username"]);
  if (
    !Number.isSafeInteger(value.id) || value.id <= 0 ||
    value.is_bot !== true || value.username !== BOT_USERNAME
  ) {
    throw new TelegramAttributionError("POST13D_BOT_MESSAGE_INVALID");
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

export {
  boundedTelegramApi,
  constantTimeHexEqual,
  deriveCanaryIdentity,
  digestText,
  isVerifiedMarkupRemoval,
};

export const CONTENT_FACTORY_LEADS_CANARY_RETRY = Object.freeze({
  UUID_RE,
  DIGEST_RE,
  START_RE,
  CALLBACK_RE,
  BOT_USERNAME,
  STAGE_KEY,
  DESTINATION,
  POLICY_VERSION,
  PUBLICATION_TEXT,
  BOT_PROMPT_TEXT,
});
