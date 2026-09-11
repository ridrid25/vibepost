# Стек технологий

Что и где работает. Claude правит этот файл сам, как только что-то меняется.

Обновлено: 22.08.2026

---

## Постинг — проект VibePost

| Слой | Чем |
|---|---|
| База, хранилище, авторизация | Supabase, облако, ref `rjtyjybwygfkdekdzqbm`, тариф Free |
| Серверная логика | Supabase Edge Functions, Deno + TypeScript, 29 активных функций |
| Расписание | pg_cron + pg_net, 17 активных заданий |
| Секреты | Supabase Vault и Edge Function Secrets |
| Публикация функций | Простые single-file: `node scripts/deploy.mjs`; функции с `_shared`: Supabase CLI `functions deploy --use-api` |
| Интерфейс | Lovable, React + TypeScript + Tailwind + shadcn/ui |
| Боевой адрес | https://chrono-vibepost.lovable.app |
| Мессенджер | Telegram Bot API, бот @VibePostTG_bot |
| Код | GitHub, приватный `ridrid25/vibepost` |

**Внимание:** Supabase на бесплатном тарифе засыпает при простое, и постинг
встаёт до ручного пробуждения. Для боевого использования нужен Pro.

## Генерация роликов — проект «Генерация роликов»

| Слой | Чем |
|---|---|
| Промты роликов | Claude локально; бригада ролей только по правилам проекта |
| Видео, платно | Veo `veo-3.1-lite-generate-001`, около 0,40 $ за ролик; длительность берётся из промта, у канала это 10 секунд |
| Видео, основной ручной путь | Приложения Gemini/Flow, вручную |
| Озвучка | Edge TTS (msedge-tts), голос `ru-RU-DmitryNeural`, бесплатно |
| Обработка видео | ffmpeg на компьютере Татьяны |
| TikTok-аналитика | Display API → Supabase → Content Brigade Learning Engine |
| Wan/LTX | Отдельный сохранённый эксперимент; автоматически не подключён |
| Код | GitHub, приватный `ridrid25/vibepost-video` |
| Папка на диске | `C:\Users\rid-s\Downloads\Обучение\CLAUD\Генерация роликов` |

## Доступы к Google

| Что | Как |
|---|---|
| Аккаунт | Хранится в настройках Google, не дублируется в документации |
| Проект | Google Cloud project с подключённой оплатой, Tier 1 |
| Способ доступа | Служебный аккаунт с ролью Agent Platform User |
| Ключ | JSON в Vault под именем `google_sa_json` |

**Почему служебный аккаунт, а не ключ API:** Google выдаёт этому аккаунту ключи
в формате `AQ.…`, которые REST-интерфейс не принимает. Обычный ключ `AIza`
создать в проекте нельзя — форма требует привязки к служебному аккаунту.

## Что решили не использовать

| Что | Почему |
|---|---|
| Собственный сервер Supabase (`supabase.ridfinance.ru`) | порты БД закрыты, миграции не применить |
| Ключи API Google | формат `AQ.` не работает с REST |
| Модели Veo дороже лёгкой | быстрая вдвое, обычная в восемь раз дороже |
| Вжигание титров на сервере | нет ffmpeg в Edge Functions |

## YouTube Shorts field trial V0.1

| Часть | Реализация |
|---|---|
| Trend metadata | YouTube Data API v3, read-only `videos.list`, secret `YOUTUBE_API_KEY` в Supabase secrets |
| Trend scope | Маленький реестр принятых V0.1 references; без crawler/dashboard |
| Owner interface | Существующий Telegram bot и его текущие кнопки |
| Video generation | Бесплатная ручная генерация по JSON prompt из Telegram |
| Review | Existing Gemini advisory review + numerical `measure.py` |
| YouTube publication | Ручная: YouTube OAuth/upload provider в VibePost отсутствует |
| Idea brain | `_shared/youtube-idea-brain.mjs`: bounded contracts из live reference, `analitika_dnya`, `content_lessons`, `tiktok_tegi` |
| Novelty/fidelity gate | `_shared/youtube-idea-novelty.mjs` + DB trigger; полная persisted history, hero lock только для YouTube |
| Reference store | `market_references`, автоматически upsert при production `suggest-ideas`; четыре V0.1 references уже в live |
| Own-result evidence | Generic `experiments` + `content_analysis_results` + `content_lesson_youtube_publications`; только provenance-complete пары |
| Evidence schedule | Существующий `vibepost-content-brigade`, каждые 15 минут; strict pair discovery, регистрация и checkpoint-aware analysis без фиктивных A/B-пар |
| Snapshot compatibility | `youtube_short_snapshots` — read-only view над `published_shorts_stats`, не новая таблица |
