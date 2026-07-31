/**
 * Публикация Edge Functions прямо из файлов проекта.
 *
 *   node scripts/deploy.mjs idea-button
 *   node scripts/deploy.mjs idea-button suggest-ideas video-from-bot
 *   node scripts/deploy.mjs --all
 *
 * Раньше код функции приходилось перекладывать в запрос вручную — на файлах
 * в двадцать килобайт это ненадёжно. Теперь берём файл с диска как есть.
 *
 * Нужен SUPABASE_ACCESS_TOKEN в .env (личный токен из supabase.com/dashboard/account/tokens).
 *
 * verify_jwt: по умолчанию true — функцию можно звать только со служебным
 * ключом. Исключение telegram-webhook: его дёргает сам Telegram, без ключа.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const env = {};
for (const line of readFileSync(new URL('.env', root), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const token = env.SUPABASE_ACCESS_TOKEN;
const ref = env.SUPABASE_PROJECT_REF;
if (!token || !ref) {
  console.error('В .env нужны SUPABASE_ACCESS_TOKEN и SUPABASE_PROJECT_REF.');
  process.exit(1);
}

const БЕЗ_ПРОВЕРКИ_КЛЮЧА = new Set(['telegram-webhook', 'ingest-video']);
const dir = new URL('supabase/functions/', root);
const базовый = decodeURIComponent(dir.pathname.replace(/^\//, ''));

const аргументы = process.argv.slice(2);
const имена = аргументы.includes('--all')
  ? readdirSync(базовый, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(базовый, e.name, 'index.ts')))
      .map((e) => e.name)
  : аргументы;

if (!имена.length) {
  console.error('Укажите имена функций или --all.');
  process.exit(1);
}

let ошибок = 0;
for (const имя of имена) {
  const файл = join(базовый, имя, 'index.ts');
  if (!existsSync(файл)) {
    console.log(`${имя}: файла нет, пропускаю`);
    ошибок++;
    continue;
  }
  const код = readFileSync(файл);
  const verify = !БЕЗ_ПРОВЕРКИ_КЛЮЧА.has(имя);

  const form = new FormData();
  form.append(
    'metadata',
    new Blob(
      [JSON.stringify({ name: имя, entrypoint_path: 'index.ts', verify_jwt: verify })],
      { type: 'application/json' },
    ),
  );
  form.append('file', new Blob([код], { type: 'text/typescript' }), 'index.ts');

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/functions/deploy?slug=${имя}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form },
  );

  if (res.ok) {
    const d = await res.json().catch(() => ({}));
    const кб = (код.length / 1024).toFixed(1);
    console.log(`${имя}: опубликована, версия ${d.version ?? '?'}, ${кб} КБ` +
      (verify ? '' : ' (без проверки ключа)'));
  } else {
    console.log(`${имя}: ОШИБКА ${res.status} — ${(await res.text()).slice(0, 200)}`);
    ошибок++;
  }
}

process.exit(ошибок ? 1 : 0);
