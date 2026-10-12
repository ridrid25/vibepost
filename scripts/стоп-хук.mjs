/**
 * Хук завершения: не даёт Claude закончить ответ, пока есть непрочитанные
 * задания.
 *
 * Список заданий подставляется только в момент сообщения Татьяны. Пока Claude
 * работает — а это бывает и двадцать минут, — новое задание лежит незамеченным.
 * 4 августа так и вышло: задание про богомола пришло в 16:25, Claude в это
 * время работал и увидел его только после её вопроса.
 *
 * Теперь перед завершением ответа проверяется список. Есть задание, которое
 * Claude ещё не видел, — его возвращают в работу.
 *
 * Чтобы не зациклиться, помним разобранные id в «.задания-показаны». Блокируем
 * ровно один раз на задание: если Claude его увидел и всё равно не сделал —
 * это уже его решение, а не пропуск.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const корень = dirname(dirname(fileURLToPath(import.meta.url)));
const памятка = join(корень, '.задания-показаны');

const env = {};
for (const line of readFileSync(join(корень, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL?.replace(/\/$/, '');
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) process.exit(0); // без доступа к базе просто не мешаем

const h = { apikey: key, Authorization: `Bearer ${key}` };

let задания = [];
let доделки = [];
try {
  задания = await (await fetch(
    `${url}/rest/v1/claude_tasks?status=eq.new&select=id,text&order=created_at`,
    { headers: h },
  )).json();
  доделки = await (await fetch(
    `${url}/rest/v1/incoming_videos?status=eq.rework&select=id,name,rework_note&order=rework_at`,
    { headers: h },
  )).json();
} catch {
  process.exit(0); // сеть моргнула — не мешаем закончить ответ
}
if (!Array.isArray(задания)) задания = [];
if (!Array.isArray(доделки)) доделки = [];

const показаны = new Set(
  existsSync(памятка) ? readFileSync(памятка, 'utf8').split('\n').filter(Boolean) : [],
);
const новые = [
  ...задания.filter((z) => !показаны.has(z.id))
    .map((z) => `ЗАДАНИЕ ${z.id}: ${String(z.text).replace(/\s+/g, ' ').slice(0, 120)}`),
  ...доделки.filter((v) => !показаны.has(`rw:${v.id}`))
    .map((v) => `ДОДЕЛКА ${v.id} «${v.name}»: ${String(v.rework_note ?? '').slice(0, 120)}`),
];

if (!новые.length) process.exit(0);

writeFileSync(памятка, [
  ...показаны,
  ...задания.map((z) => z.id),
  ...доделки.map((v) => `rw:${v.id}`),
].join('\n'), 'utf8');

console.log(JSON.stringify({
  decision: 'block',
  reason:
    'Пока вы работали, пришло непрочитанное. Разберите это прежде чем ' +
    'отвечать Татьяне:\n\n' + новые.join('\n') +
    '\n\nПорядок работы — docs/07_ПРАВИЛА.md, раздел «ПУТЬ РОЛИКА». ' +
    'Промт пишет БРИГАДА, всегда и с первого раза (решение заказчицы 12.10.2026): ' +
    'режиссёр → оператор → scripts/промт-проверка.mjs → критик → правки → счётчик → бот. ' +
    'Порядок — CLAUDE.md, раздел «Промты роликов — ВСЕГДА через бригаду».',
}));
