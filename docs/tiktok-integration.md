# TikTok → Content Brigade v2

Статус на 15.08.2026: **OAuth, API, schema gate, canonical storage и cron live verified**.

Интеграция использует только официальный TikTok Login Kit и Display API. Scraping,
браузерная автоматизация, неофициальные API и эмуляция приложения запрещены.

## Что построено до live-response gate

```text
Supabase user JWT
→ tiktok-oauth-start
→ official TikTok consent page
→ tiktok-oauth-callback
→ access/refresh tokens in Supabase Vault
→ real user/info + video/list + video/query probes
→ sanitized fixtures + backend-only raw video items
→ schema review gate
→ canonical videos + append-only API snapshots
```

`tiktok-sync` поддерживает ручной запуск и вызов по `pg_cron` каждые 15 минут.
Cron проходит через `verify_jwt=true`: функция принимает точный service key или
уже проверенный gateway JWT с payload `role=service_role`.
Параллельные запуски разделены `FOR UPDATE SKIP LOCKED`, а единая per-account
lease защищает refresh и sync от одновременного cron/manual запуска. Повтор
запроса с тем же `Idempotency-Key` не создаёт второй sync run; `failed` run
можно безопасно повторить тем же ключом.

OAuth reconnect и disconnect используют ту же lease. `token_generation`
защищает Vault bundle и account metadata от stale-write после ротации токена.
Backfill хранит cursor в account и продолжает следующие 200 видео в новом run,
поэтому аккаунты с большой историей не застревают на первой пачке.

Backend-only raw payload хранится не более 14 дней и удаляется ежедневным cron.
Sanitized fixture сохраняет числовые/boolean метрики, но по умолчанию редактирует
любые строковые значения; структура полей остаётся в `field_inventory`.

До подтверждения endpoint-scoped fingerprints функция намеренно **не создаёт**
канонические `videos` и `video_metric_snapshots`. Live fixtures проверены и
fingerprints одобрены; повторный sync создал 19 videos и 19 append-only
snapshots. Studio retention, traffic, completion и saves не вычисляются и
записываются только в отдельную `studio_metrics` вручную.

## Секреты

Edge Function configuration (первые три значения — secrets; origin не секрет):

```text
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
TIKTOK_REDIRECT_URI
VIBEPOST_APP_ORIGIN
```

Пользовательские `access_token` и `refresh_token` сохраняются единым JSON bundle
в Supabase Vault. В `tiktok_accounts` хранится только `token_secret_id` и сроки
действия. Refresh token может ротироваться — sync всегда сохраняет новое значение.

Никогда не помещайте эти значения в Git, документацию, браузерный код или логи.

## OAuth setup

1. Создать приложение в TikTok for Developers.
2. Добавить Login Kit и запросить scopes `user.info.basic` и `video.list`.
3. Зарегистрировать точный HTTPS redirect URI:

   ```text
   https://rjtyjybwygfkdekdzqbm.supabase.co/functions/v1/tiktok-oauth-callback
   ```

4. Добавить три Edge secrets и при необходимости переопределить `VIBEPOST_APP_ORIGIN`.
5. Применить миграции и задеплоить функции:

   ```bash
   supabase link --project-ref rjtyjybwygfkdekdzqbm
   supabase db push
   supabase functions deploy tiktok-oauth-start --use-api
   supabase functions deploy tiktok-oauth-callback --use-api
   supabase functions deploy tiktok-sync --use-api
   supabase functions deploy tiktok-disconnect --use-api
   ```

   `verify_jwt` закреплён в `supabase/config.toml`; callback и `ingest-video`
   публичны только на уровне gateway и проверяют собственный OAuth state/secret.
   Старый `node scripts/deploy.mjs` намеренно откажется деплоить TikTok-функции,
   потому что он не умеет пакетовать `_shared/tiktok.ts`.

6. Вызвать `tiktok-oauth-start` с JWT вошедшего пользователя и открыть
   `authorization_url` вручную. Автоматизировать страницу согласия нельзя.

Пример вызова из приложения:

```ts
const { data, error } = await supabase.functions.invoke("tiktok-oauth-start", {
  body: {},
});
if (error) throw error;
window.location.assign(data.authorization_url);
```

## Ручная синхронизация

Клиент должен повторно использовать собственный idempotency key при сетевом
retry одного нажатия:

```ts
// Create once for one logical click; reuse this value in every network retry.
const idempotencyKey = crypto.randomUUID();
const { data, error } = await supabase.functions.invoke("tiktok-sync", {
  body: {
    account_id: "<TIKTOK_ACCOUNT_UUID>",
    idempotency_key: idempotencyKey,
  },
});
```

Текущий опубликованный VibePost вызывает функцию с `body: {}`. Это также
поддерживается: функция выбирает последний TikTok account текущего пользователя
и создаёт минутный fallback idempotency key. Явный `account_id` и собственный
`Idempotency-Key` предпочтительнее для сетевых retry.

## Ошибки

- `access_token_invalid`: один refresh и один повтор.
- `invalid_grant`, `scope_not_authorized`, `scope_permission_missed`:
  `reauth_required`.
- Read-only Display API `429`/`5xx`/network: `Retry-After` либо exponential
  backoff с jitter, затем следующий cron.
- Token exchange/refresh: только одна попытка. Неоднозначный network/5xx ответ
  не переигрывается из-за возможной ротации refresh token и переводит sync в
  `reauth_required`.
- `invalid_params`: без бессмысленных повторов.

Пользователь отключает аккаунт через `tiktok-disconnect`: функция вызывает
официальный `/v2/oauth/revoke/`, затем удаляет account и Vault bundle. При
неоднозначной ошибке состояние становится `revoked_pending`. Осознанный
`force_local_cleanup: true` удаляет только локальные данные, если provider
revoke невозможно завершить; результат явно помечается `NOT_VERIFIED`.

Для поддержки сохраняются HTTP status, API error code и TikTok `log_id`; токены
в error text не попадают.

## Live-response gate

После OAuth проверить:

1. `tiktok_api_fixtures` содержит `/v2/user/info/` и `/v2/video/list/`.
2. При непустом аккаунте есть `/v2/video/query/` по всем ID из `video/list`
   (пачки максимум по 20; текущий live account — 19).
3. `redacted_response` не содержит OpenID, названий, URL и токенов.
4. `field_inventory` совпадает с фактической JSON-формой.
5. Backend, data, security и QA review подтверждают mapping.
6. Reviewer отмечает fixtures через service-only `verify_tiktok_api_fixture`,
   затем `approve_tiktok_fixture_schema` проверяет наличие verified
   `video/list` + `video/query` и фиксирует response hashes и структурные
   endpoint-scoped fingerprints (`endpoint + path + union types`). Обычный sync сохраняет `verified`,
   пока fingerprint не изменился; новый путь/тип снова открывает review gate.
7. Только затем sync вызывает gated RPC и создаёт один video record и один
   snapshot на `(video_id, sync_run_id)`.

Если аккаунт пуст, `video/query` остаётся `NOT VERIFIED`; это не ошибка sync,
но финализацию video schema блокирует.

## Live proof 15.08.2026

- account `active`, schema `verified`;
- 19 уникальных ID из `/v2/video/list/` и 19 из `/v2/video/query/` в одном run;
- manual run: `completed`, `seen=19`, `written=19`;
- canonical storage: 19 `videos`, 38 accumulated `video_metric_snapshots`;
- scheduled pg_cron run: `completed`, HTTP 2xx, без 401;
- повтор с тем же idempotency key не создаёт второй run;
- `process-scheduler` Telegram отдельно работает каждую минуту с HTTP 200.

## Повторная проверка 22.08.2026

- account `active`, schema `verified`, backfill завершён;
- 26 canonical videos и 7481 append-only API snapshots;
- 340 sync runs со статусом `completed`;
- TikTok sync, Content Brigade и основной scheduler активны, последние cron
  runs имеют статус `succeeded`;
- локальные функции и миграции перенесены в рабочий репозиторий и сверены с
  кодом, скачанным из Supabase;
- `ingest-video` version 7 задеплоен и совпадает с локальным исходником.

## Официальные источники

- Login Kit for Web: https://developers.tiktok.com/doc/login-kit-web
- OAuth token management: https://developers.tiktok.com/doc/oauth-user-access-token-management
- Display API: https://developers.tiktok.com/doc/display-api-overview
- List Videos: https://developers.tiktok.com/doc/tiktok-api-v2-video-list/
- Query Videos: https://developers.tiktok.com/doc/tiktok-api-v2-video-query/
- Video Object: https://developers.tiktok.com/doc/tiktok-api-v2-video-object
- Rate limits: https://developers.tiktok.com/doc/tiktok-api-v2-rate-limit/
