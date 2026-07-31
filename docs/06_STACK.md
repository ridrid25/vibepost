# Стек технологий

Что и где работает. Claude правит этот файл сам, как только что-то меняется.

Обновлено: 31.07.2026

---

## Постинг — проект VibePost

| Слой | Чем |
|---|---|
| База, хранилище, авторизация | Supabase, облако, ref `rjtyjybwygfkdekdzqbm`, тариф Free |
| Серверная логика | Supabase Edge Functions, Deno + TypeScript, 19 функций |
| Расписание | pg_cron + pg_net, 9 заданий |
| Секреты | Supabase Vault и Edge Function Secrets |
| Публикация функций | `node scripts/deploy.mjs` через Management API |
| Интерфейс | Lovable, React + TypeScript + Tailwind + shadcn/ui |
| Боевой адрес | https://chrono-vibepost.lovable.app |
| Мессенджер | Telegram Bot API, бот @VibePostTG_bot |
| Код | GitHub, приватный `ridrid25/vibepost` |

**Внимание:** Supabase на бесплатном тарифе засыпает при простое, и постинг
встаёт до ручного пробуждения. Для боевого использования нужен Pro.

## Генерация роликов — проект «Генерация роликов»

| Слой | Чем |
|---|---|
| Идеи и промты | Gemini 2.5 Flash через Vertex AI |
| Видео, платно | Veo `veo-3.1-lite-generate-001`, около 0,40 $ за 8 секунд |
| Видео, бесплатно | Приложение Gemini, вручную, по подписке Google AI Pro |
| Озвучка | Edge TTS (msedge-tts), голос `ru-RU-DmitryNeural`, бесплатно |
| Обработка видео | ffmpeg на компьютере Татьяны |
| Код | GitHub, приватный `ridrid25/vibepost-video` |
| Папка на диске | `C:\Users\rid-s\Downloads\Обучение\CLAUD\Генерация роликов` |

## Доступы к Google

| Что | Как |
|---|---|
| Аккаунт | `t9183033323@gmail.com` |
| Проект | `gen-lang-client-0434343773`, оплата подключена, Tier 1 |
| Способ доступа | Служебный аккаунт `vibepost-veo@…`, роль Agent Platform User |
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
