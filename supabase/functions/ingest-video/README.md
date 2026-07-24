# ingest-video

Принимает готовый видеоролик из внешнего пайплайна озвучки и создаёт **черновик**
поста (`format='video'`, `status='draft'`) в VibePost. Черновик планировщиком не
отправляется — пользователь сам смотрит его в интерфейсе и назначает чат/время.

## Деплой

```
supabase functions deploy ingest-video
```

Функция использует уже существующие переменные окружения проекта
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) — отдельно ничего задавать не нужно.

## Вызов (server-to-server)

`POST` multipart/form-data на `https://<project>.supabase.co/functions/v1/ingest-video`
с заголовком `Authorization: Bearer <service_role key>`.

Поля формы:

| Поле | Обяз. | Описание |
| --- | --- | --- |
| `video` | да | файл mp4 |
| `name` | да | короткое имя, напр. `01-raccoon-inflation` |
| `caption` | нет | текст подписи поста |
| `scheduled_at` | нет | ISO-время; без него — заглушка now()+1ч |
| `bot_id` | нет | целевой бот (по умолчанию первый бот) |
| `chat_id` | нет | целевой чат (по умолчанию первый чат бота) |

Ответ `200`: `{ id, video_url, status, bot_id, chat_id }`.

## Как это подключено

Локальный CLI `spraycheck-vision-pro` (`npm run voiceover`) после сборки ролика
сам вызывает эту функцию, если в его `.env` заданы `VIBEPOST_INGEST_URL` и
`VIBEPOST_KEY` (service_role). Ролик кладётся в бакет `post-photos`
(`<user_id>/videos/...`), пост создаётся черновиком.
