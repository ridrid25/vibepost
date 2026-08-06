/**
 * Проверка живых путей: делает то же, что делают кнопки бота, и говорит,
 * что сломано. Запуск: node scripts/проверка.mjs
 *
 * Зачем. 7 августа Татьяна выбрала идею в боте, бот ответил «Идею принял»,
 * а задание в базу не записалось: функция не читала поле владельца, а отказ
 * базы никто не проверял. Идея пропала молча, Татьяна ждала промт, которого
 * никто не писал.
 *
 * Публикация функции не значит, что она работает. Работает — значит прошла
 * эту проверку. Все пробные записи убираются сразу.
 */
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const env = {};
for (const line of readFileSync(new URL('.env', root), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL?.replace(/\/$/, '');
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('В .env не хватает доступа к базе.');
  process.exit(1);
}
const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

let сломано = 0;
const убрать = [];

function итог(имя, ок, пояснение = '') {
  console.log(`${ок ? '  ок  ' : ' СЛОМАНО'}  ${имя}${пояснение ? ' — ' + пояснение : ''}`);
  if (!ок) сломано++;
}

const [профиль] = await (await fetch(
  `${url}/rest/v1/profiles?error_notify_tg_id=not.is.null&select=id,error_notify_bot_id`,
  { headers: h },
)).json();

if (!профиль) {
  console.error('Не найден профиль владельца — проверять нечего.');
  process.exit(1);
}

console.log('\nПРОВЕРКА ПУТЕЙ\n');

// 1. Задание записывается. Именно здесь 7 августа пропала идея.
{
  const r = await fetch(`${url}/rest/v1/claude_tasks`, {
    method: 'POST', headers: { ...h, Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: профиль.id, text: 'проверка путей, удалить' }),
  });
  const [строка] = r.ok ? await r.json() : [null];
  итог('задание записывается', r.ok, r.ok ? '' : `база отвечает ${r.status}`);
  if (строка) убрать.push(['claude_tasks', строка.id]);
}

// 2. Функции бота отвечают, а не лежат.
for (const имя of ['telegram-webhook', 'video-from-bot', 'idea-button', 'hook-options']) {
  try {
    const r = await fetch(`${url}/functions/v1/${имя}`, {
      method: 'POST', headers: h, body: JSON.stringify({}),
    });
    итог(`функция ${имя}`, r.status < 500, r.status >= 500 ? `отвечает ${r.status}` : '');
  } catch (e) {
    итог(`функция ${имя}`, false, String(e.message).slice(0, 60));
  }
}

// 3. Токен бота достаётся из хранилища — без него бот молчит.
{
  const [бот] = await (await fetch(
    `${url}/rest/v1/bots?id=eq.${профиль.error_notify_bot_id}&select=token_secret_id`,
    { headers: h },
  )).json();
  const токен = await (await fetch(`${url}/rest/v1/rpc/get_bot_token`, {
    method: 'POST', headers: h, body: JSON.stringify({ p_secret_id: бот?.token_secret_id }),
  })).json();
  итог('токен бота достаётся', typeof токен === 'string' && токен.length > 20);
}

// 4. Приёмник запущен — без него нет ни замеров, ни титров.
{
  const { execSync } = await import('node:child_process');
  let живой = false;
  try {
    живой = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | ' +
      'Where-Object { $_.CommandLine -like \'*watch-videos*\' } | Measure-Object).Count"',
      { encoding: 'utf8' },
    ).trim() !== '0';
  } catch { /* не Windows либо powershell недоступен */ }
  итог('приёмник роликов запущен', живой, живой ? '' : 'запустите «Приёмник.vbs»');
}

// 5. Ролики не застряли без решения дольше суток.
{
  const сутки = new Date(Date.now() - 24 * 3600e3).toISOString();
  const зависшие = await (await fetch(
    `${url}/rest/v1/incoming_videos?status=eq.new&polished_at=is.null&created_at=lt.${сутки}` +
    `&select=name&limit=5`, { headers: h },
  )).json();
  итог('нет роликов, забытых больше суток', зависшие.length === 0,
    зависшие.length ? `${зависшие.length} шт.` : '');
}

for (const [таблица, id] of убрать) {
  await fetch(`${url}/rest/v1/${таблица}?id=eq.${id}`, { method: 'DELETE', headers: h });
}

console.log(сломано
  ? `\nСЛОМАНО: ${сломано}. Чинить до того, как Татьяна это заметит.\n`
  : '\nВсё работает.\n');
process.exit(сломано ? 1 : 0);
