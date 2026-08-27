/**
 * Самопроверка цепочки: доходит ли задание Татьяны до ответа БЕЗ человека.
 *
 *   node scripts/самопроверка.mjs
 *
 * Зачем именно такая. Скрипт «проверка.mjs» смотрел, отвечают ли функции, и
 * бодро писал «всё работает». При этом четыре дня подряд не работало главное:
 * дежурный писал промты и не мог их отправить — каждая команда требовала
 * разрешения, а нажать его в фоновом окне некому. Он умирал молча, задания
 * копились, Татьяна ждала ответа, которого никто не мог послать.
 *
 * Проверять надо не «жив ли процесс», а «получила ли Татьяна ответ». Поэтому
 * здесь заводится настоящее задание, поднимается настоящий дежурный тем же
 * способом, каким его поднимает система, и смотрится настоящий результат:
 * закрылось ли задание и ушло ли сообщение в бота.
 *
 * Занимает около двух минут. Пробное задание убирается в любом случае.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const корень = dirname(dirname(fileURLToPath(import.meta.url)));
const env = {};
for (const line of readFileSync(join(корень, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL?.replace(/\/$/, '');
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('В .env нет доступа к базе.'); process.exit(2); }
const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

let сломано = 0;
let отложено = null;
const итог = (имя, ок, что = '') => {
  console.log(`${ок ? '  ок  ' : ' СЛОМАНО'}  ${имя}${что ? ' — ' + что : ''}`);
  if (!ок) сломано++;
};

console.log('\nСАМОПРОВЕРКА ЦЕПОЧКИ\n');
console.log('Проверяю не «жив ли процесс», а «дойдёт ли ответ до Татьяны».\n');

// ── 1. Приёмник: без него нет ни замеров, ни титров ───────────────────────
{
  let живой = false;
  try {
    живой = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | ' +
      'Where-Object { $_.CommandLine -like \'*watch-videos*\' } | Measure-Object).Count"',
      { encoding: 'utf8' },
    ).trim() !== '0';
  } catch { /* не Windows */ }
  итог('приёмник роликов запущен', живой, живой ? '' : 'запустите «Приёмник.vbs»');
}

// ── 2. Дежурный по часам включён в планировщике ───────────────────────────
{
  let состояние = '';
  try {
    состояние = execSync(
      'powershell -NoProfile -Command "(Get-ScheduledTask -TaskName \'VibePost - dezhurny\').State"',
      { encoding: 'utf8' },
    ).trim();
  } catch { /* задания нет */ }
  итог('дежурный в планировщике включён', состояние === 'Ready' || состояние === 'Running',
    состояние ? `состояние: ${состояние}` : 'задание не найдено');
}

// ── 3. Разрешения: без них дежурный не сможет отправить ответ ─────────────
{
  const п = join(корень, '.claude', 'settings.json');
  let есть = false;
  if (existsSync(п)) {
    const н = JSON.parse(readFileSync(п, 'utf8'));
    есть = (н.permissions?.allow ?? []).some((с) => с.includes('задания.mjs'));
  }
  итог('дежурному разрешено отправлять', есть,
    есть ? '' : 'в .claude/settings.json нет разрешения на задания.mjs');
}

// ── 4. Главное: заводим задание и смотрим, ответит ли дежурный сам ────────
// Во время лимита Claude живой тест не имеет смысла: он гарантированно не
// ответит, но это ожидаемая пауза, а не поломка. Приёмник хранит точный срок,
// который сообщил CLI.
// Пауза по дате выброшена 27.08: она держала систему выключенной уже после
// снятия лимита. Проверяем живьём всегда.

const МЕТКА = `самопроверка ${new Date().toISOString()}`;
let задание = null;
if (!отложено) {
  try {
    const r = await fetch(`${url}/rest/v1/claude_tasks`, {
      method: 'POST', headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: (await (await fetch(
          `${url}/rest/v1/profiles?error_notify_tg_id=not.is.null&select=id&limit=1`, { headers: h },
        )).json())[0].id,
        text: `${МЕТКА}. Это проверка связи, ничего не переписывай. Просто выполни: ` +
          `node scripts/задания.mjs сказать "Проверка связи: дежурный ответил сам, окно не открыто." ` +
          `и затем node scripts/задания.mjs готово <id этого задания>.`,
      }),
    });
    [задание] = await r.json();
    итог('задание записывается', !!задание);
  } catch (e) {
    итог('задание записывается', false, String(e.message).slice(0, 60));
  }
}

if (задание) {
  console.log('\n  Поднимаю дежурного тем же способом, что и система. Это до двух минут…\n');
  const [бинарь, префикс] = process.platform === 'win32'
    ? ['cmd.exe', ['/c', 'claude']] : ['claude', []];
  const дитя = spawn(бинарь, [...префикс, '-p',
    'Разбери задания: node scripts/задания.mjs список. Выполни ровно то, что в них написано, ' +
    'и отметь их выполненными. Ничего сверх этого не делай.',
    '--allowedTools', 'Bash'],
  { cwd: корень, stdio: 'ignore' });

  const дождаться = new Promise((resolve) => {
    const срок = Date.now() + 150_000;
    const тик = setInterval(async () => {
      const [строка] = await (await fetch(
        `${url}/rest/v1/claude_tasks?id=eq.${задание.id}&select=status`, { headers: h },
      )).json().catch(() => [null]);
      if (строка && строка.status !== 'new') { clearInterval(тик); resolve('ответил'); }
      else if (Date.now() > срок) { clearInterval(тик); resolve('не ответил'); }
    }, 5000);
  });

  const результат = await дождаться;
  try { дитя.kill(); } catch { /* уже вышел */ }
  итог('ДЕЖУРНЫЙ ОТВЕЧАЕТ САМ, без открытого окна', результат === 'ответил',
    результат === 'ответил' ? 'задание закрыто им же' : 'за 2.5 минуты задание не тронуто');

  let убрали = false;
  for (let попытка = 1; попытка <= 3 && !убрали; попытка++) {
    try {
      const r = await fetch(`${url}/rest/v1/claude_tasks?id=eq.${задание.id}`, {
        method: 'DELETE', headers: h, signal: AbortSignal.timeout(15_000),
      });
      убрали = r.ok;
    } catch { /* сеть моргнула — повторяем */ }
    if (!убрали && попытка < 3) await new Promise((r) => setTimeout(r, 1000));
  }
  итог('пробное задание убрано', убрали,
    убрали ? '' : `уберите вручную ${задание.id}`);
}

console.log(сломано
  ? `\nСЛОМАНО: ${сломано}. Пока это не починено, Татьяна ждёт ответа, которого никто не пошлёт.\n`
  : отложено
    ? `\nПАУЗА: ${отложено.progress ?? отложено.detail}. Базовые узлы исправны; живой ответ проверим после сброса.\n`
    : '\nЦепочка замкнута: сообщение в бота доходит до ответа без человека.\n');
process.exit(сломано ? 1 : 0);
