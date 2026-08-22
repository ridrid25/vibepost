# Integration TikTok → Content Brigade

Updated: 2026-08-22
Status: active; source, cloud deployment and scheduled cycles verified

## Goal

Получать официальные метрики собственных публичных TikTok-видео, хранить их
историю и использовать только достаточные данные для следующего experiment и
Gemini production prompt.

## Services

- Source: TikTok Login Kit + Display API v2.
- Auth: OAuth 2.0 authorization code; scopes `user.info.basic`, `video.list`.
- Storage/orchestration: Supabase Postgres, Vault, Edge Functions, pg_cron.
- Consumer: Content Brigade generator.

## Decisions

- Только official API; никакого scraping/automation.
- Tokens server-side only in Vault.
- Raw/sanitized fixture gate перед нормализацией.
- Duplicate strategy: account/video unique IDs plus sync idempotency key.
- UI dashboard не строится; аналитика внутренняя.
- Manual Studio metrics физически отделены от API и calculated values.

## Test results

| Test | Result | Notes |
|---|---|---|
| Pure OAuth/API helpers | PASS | 15 Node tests |
| Content Brigade analytics/connectors | PASS | 30 Node tests |
| OAuth success | PASS | live consent completed 15.08.2026 |
| OAuth failure | PASS (contract) | invalid state/error paths covered; no destructive live consent test |
| Token refresh | PASS (mocked) | refresh/rotation helpers covered; natural live expiration not awaited |
| Empty account | PASS (contract) | empty list is a valid completed sync; no separate empty live account |
| video/list fixture | PASS | 19 public videos observed |
| video/query fixture | PASS | 15 live fields observed |
| Query endpoint provenance | PASS | 19 unique query IDs, separate from 19 list rows |
| Canonical storage | PASS | 26 videos + 7481 accumulated API snapshots |
| Scheduled sync | PASS | completed run, no 401 |
| Content Brigade auth | PASS | correct secret 200; wrong secret 403 |
| Server Learning Engine | PASS | PF-v1 loaded; scheduled cycle succeeds |
| Learning evidence integrity | PASS | atomic experiment link; server recomputes verdict |
| Learning Engine cron | PASS | active 2/17/32/47; latest pg_cron run succeeded |
| Source consolidation | PASS | active repos match deployed source; old task copies are no longer canonical |
| Ingest contract | PASS | version 7 deployed; delivery-id deduplication schema verified |

Реальная облачная `incoming_videos` содержит дополнительные колонки
`hook`, `hook_options`, `last_activity_at`, `measure_*`, `polished_at`,
`rework_*`, `tag`. Их production-схема восстановлена в локальной idempotent
migration `20260822000001_incoming_video_production_parity.sql`.

## Open gate

- [x] TikTok Developer app created and approved.
- [x] Exact redirect URI registered.
- [x] Edge secrets configured.
- [x] Test account authorizes both scopes.
- [x] Real sanitized fixtures reviewed.
- [x] Cloud schema drift checked before normalized migration.

Endpoint-aware уникальность сохраняет отдельное происхождение объектов
`/v2/video/list/` и `/v2/video/query/`. Reviewer подтвердил fixtures;
последующие sync обновляют canonical `videos` и дописывают metric snapshots.

`studio_metrics` задеплоена отдельной таблицей. Значений пока 0: retention,
completion, traffic и saves не пришли из Display API и должны вводиться вручную.
Это ожидаемая граница официального API, а не незакрытый технический хвост.
