# Аудит автоматической публикации YouTube Shorts

Дата аудита: 26.08.2026.

Scope: только чтение production-кода, schema/migrations и owner-facing
контрактов VibePost. OAuth credentials, Google Cloud, БД, функции и аккаунты не
изменялись; видео не загружалось и не публиковалось.

## Current channel architecture

### Что сейчас называется channel

В backend нет generic-сущности `channel` или `destination`. Блок «Каналы»
работает с таблицей `public.chats`, а каждый `chat` — это Telegram-чат,
Telegram-группа или Telegram-канал, доступный конкретному Telegram-боту:

- `chats.bot_id` обязателен и ссылается на `bots`;
- `chats.telegram_chat_id` обязателен;
- `type` допускает только `private`, `channel`, `group`;
- уникальность задана как `(bot_id, telegram_chat_id)`.

Источник: `supabase/migrations/20260719000002_core_schema.sql:15-26,33-44`.

UI-контракт подтверждает то же: раздел настроек называется «Telegram Боты», а
внутри бота владелец вводит Chat ID и вызывает `resolve-chat`; generic provider
selector в описании UI отсутствует. Источник:
`docs/03_LOVABLE.md:72-83`.

`resolve-chat`:

1. требует `bot_id` и `telegram_chat_id`;
2. достаёт Telegram bot token из Vault;
3. вызывает Telegram `getChat`;
4. принимает только Telegram-типы;
5. записывает результат в `chats`.

Источник: `supabase/functions/resolve-chat/index.ts:1-4,35-59,62-104`.

Итог: текущая entity **Telegram-specific**, а не generic publication
destination. Внешний вид блока «Каналы» не меняет его backend-семантику.

### Где хранится channel config

- Telegram bot identity/config: `public.bots` (`name`, `username`,
  `token_secret_id`, `is_active`) —
  `20260719000002_core_schema.sql:15-26`.
- Сам destination: `public.chats` (`bot_id`, `telegram_chat_id`, `title`,
  Telegram `type`) — тот же файл, строки `33-44`.
- Bot token: Supabase Vault; `bots` хранит только secret UUID —
  `20260719000007_vault_bot_tokens.sql:1-42`.
- Пост привязан одновременно к обязательным `bot_id` и `chat_id` —
  `20260719000002_core_schema.sql:67-91`.
- DB guard дополнительно требует, чтобы bot/chat принадлежали owner и chat был
  привязан именно к этому bot —
  `20260719000009_templates_and_post_guards.sql:8-44`.

Это не позволяет вставить YouTube channel в `chats` как обычную строку: для
него нет Telegram bot, Telegram Chat ID и допустимого provider type.

### Есть ли publish/send abstraction

Есть один общий модуль только для Telegram: `sendPost(token, chatId, post)`.
Он выбирает `sendMessage`, `sendPhoto`, `sendVideo`/`sendAnimation` или
`sendPoll`, после чего всегда вызывает
`https://api.telegram.org/bot...`. Источник:
`supabase/functions/process-scheduler/send-post.ts:1-18,28-79,82-107`.

Provider-neutral interface/registry/dispatcher (`provider.publish(...)`) не
найден. Название `sendPost` общее, но его аргументы, payload, response ID,
ошибки и rate-limit semantics Telegram-specific.

### Можно ли считать `fetch-channels` provider

Нет. `fetch-channels` читает публичные страницы `t.me/s/...` каналов-доноров и
складывает контент в `news_items`; функция прямо указывает, что ничего не
публикует. Источник: `supabase/functions/fetch-channels/index.ts:1-8,60-114`.

## Existing publishing providers

### Telegram — единственный publishing provider

`process-scheduler`:

- забирает только `posts` и `active_chain_steps`;
- каждый queue item обязан иметь `bot_id` и `chat_id`;
- загружает `bots.token_secret_id` и `chats.telegram_chat_id`;
- вызывает Telegram-only `sendPost`;
- сохраняет `tg_message_id` и Telegram analytics;
- применяет Telegram per-chat limit.

Источник: `supabase/functions/process-scheduler/index.ts:1-17,28-41,61-69,
102-130,135-181,183-223`.

Cron раз в минуту и атомарный `claim_due_posts` сами по себе полезны, но
текущий job payload и worker не provider-neutral. Источник:
`supabase/migrations/20260719000008_scheduler.sql:1-28,31-75`.

Поддержка `format='video'` означает только Telegram `sendVideo`: в `posts`
добавлен `video_url`, а sender передаёт этот публичный URL Telegram. Источник:
`supabase/migrations/20260721000017_video_support.sql:1-19` и
`process-scheduler/send-post.ts:55-65`.

### TikTok OAuth — не publishing provider

В проекте есть полноценный, но TikTok-specific OAuth/refresh pattern:

- `tiktok_accounts` и `tiktok_oauth_states` —
  `20260815000001_tiktok_oauth_foundation.sql:7-80`;
- access/refresh bundle в Vault — тот же файл, строки `164-228`;
- OAuth start с hashed state —
  `tiktok-oauth-start/index.ts:25-84`;
- callback, code exchange, scope check и Vault save —
  `tiktok-oauth-callback/index.ts:86-128,165-208`;
- refresh-token rotation — `_shared/tiktok.ts:415-433` и
  `tiktok-sync/index.ts:213-242`.

Но scopes равны только `user.info.basic` и `video.list`, а функции читают
profile/list/query для analytics. Upload/publish scope и TikTok publish path
отсутствуют. Источник: `_shared/tiktok.ts:1-8` и
`tiktok-oauth-callback/index.ts:228-252`.

Следовательно, OAuth infrastructure существует как **проверенный шаблон**, но
не как generic OAuth framework, куда достаточно вписать Google endpoints.

## Missing YouTube pieces

### 1. Google user OAuth provider

Отсутствуют:

- Google OAuth start endpoint;
- одноразовый Google OAuth state и callback;
- authorization-code exchange для owner;
- owner-to-YouTube-account/channel mapping;
- secure per-owner access/refresh token bundle;
- token refresh, revocation/disconnect и `reauth_required` state;
- scopes YouTube upload/channel read;
- consent/error UI.

Repository-wide поиск Google/YouTube OAuth endpoints, `youtube.upload`,
`videos.insert` и resumable upload code не нашёл реализации.

Практический минимальный scope set:

- `https://www.googleapis.com/auth/youtube.upload` — загрузка видео;
- `https://www.googleapis.com/auth/youtube.readonly` — определить и показать
  owner channel через `channels.list(mine=true)` без запроса более широкого
  `youtube`/`youtube.force-ssl`.

Официальный `videos.insert` требует OAuth Bearer authorization и допускает
`youtube.upload`; API key не входит в допустимую авторизацию для upload:
[Videos: insert](https://developers.google.com/youtube/v3/docs/videos/insert).
`channels.list(mine=true)` требует properly authorized request:
[Channels: list](https://developers.google.com/youtube/v3/docs/channels/list).

### 2. Refresh-token storage

YouTube refresh-token storage отсутствует. Переиспользуемы Supabase Vault и
защитный pattern TikTok bundle, но TikTok RPC/table жёстко привязаны к
`tiktok_accounts` и не должны хранить Google credentials.

Generic server-only Vault primitives уже есть:
`store_secret/get_secret` в
`20260730000026_generic_vault_secrets.sql:1-24`. Для owner-specific token
нужна отдельная account row с ownership/RLS и `token_secret_id`, аналогичная
TikTok pattern.

Для фоновой публикации нужен `access_type=offline` и сохранённый refresh token;
иначе после истечения access token owner пришлось бы авторизовываться перед
каждым upload. Официальный flow:
[OAuth 2.0 for Web Server Applications](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps).

### 3. YouTube account/channel destination

Отсутствуют:

- account record;
- YouTube channel ID/title/handle;
- granted scopes and token expiry;
- connection/reauthorization status;
- UI connect/disconnect/confirm channel;
- связь publication job с выбранным channel.

Для обычного owner account после callback нужно вызвать
`channels.list(part=id,snippet&mine=true)`, сохранить реально авторизованный
channel и показать его владельцу. Нельзя доверять вручную введённому channel ID
без OAuth ownership check.

### 4. Upload implementation

Нет `videos.insert`, binary upload или resumable session code.

YouTube upload — не передача публичного URL как Telegram `sendVideo`. Нужны:

1. получить файл/stream из Supabase Storage;
2. начать `POST .../upload/youtube/v3/videos?uploadType=resumable` с metadata;
3. сохранить `Location` session URI;
4. передать binary через `PUT` с `Content-Length`, `Content-Type` и при resume
   `Content-Range`;
5. обработать `308 Range`, `Retry-After`, истёкшую session и final video ID.

Официальный protocol:
[Resumable Uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol).

Текущий server-side код умеет противоположное направление: скачать Telegram
file и положить bytes в Storage —
`video-from-bot/index.ts:266-280`. `send-post` для публикации только передаёт
URL Telegram. Код, который читает готовый Storage video и стримит его внешнему
publishing provider, отсутствует.

Локальный post-processing watcher действительно скачивает весь `video_url` в
bytes (`scripts/watch-videos.mjs:1073`), но это desktop script, не scheduler,
не OAuth publisher и не resumable upload implementation.

### 5. Metadata and Shorts semantics

Отсутствует mapping для:

- YouTube `snippet.title`;
- `snippet.description`;
- category/tags при необходимости;
- `status.privacyStatus` (`private`, `unlisted`, `public`);
- `status.publishAt`;
- `selfDeclaredMadeForKids`;
- `containsSyntheticMedia` для AI-generated content;
- `notifySubscribers` policy.

`incoming_videos.name`/hook можно предложить как default title, но нельзя
публиковать его молча. `posts.label` в UI-контракте намеренно owner-only и не
уходит в Telegram; `posts.text` — Telegram caption. Источник:
`docs/03_LOVABLE.md:195-218`. Нужен явный YouTube metadata contract и owner
preview/edit before scheduling.

Отдельного YouTube API флага `isShort` в `videos.insert` нет: backend загружает
обычный video resource; исходный 9:16 короткий файл должен соответствовать
текущим правилам Shorts, а классификацию выполняет YouTube.

### 6. Scheduled publication

Текущий `posts.scheduled_at` запускает Telegram send в нужную минуту —
`20260719000008_scheduler.sql:14-25`. Для YouTube этого недостаточно:

- upload и processing занимают непредсказуемое время;
- для точного future publish видео следует загрузить заранее как `private` и
  установить `status.publishAt`;
- YouTube разрешает `publishAt` только private video, которое ещё не было
  опубликовано.

Источник: [Video resource — privacyStatus and publishAt](https://developers.google.com/youtube/v3/docs/videos).

Значит job должен различать `upload_at` и `publish_at` либо гарантировать
достаточный lead time; просто вызвать upload ровно в `scheduled_at` — не
эквивалент существующего Telegram schedule.

### 7. Retry, idempotency and processing state

Текущий retry знает Telegram `429`, Telegram `retry_after`, generic network/5xx
и максимум три попытки — `process-scheduler/index.ts:28-41,202-223`.

Для YouTube дополнительно отсутствуют:

- сохранение resumable session URI и confirmed byte offset;
- resume по `308 Range`;
- restart session после `404`/expiry;
- access-token refresh и `reauth_required` после revoked/invalid grant;
- quota-specific failures;
- idempotency guard от повторного `videos.insert` после ambiguous completion;
- сохранение external YouTube video ID немедленно после success;
- processing/rejection status and reason;
- distinction retryable/permanent/auth/quota errors;
- owner notification with safe actionable error.

Текущие `status`, `retry_count`, `error` и `notify-error` полезны как pattern,
но Telegram worker нельзя использовать без provider-specific state.

### 8. API project publication restriction

По официальной документации uploads из unverified API projects, созданных
после 28.07.2020, ограничиваются private visibility, пока проект не пройдёт
YouTube API audit. Это отдельный вопрос от работоспособности OAuth code:
[Videos: insert](https://developers.google.com/youtube/v3/docs/videos/insert).

Для первого private upload можно проверить технический path без public post.
Для automatic public/scheduled publication owner должен проверить status
проекта и при необходимости пройти соответствующий audit/verification. В этой
задаче ничего такого не выполнялось.

## Reusable components

| Component | Exists | Reusable | Missing work |
|---|---:|---:|---|
| Блок «Каналы» в UI | YES | PARTIAL | Добавить YouTube account card в тот же экран, не выдавая `chats` за generic entity |
| `public.chats` | YES | NO | Telegram-only; не хранить здесь YouTube с fake bot/chat IDs |
| `public.posts` | YES | PARTIAL | Content/status ideas пригодны, но обязательные bot/chat и Telegram fields не подходят YouTube job |
| Provider abstraction | NO | NO | Нужен YouTube publisher interface/module или отдельный worker |
| Telegram publisher | YES | NO | Не адаптируется config-only: endpoint, auth, payload, result and rate limits другие |
| pg_cron + atomic claim pattern | YES | YES | Новый YouTube due-job claim/worker либо provider branch |
| Generic status/retry/error pattern | YES | PARTIAL | Добавить resumable/idempotency/auth/quota/processing states |
| Supabase Auth owner JWT | YES | YES | Применить к OAuth start/account management |
| Supabase Vault | YES | YES | Отдельный per-owner YouTube token bundle + client secret storage |
| TikTok OAuth state/token pattern | YES | YES, AS PATTERN | Реализовать Google-specific endpoints/scopes/refresh/revoke; код не generic |
| Google service account `google_sa_json` | YES | NO | Vertex/cloud-platform credential не является user-delegated YouTube authorization |
| YouTube trend API key | YES | NO | Только read-only `videos.list`; upload требует OAuth |
| Storage bucket + `incoming_videos.video_url` | YES | YES | Server-side download/stream, MIME/length validation |
| Storage-to-provider upload | NO | NO | Реализовать resumable binary upload |
| YouTube account/channel record | NO | NO | Account/channel identity, scopes, status, token reference |
| OAuth start/callback/disconnect | TikTok only | PARTIAL | Google implementation, consent, offline access, state, callback |
| Refresh-token storage/rotation | TikTok only | PARTIAL | YouTube-specific secure bundle and refresh logic |
| YouTube `videos.insert` | NO | NO | Metadata + resumable upload + final video ID |
| Title/description/privacy UI | NO | PARTIAL | Defaults from incoming video, explicit owner editing/confirmation |
| Scheduled YouTube publish | NO | PARTIAL | Upload early/private + `publishAt`; current send-at-minute is insufficient |
| Owner notifications | YES | YES | Добавить provider-specific actionable errors without token leakage |
| Public YouTube verification/audit state | NO | NO | Owner/Google Cloud action, then verified live test without accidental public upload |

## Required owner-side credentials/actions

### Обязательно до реализации/полевого upload test

1. Владелец/администратор Google Cloud выбирает проект, где включён YouTube
   Data API v3. Новый project архитектурно не обязателен, но это owner decision.
2. Создаёт OAuth 2.0 Client типа **Web application** и регистрирует точный HTTPS
   callback URL будущей Supabase Edge Function. Existing API key и service
   account не заменяют OAuth client. Официальные prerequisites:
   [OAuth web-server flow](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps).
3. Настраивает OAuth consent screen/audience; для testing добавляет owner Google
   account как test user. Для внешнего production use может потребоваться OAuth
   verification.
4. В VibePost нажимает `Connect YouTube`, входит именно в Google identity,
   управляющую нужным YouTube channel, и явно выдаёт requested scopes.
5. Проверяет показанные VibePost channel ID/title/handle и подтверждает этот
   destination.
6. Для каждого upload подтверждает/задаёт title, description, visibility и,
   если требуется, publish time; также нужны policy decisions по made-for-kids,
   synthetic media и subscriber notification.
7. Для public/scheduled automation проверяет, снято ли private-only ограничение
   API project; при необходимости owner проходит YouTube API audit.

### Почему существующей Google/Gemini конфигурации недостаточно

- Trend scout использует API key только как query parameter для read-only
  `videos.list`: `_shared/youtube-trend.mjs:261-275`.
- Gemini/Vertex functions используют service account из Vault и scope
  `cloud-platform`: `video-from-bot/index.ts:56-80,144-149` и
  `idea-button/index.ts:81-105,129-134`.
- Обычная публикация в owner YouTube channel требует **user-delegated OAuth**.
  Service account поддерживается YouTube только для специального content-owner
  CMS flow, которого у VibePost нет. Официальное ограничение:
  [OAuth web-server applications](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps).

Итог: **Google OAuth client нужен; owner authorization нужен**.

Billing/Gemini/Veo configuration не является credential или authorization для
YouTube upload. В этом аудите billing не менялся и не предлагается как часть
минимального credential flow.

## Minimal implementation plan

Это план отдельного будущего этапа, не выполненная реализация.

### 1. Не расширять `chats` фиктивными данными

Сохранить legacy Telegram schema и scheduler без ломки. В существующем UI-блоке
«Каналы» визуально показывать два вида записей:

- Telegram chats из `chats`;
- YouTube destinations из отдельной provider-specific account/channel model.

Так owner получает один экран, но backend не притворяется generic там, где он
Telegram-specific.

### 2. Добавить минимальную schema внутри текущего Supabase

Новая database instance не нужна. Нужна будущая migration в **существующей**
БД, минимально для:

- `youtube_accounts`: owner, channel ID/title/handle, scopes, expiry,
  connection status, `token_secret_id`;
- one-time OAuth state (или аккуратная provider-neutral evolution OAuth states);
- `youtube_publication_jobs`: account/destination, `incoming_video_id`,
  title/description/privacy/publish time, status/retry/error, resumable session
  state, external YouTube video ID and timestamps.

Не рекомендуется делать nullable `bot_id/chat_id` во всех legacy posts,
recurring posts, chains, slots, analytics и guards: это значительно расширит
scope и риски.

### 3. Google OAuth Edge Functions

- start: Supabase owner JWT, hashed short-lived state, exact redirect URI,
  least-privilege scopes, `access_type=offline`;
- callback: consume state, exchange code, secure token bundle in Vault,
  `channels.list(mine=true)`, persist/confirm channel;
- refresh: rotate access token from stored refresh token;
- disconnect: revoke Google grant and clean Vault/local state;
- never return tokens to UI/logs.

TikTok implementation is a strong pattern, but copying its endpoints/tables
literally would be incorrect.

### 4. YouTube resumable publisher

- fetch/stream approved `incoming_videos.video_url` from Storage;
- validate ownership, accepted state, target platform, MIME and size;
- initiate resumable `videos.insert` with explicit metadata;
- persist session URI/offset before sending binary;
- resume safely after failures and persist external video ID immediately;
- do not create a second video after ambiguous completion;
- poll/record processing or rejection when needed.

For 10-second files Supabase Edge Functions are a plausible host; no separate
server is inherently required. Execution/file-size limits must be verified with
a real **private** upload before declaring production-ready. If those limits are
exceeded later, a dedicated worker would be a follow-up, not a current
requirement.

### 5. Scheduling

Reuse pg_cron, service-role invocation, atomic claim and status conventions,
but add a YouTube-specific job worker or explicit provider dispatch. Scheduled
publication should upload sufficiently early as private and set `publishAt`, not
wait until publication minute to start upload.

The current `process-scheduler` cannot publish YouTube unchanged because it
requires bot/chat, resolves Telegram credentials and calls Telegram-only
`sendPost`. Scheduler reuse verdict is therefore **PARTIAL**.

### 6. Owner UI in existing workflow

- «Каналы» → `Connect YouTube`, connected channel identity/status,
  reauthorize/disconnect;
- «Входящие» → existing accepted video, destination YouTube, explicit
  title/description/visibility/time;
- show upload/processing/scheduled/published/failed states;
- preserve manual fallback and never show automatic success before external
  video ID is stored;
- no new owner interface outside VibePost.

### 7. Acceptance tests before public enablement

1. OAuth state/ownership/refresh/revoke tests without token leakage.
2. `channels.list(mine=true)` proves exact owner destination.
3. Private resumable upload of one non-public test file.
4. Forced interruption/resume without duplicate video.
5. Expired access token refresh and revoked-token reauth path.
6. Metadata/visibility validation and private future `publishAt` test.
7. Legacy Telegram channel/post/scheduler regression tests.
8. Only after project/audit status is verified: separate owner-approved public
   test. No public test is part of this audit.

## Verdict

**MEDIUM INTEGRATION**

- новая БД нужна: **NO** — достаточно текущего Supabase, но новые schema
  objects/migration внутри него понадобятся.
- новый backend service нужен: **NO** — можно остаться в Supabase Edge
  Functions; новый YouTube provider/worker code всё равно обязателен.
- Google OAuth client нужен: **YES**.
- owner authorization нужен: **YES**.
- scheduler можно переиспользовать: **PARTIAL** — cron/claim/status patterns да;
  текущий Telegram worker/send path без изменений нет.
