/**
 * Ход работы: показывает Татьяне, что дело идёт, пока Claude молчит.
 *
 *   node scripts/ход.mjs начать "Промт ролика: комар" сценарист,режиссёр,оператор,критик
 *   node scripts/ход.mjs шаг <id> "оператор собирает JSON"
 *   node scripts/ход.mjs готово <id> "промт отправлен"
 *   node scripts/ход.mjs отменить <id> "причина"
 *
 * Команда «начать» печатает id — его передают в остальные.
 *
 * Зачем это вообще. Бригада пишет промт пятнадцать минут, и всё это время в
 * окне разговора пусто. Татьяна не отличает работу от зависшего компьютера, а
 * отсутствие ответа — единственный признак поломки, который у неё есть.
 *
 * Полосу двигает не этот скрипт, а приёмник: он опрашивает базу каждые пять
 * секунд и правит сообщение в боте. Здесь только вехи — начали, сменили этап,
 * закончили.
 */
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL?.replace(/\/$/, '');
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('В .env нет доступа к базе.');
  process.exit(1);
}
const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

const [команда, ...аргументы] = process.argv.slice(2);

async function владелец() {
  const [p] = await (await fetch(
    `${url}/rest/v1/profiles?error_notify_tg_id=not.is.null&select=id&limit=1`,
    { headers: h },
  )).json();
  if (!p) throw new Error('не найден профиль владельца');
  return p.id;
}

if (команда === 'начать') {
  const [название, этапы] = аргументы;
  if (!название || !этапы) throw new Error('нужны название и список этапов через запятую');
  const r = await fetch(`${url}/rest/v1/work_progress`, {
    method: 'POST',
    headers: { ...h, Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: await владелец(),
      title: название,
      stages: этапы.split(',').map((s) => s.trim()).filter(Boolean),
      step: 0,
      note: 'начинаю',
    }),
  });
  if (!r.ok) throw new Error(`база отказала: ${r.status} ${await r.text()}`);
  const [строка] = await r.json();
  console.log(строка.id);

} else if (команда === 'шаг' || команда === 'готово' || команда === 'отменить') {
  const [id, ...текст] = аргументы;
  if (!id) throw new Error('нужен id дела');
  const примечание = текст.join(' ').trim();

  const [дело] = await (await fetch(
    `${url}/rest/v1/work_progress?id=eq.${id}&select=step,stages`, { headers: h },
  )).json();
  if (!дело) throw new Error('такого дела нет');

  const правка = команда === 'шаг'
    ? { step: Math.min(дело.step + 1, дело.stages.length), note: примечание || null,
        updated_at: new Date().toISOString() }
    : { step: команда === 'готово' ? дело.stages.length : дело.step,
        note: примечание || null,
        done_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        outcome: команда === 'готово' ? 'готово' : (примечание || 'отменено') };

  const r = await fetch(`${url}/rest/v1/work_progress?id=eq.${id}`, {
    method: 'PATCH', headers: h, body: JSON.stringify(правка),
  });
  if (!r.ok) throw new Error(`база отказала: ${r.status} ${await r.text()}`);
  console.log(команда === 'шаг' ? `этап ${правка.step}/${дело.stages.length}` : команда);

} else {
  console.log('команды: начать "название" этап1,этап2 | шаг <id> "что делаю" | готово <id> | отменить <id> "причина"');
}
