# TikTok API fields

Статус: **LIVE OBSERVED для аккаунта VibePost, 15.08.2026**. OAuth успешно
завершён, `video/list` и `video/query` вернули 19 роликов и подтвердили
перечисленные ниже поля. Очищенные fixtures проверены, schema fingerprint
одобрен; sync записал 19 canonical videos и 19 API snapshots.

## Документированные поля Video Object

| Field | Documented type | Planned meaning | Verification |
|---|---:|---|---|
| `id` | string | TikTok video ID | LIVE OBSERVED |
| `create_time` | int64 | Unix time UTC | LIVE OBSERVED |
| `cover_image_url` | string | Временная CDN-обложка | LIVE OBSERVED |
| `share_url` | string | Публичная ссылка | LIVE OBSERVED |
| `video_description` | string | Описание ролика | LIVE OBSERVED |
| `duration` | int32 | Длительность, секунды | LIVE OBSERVED |
| `height` | int32 | Высота | LIVE OBSERVED |
| `width` | int32 | Ширина | LIVE OBSERVED |
| `title` | string | Заголовок | LIVE OBSERVED |
| `embed_html` | string | Embed HTML | LIVE OBSERVED |
| `embed_link` | string | Embed URL | LIVE OBSERVED |
| `like_count` | int32 | Лайки | LIVE OBSERVED |
| `comment_count` | int32 | Комментарии | LIVE OBSERVED |
| `share_count` | int32 | Репосты | LIVE OBSERVED |
| `view_count` | int64 | Просмотры | LIVE OBSERVED |

Запрос `video/list` идёт с `max_count=20`; `video/query` принимает максимум 20
ID за запрос. Официальный базовый limit для обоих endpoints — 600 запросов в
минуту на скользящем окне.

`embed_html` сохраняется только в временном raw capture и не переносится в
каноническую `videos`: приложению достаточно `embed_link`/`share_url`, а HTML
провайдера не должен становиться доверенным хранимым содержимым.

## Метрики TikTok Studio

Эти поля не заявлены в Display API и останутся отдельным ручным источником
`manual_tiktok_studio`:

- `average_watch_time_seconds`
- `average_retention_percent`
- `full_watch_percent`
- `traffic_for_you_percent`
- `traffic_profile_percent`
- `traffic_search_percent`
- `traffic_following_percent`
- `saves`
- `retention_drop_second`

`NULL` означает «нет значения». Его запрещено заменять нулём. Completion нельзя
восстанавливать из average watch time, а saves нельзя имитировать через likes.

## Live example

Реальные ответы и inventory сохранены в `tiktok_api_fixtures`; токены, OpenID,
video IDs, подписи и URL удалены. Документация не копирует персональные значения
из fixture.

Подтверждённая форма ответа:

```json
{
  "data": {
    "videos": []
  },
  "error": {
    "code": "ok",
    "message": "",
    "log_id": "<redacted>"
  }
}
```
