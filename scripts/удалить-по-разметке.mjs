/**
 * Удаляет из хранилища post-photos файлы, помеченные «удалить» в разметке.
 *
 *   node scripts/удалить-по-разметке.mjs docs/уборка/2026-10-07-разметка.tsv
 *
 * Разметку готовит Claude, удаление подтверждает заказчица (07.10.2026: «ок»).
 * Удаляет через Storage API (файл и запись), пачками по 50; каждое удаление
 * пишется в журнал рядом с разметкой. Ничего не скачивает — её решение 29.09:
 * старые копии не хранить, трафик беречь.
 */
import fs from 'node:fs';
import path from 'node:path';

const файл = process.argv[2];
if (!файл) { console.log('укажите файл разметки'); process.exit(1); }
const env = {};
for (const с of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = с.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL.replace(/\/$/, '');
const h = {
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  'Content-Type': 'application/json',
};

const пути = fs.readFileSync(файл, 'utf8').split(/\r?\n/).slice(1)
  .map((с) => с.split('\t')).filter((к) => к[3]?.startsWith('удалить')).map((к) => к[0]);
const журнал = файл.replace(/разметка\.tsv$/, 'журнал-удаления.tsv');
fs.writeFileSync(журнал, 'время\tпуть\tрезультат\n');
console.log(`к удалению по разметке: ${пути.length}`);

let удалено = 0, нет = 0;
for (let i = 0; i < пути.length; i += 50) {
  const пачка = пути.slice(i, i + 50);
  const r = await fetch(`${url}/storage/v1/object/post-photos`, {
    method: 'DELETE', headers: h, body: JSON.stringify({ prefixes: пачка }),
  });
  const текст = await r.text();
  let ушли = new Set();
  try { ушли = new Set(JSON.parse(текст).map((x) => x.name)); } catch {}
  const сейчас = new Date().toISOString();
  for (const п of пачка) {
    const да = ушли.has(п);
    да ? удалено++ : нет++;
    fs.appendFileSync(журнал, `${сейчас}\t${п}\t${да ? 'удалён' : `НЕ удалён (${r.status})`}\n`);
  }
  if (r.status !== 200) { console.log(`остановлено: ответ ${r.status} ${текст.slice(0, 150)}`); break; }
}
console.log(`удалено: ${удалено} | не удалено: ${нет} | журнал: ${path.basename(журнал)}`);
