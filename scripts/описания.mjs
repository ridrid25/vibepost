/**
 * Запись вариантов описания для YouTube-ролика (умная приставка).
 *
 *   node scripts/описания.mjs <queue_id> "вариант 1" "вариант 2" "вариант 3"
 *
 * Зовёт дежурный по заданию «придумай описания». Каждый вариант — готовый
 * текст для поля «Описание»: строка-подвох + строка хэштегов через \n.
 * Варианты появляются в карточке ролика в VibePost, заказчица тыкает один.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const корень = dirname(dirname(fileURLToPath(import.meta.url)));
const env = {};
for (const line of readFileSync(join(корень, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL.replace(/\/$/, '');
const h = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

const [, , id, ...варианты] = process.argv;
if (!id || варианты.length < 2) {
  console.error('нужно: описания.mjs <queue_id> "вариант 1" "вариант 2" ["вариант 3"]');
  process.exit(2);
}
const r = await fetch(`${url}/rest/v1/youtube_publish_queue?id=eq.${id}`, {
  method: 'PATCH', headers: h,
  body: JSON.stringify({
    description_options: варианты,
    updated_at: new Date().toISOString(),
  }),
});
console.log(r.ok ? `записано вариантов: ${варианты.length}` : `ошибка: ${r.status}`);
process.exitCode = r.ok ? 0 : 1;
