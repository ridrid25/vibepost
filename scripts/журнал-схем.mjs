/**
 * Журнал схем движения: какой схемой снят ролик и сколько он собрал.
 *
 *   node scripts/журнал-схем.mjs          — отчёт по тому, что уже записано
 *   node scripts/журнал-схем.mjs записать — определить схемы и записать
 *
 * Зачем. 22.09.2026 заказчица: «ты опять ничего не включил, что мы наблюдаем».
 * Завод считает темы, часы и дни, но не знает, КАК снят ролик. А она руками
 * запретила бригаде бег на камеру — и просмотры выросли с 9 до 1200. То есть
 * решает схема, а мерили мы не её.
 *
 * Этот журнал ничего не запрещает и в генерацию не лезет. Он только пишет
 * рядом с каждым роликом, какой схемой тот снят, чтобы через две недели
 * можно было посмотреть на цифры, а не на догадки.
 *
 * Четыре схемы — из правила 56 журнала роликов:
 *   1. в объектив     — герой бежит или ныряет на камеру, камера пятится;
 *   2. боковой проезд — камера едет вдоль героя, фон рвётся мимо;
 *   3. мир в героя    — герой на месте, предметы и второстепенные летят в линзу;
 *   4. камера кружит  — облёт героя на плотном фоне.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const корень = dirname(dirname(fileURLToPath(import.meta.url)));
const env = {};
for (const с of readFileSync(join(корень, '.env'), 'utf8').split(/\r?\n/)) {
  const m = с.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL.replace(/\/$/, '');
const h = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

/**
 * Схему читаем по битам, а не по одной фразе в motion_rule: 22.09 выяснилось,
 * что счётчик ловил три узких оборота, а бригада писала теми же смыслами
 * другими словами — и двадцать одинаковых промтов прошли как разные.
 */
export function определитьСхему(промт) {
  if (!промт) return null;
  let d;
  try {
    d = typeof промт === 'string' ? JSON.parse(промт) : промт;
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;

  const биты = Array.isArray(d.timeline) ? d.timeline : [];
  const действия = биты.map((б) => String(б?.a ?? '')).join(' | ').toLowerCase();
  const правило = String(d.motion_rule ?? '').toLowerCase();
  const всё = `${правило} ${действия}`;

  // Считаем, сколько битов направлено в объектив: это и есть «бег на камеру»,
  // как бы он ни назывался — lunges, drives, sprints, throws himself.
  const вЛинзу = биты.filter((б) =>
    /(at|into|toward)s? the lens|at camera|into camera/i.test(String(б?.a ?? ''))).length;
  const доля = биты.length ? вЛинзу / биты.length : 0;

  const кружит = /orbit|circles? (the|around)|camera (arcs|swings around)/.test(всё);
  const боком = /alongside|travels? down|tracks? (along|beside)|past (him|her|it)|belt|rail|cart|tray|conveyor/.test(всё);
  const мирВГероя = /(sweep|rake|tear|whip|fly|hurl)[a-z]* (past|across) the lens|into the lens[^|]{0,40}(crate|sheet|paper|pin|box)/.test(всё);

  if (доля >= 0.34) return 'в объектив';
  if (кружит) return 'камера кружит';
  if (боком) return 'боковой проезд';
  if (мирВГероя) return 'мир летит в героя';
  if (вЛинзу > 0) return 'в объектив';
  return 'другая';
}

const записывать = process.argv.includes('записать');

const карточки = await (await fetch(
  `${url}/rest/v1/incoming_videos?select=id,name,prompt,shema_dvizheniya,created_at` +
  `&prompt=not.is.null&order=created_at.desc&limit=400`,
  { headers: h },
)).json();

let определено = 0;
const счёт = new Map();
for (const к of карточки) {
  const схема = определитьСхему(к.prompt);
  if (!схема) continue;
  счёт.set(схема, (счёт.get(схема) ?? 0) + 1);
  if (записывать && к.shema_dvizheniya !== схема) {
    await fetch(`${url}/rest/v1/incoming_videos?id=eq.${к.id}`, {
      method: 'PATCH', headers: h, body: JSON.stringify({ shema_dvizheniya: схема }),
    });
    определено++;
  }
}

console.log(записывать
  ? `записано схем: ${определено} из ${карточки.length} карточек с промтом`
  : `разобрано карточек: ${карточки.length} (запустите с «записать»)`);
console.log('\nсколько чем снято:');
for (const [схема, сколько] of [...счёт.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${схема.padEnd(20)} ${сколько}`);
}
