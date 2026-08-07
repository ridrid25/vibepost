/**
 * Задания, оставленные Татьяной через бота.
 *
 * Отдельный скрипт, чтобы дежурному Claude не нужно было знать ни адреса базы,
 * ни ключей: он вызывает три понятные команды, а секреты остаются здесь.
 *
 *   node scripts/задания.mjs список          — что ждёт (задания и доделки)
 *   node scripts/задания.mjs готово <id>     — задание выполнено
 *   node scripts/задания.mjs доделано <id>   — ролик переделан, вернуть во «Входящие»
 *   node scripts/задания.mjs сказать "текст" — написать Татьяне в бота
 */
import { readFileSync, writeFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL?.replace(/\/$/, '');
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

async function бот(текст, разметка) {
  const [p] = await (await fetch(
    `${url}/rest/v1/profiles?error_notify_tg_id=not.is.null` +
    `&select=error_notify_tg_id,error_notify_bot_id&limit=1`, { headers: h })).json();
  const [b] = await (await fetch(
    `${url}/rest/v1/bots?id=eq.${p.error_notify_bot_id}&select=token_secret_id`, { headers: h })).json();
  const token = await (await fetch(`${url}/rest/v1/rpc/get_bot_token`, {
    method: 'POST', headers: h, body: JSON.stringify({ p_secret_id: b.token_secret_id }),
  })).json();
  const r = await (await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: p.error_notify_tg_id, text: текст,
      ...(разметка ? { parse_mode: разметка } : {}),
    }),
  })).json();
  if (!r.ok) throw new Error(r.description);
}

const [команда, ...аргументы] = process.argv.slice(2);

/**
 * Время по-московски — то же, что видит Татьяна в Telegram.
 *
 * В базе всё лежит в UTC. Claude читал его как есть и называл ей время на три
 * часа раньше настоящего: «задание пришло в 13:25», когда на её экране 16:25.
 * Спорить о времени, которого нет у неё на экране, — пустая трата её сил.
 */
function мск(iso) {
  const d = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  const п = (n) => String(n).padStart(2, '0');
  return `${п(d.getUTCDate())}.${п(d.getUTCMonth() + 1)} ${п(d.getUTCHours())}:${п(d.getUTCMinutes())}`;
}

if (команда === 'список') {
  // Отметка «окно Claude открыто и работает». Эту команду вызывает хук на
  // каждом сообщении Татьяны, так что свежесть файла = живой разговор.
  // Приёмник по ней понимает, что поднимать дежурного не надо: иначе два
  // Claude возьмутся за одно задание.
  try {
    writeFileSync(new URL('../claude-alive.txt', import.meta.url), new Date().toISOString());
  } catch { /* отметка не критична — список важнее */ }

  const t = await (await fetch(
    `${url}/rest/v1/claude_tasks?status=eq.new` +
    `&select=id,text,created_at,video_id,incoming_videos(name,measure_avg,measure_worst,video_url)` +
    `&order=created_at`, { headers: h })).json();
  // Ролики, возвращённые кнопкой «↩︎ На доделку», — такое же задание, только
  // пришло из приложения, а не из бота. Разбираются в том же проходе.
  // Замечание, на которое уже ответили и по которому ролик уже обработан,
  // в списке не показываем. Иначе оно висит вечно: доделка от 2 августа
  // «почему нет замеров и титров?» разобрана 3-го, а мозолила глаза 7-го и
  // топила под собой свежие задания. Пометку во «Входящих» при этом не
  // трогаем — снять её может только Татьяна.
  const все = await (await fetch(
    `${url}/rest/v1/incoming_videos?status=eq.rework` +
    `&select=id,name,rework_note,rework_at,rework_ack_at,polished_at&order=rework_at`,
    { headers: h })).json();
  const r = все.filter((v) => !(
    v.rework_ack_at && v.polished_at &&
    new Date(v.rework_ack_at) > new Date(v.rework_at)
  ));

  if (!t.length && !r.length) {
    console.log('НЕТ ЗАДАНИЙ');
  } else {
    for (const z of t) {
      console.log(['ЗАДАНИЕ', z.id, `${мск(z.created_at)} МСК`, z.text].join('	'));
      // Задание почти всегда про ролик, присланный минуту назад. Без этой
      // строчки «Переделываем» читается как задание ни о чём — так и вышло
      // 4 августа со скатом.
      const в = z.incoming_videos;
      if (в) {
        console.log(['        ↳ ролик', z.video_id, в.name,
          `замер ${в.measure_avg ?? '—'}/${в.measure_worst ?? '—'}`, в.video_url].join('	'));
      }
    }
    for (const v of r) {
      console.log(['ДОДЕЛКА', v.id, `${мск(v.rework_at)} МСК`, v.name,
        v.rework_note ?? 'без пояснения'].join('	'));
    }
  }
} else if (команда === 'готово') {
  const id = аргументы[0];
  if (!id) throw new Error('нужен id задания');
  await fetch(`${url}/rest/v1/claude_tasks?id=eq.${id}`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({ status: 'done', done_at: new Date().toISOString() }),
  });
  console.log('отмечено выполненным');
} else if (команда === 'доделано') {
  const id = аргументы[0];
  if (!id) throw new Error('нужен id ролика');
  await fetch(`${url}/rest/v1/incoming_videos?id=eq.${id}`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({ status: 'new', rework_note: null, rework_at: null }),
  });
  console.log('ролик возвращён во «Входящие»');
} else if (команда === 'сказать') {
  const текст = аргументы.join(' ').trim();
  if (!текст) throw new Error('нечего говорить');
  await бот(текст);
  console.log('отправлено в бота');
} else if (команда === 'блок') {
  // Любой текст одним блоком с кнопкой копирования: промпты для Lovable,
  // куски конфигов. Отличается от «промпт» тем, что не разбирает JSON.
  const { readFileSync } = await import('node:fs');
  const [файл, ...подпись] = аргументы;
  if (!файл) throw new Error('нужен путь к файлу');
  const экран = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const шапка = подпись.join(' ').trim() || 'Вставить одним куском:';
  const сообщение = `${экран(шапка)}\n\n<pre>${экран(readFileSync(файл, 'utf8').trim())}</pre>`;
  if (сообщение.length > 4096) {
    throw new Error(`сообщение ${сообщение.length} знаков — предел 4096`);
  }
  await бот(сообщение, 'HTML');
  console.log(`отправлено, ${сообщение.length} знаков`);
} else if (команда === 'промпт') {
  // Промпт уходит одним блоком <pre> — по нему в Telegram есть кнопка
  // «копировать», и Татьяна вставляет его в Gemini одним касанием.
  // Лимит сообщения — 4096 знаков, поэтому JSON шлём без отступов.
  const { readFileSync } = await import('node:fs');
  const [файл, ...подпись] = аргументы;
  if (!файл) throw new Error('нужен путь к json-промпту');
  const компакт = JSON.stringify(JSON.parse(readFileSync(файл, 'utf8')));
  const экран = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const шапка = подпись.join(' ').trim() || 'Промпт. Новый чат в Gemini, вставить одним куском:';
  // Считаем длину готового сообщения, а не одного промпта: предел Telegram —
  // 4096 знаков на всё вместе с шапкой. Глухое число здесь заставляло резать
  // текст промпта вслепую, хотя место ещё оставалось.
  const сообщение = `${экран(шапка)}\n\n<pre>${экран(компакт)}</pre>`;
  if (сообщение.length > 4096) {
    throw new Error(`сообщение ${сообщение.length} знаков — предел 4096. ` +
      `Промпт ${компакт.length}, шапка ${шапка.length}: короче шапку или промпт.`);
  }
  await бот(сообщение, 'HTML');
  console.log(`отправлено, ${компакт.length} знаков`);
} else {
  console.log('команды: список | готово <id> | доделано <id> | сказать "текст" | промпт <файл.json> [подпись]');
}
