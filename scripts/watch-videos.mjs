/**
 * Папка-приёмник роликов для VibePost.
 *
 * Рабочий стол → «Ролики VibePost»:
 *   1 Промпты          — задания от Claude: один файл = один будущий ролик
 *   1 Промпты/Сделай платно — сюда перетаскивается промпт, который генерит Claude
 *   2 Готовые          — сюда кладутся скачанные ролики. Звук остаётся родной
 *   2 Готовые/Переозвучить — то же, но голос переклеивается на Дмитрия
 *   3 Ушло в постинг   — архив: ролик и его задание после успешной отправки
 *   Ошибка             — что не удалось отправить
 *
 * Что делает с каждым роликом:
 *   1. Горизонтальный приводит к вертикали 720x1280 (размытая подложка,
 *      ничего не обрезается). Приложение Gemini умеет отдавать 16:9, даже
 *      когда в промпте написано обратное — формат там задаётся настройкой.
 *   2. Если ролик лежал в «Переозвучить» — меняет звук на голос Дмитрия,
 *      подгоняя речь под то, как шевелится рот (см. dub.mjs соседнего проекта).
 *      По умолчанию звук НЕ трогается: у роликов из приложения липсинк родной
 *      и лучше любого нашего.
 *   3. Отправляет в Edge Function ingest-video — ролик появляется во «Входящих».
 *
 * Название и подпись берутся: из файла-задания в «1 Промпты» с тем же номером
 * либо из таблицы video_ideas по имени файла (slug идеи из бота).
 *
 * Запуск: двойной клик по «Ролики в VibePost.bat» в папке проекта.
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, statSync, renameSync, rmSync,
} from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { причинаОстановкиClaude } from './lib/claude-availability.mjs';
import { parseMeaningReview, assessVideoMeasurement } from './lib/video-meaning.mjs';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);
// Темп опроса — главный расход трафика всего проекта. При 5 с и девяти
// запросах на тик уходило ~400 МБ в сутки при лимите Free 5 ГБ в месяц, и
// проект вставал 29.09 и встал бы снова ~19.10. Решение заказчицы 07.10.2026
// (вариант «В»): её вещи — задания, замечания, ролики из бота, полоса — раз
// в 10 с; внутренняя кухня (титры, описания, полоса заданий, теги ТикТока) —
// раз в минуту. Папки на диске смотрим каждый тик: это трафика не стоит.
const POLL_MS = 10000;
const КОНВЕЙЕР_МС = 60000;
// Модуль озвучки живёт в соседнем проекте «Генерация роликов» — там же его
// зависимости (msedge-tts).
const DUB_MODULE = join(
  homedir(), 'Downloads', 'Обучение', 'CLAUD', 'Генерация роликов',
  'scripts', 'lib', 'dub.mjs',
);
// Постобработка: распознавание речи → титры по словам → петля. Питоновский
// пакет живёт в том же соседнем проекте, вместе со шрифтом и настройками.
const POSTPROD_DIR = join(
  homedir(), 'Downloads', 'Обучение', 'CLAUD', 'Генерация роликов',
  'video-postprod_v1',
);

const stableSizes = new Map();

const root = new URL('..', import.meta.url);
const env = {};
for (const line of readFileSync(new URL('.env', root), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

// Норма приёмки по динамике. Те же числа, по которым судит check.py, —
// иначе отчёт в боте и вердикт скрипта расходятся.
const НОРМА_СРЕДНЕЕ = 18;
const НОРМА_ХУДШАЯ = 9;

const url = env.SUPABASE_URL?.replace(/\/$/, '');
const secret = env.INGEST_SECRET;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !secret) {
  console.error('В .env не хватает SUPABASE_URL или INGEST_SECRET.');
  process.exit(1);
}

const base = env.WATCH_DIR || join(homedir(), 'Desktop', 'Ролики VibePost');
const promptDir = join(base, '1 Промпты');
const readyDir = join(base, '2 Готовые');
const dubDir = join(readyDir, 'Переозвучить');
// Сюда кладутся ролики, у которых текст уже нарисован самой видеомоделью:
// второй слой титров поверх первого превращается в кашу.
const noSubsDir = join(readyDir, 'Без титров');
const doneDir = join(base, '3 Ушло в постинг');
const failDir = join(base, 'Ошибка');
for (const dir of [promptDir, join(promptDir, 'Сделай платно'), readyDir, dubDir, noSubsDir, doneDir, failDir]) {
  mkdirSync(dir, { recursive: true });
}

// Одна копия за раз. Две запущенные хватаются за один файл и мешают друг другу.
const lockFile = join(base, '.приёмник-работает');
try {
  const прошлый = Number(readFileSync(lockFile, 'utf8'));
  process.kill(прошлый, 0); // не убивает, только проверяет, жив ли процесс
  console.error('Приёмник уже запущен в другом окне. Закройте его или пользуйтесь тем.');
  process.exit(1);
} catch {
  /* замка нет либо процесс из него давно умер — можно работать */
}
writeFileSync(lockFile, String(process.pid));
const снятьЗамок = () => {
  try {
    rmSync(lockFile, { force: true });
  } catch { /* уже убрали */ }
};
process.on('exit', снятьЗамок);
for (const сигнал of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(сигнал, () => { снятьЗамок(); process.exit(0); });
}

// Приёмник должен висеть весь день, поэтому не падаем ни от чего. Библиотека
// озвучки, например, умеет бросать ошибку из своего обработчика уже после того,
// как мы разобрались со сбоем, — снаружи её не поймать никаким try.
process.on('uncaughtException', (e) => {
  console.log(`\n[сбой, продолжаю работать] ${e?.message ?? e}`);
});
process.on('unhandledRejection', (e) => {
  console.log(`\n[сбой, продолжаю работать] ${e?.message ?? e}`);
});

console.log('Папка-приёмник роликов VibePost');
console.log(`Слежу за папкой: ${readyDir}`);
console.log('Родной звук сохраняется. Нужен голос Дмитрия — кладите в «Переозвучить».');
// Приёмник поднимается сам при входе в систему и работает без окна
// («Приёмник.vbs» лежит в автозагрузке, вывод пишется в priyomnik.log).
// Эта строка видна, только если запустить его вручную.
console.log('Работаю. Остановить — «Стоп приёмника.cmd».\n');

/** Запускает ffmpeg/ffprobe/python и отдаёт stdout. */
function run(bin, args, опции = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...опции });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(err.slice(-400))),
    );
  });
}

async function размеры(file) {
  const out = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ]);
  const [w, h] = out.split(',').map(Number);
  return { w, h };
}

/** Горизонтальный ролик → вертикальный 720x1280 с размытой подложкой. */
async function вВертикаль(input) {
  const out = join(tmpdir(), `vp-${Date.now()}-${basename(input)}`);
  await run('ffmpeg', [
    '-v', 'error', '-y', '-i', input,
    '-filter_complex',
    '[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,' +
      'gblur=sigma=28,eq=brightness=-0.06[bg];[0:v]scale=720:-2[fg];' +
      '[bg][fg]overlay=(W-w)/2:(H-h)/2[v]',
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart', out,
  ]);
  return out;
}

/**
 * Читает название и подпись: сначала из файла-задания в «1 Промпты»
 * (достаточно назвать ролик номером задания), потом из базы по slug идеи.
 */
async function метаданные(videoPath) {
  const stem = basename(videoPath, extname(videoPath));

  let taskPath = join(promptDir, `${stem}.txt`);
  if (!existsSync(taskPath)) {
    const num = stem.match(/^\s*(\d+)/)?.[1];
    const match = num
      ? readdirSync(promptDir).find((f) => f.endsWith('.txt') && f.match(/^\s*(\d+)/)?.[1] === num)
      : null;
    taskPath = match ? join(promptDir, match) : null;
  }
  if (taskPath) {
    const text = readFileSync(taskPath, 'utf8');
    const pick = (label) => text.match(new RegExp(`^${label}:\\s*(.+)$`, 'im'))?.[1]?.trim();
    return { taskPath, name: pick('НАЗВАНИЕ'), caption: pick('ПОДПИСЬ') };
  }

  // Идея из бота: имя файла = slug. Забираем реплику и хук из базы.
  if (serviceKey) {
    try {
      const res = await fetch(
        `${url}/rest/v1/video_ideas?slug=eq.${encodeURIComponent(stem)}&select=hook,line,animal&limit=1`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
      );
      const [idea] = await res.json();
      if (idea) return { taskPath: null, name: `${idea.animal} — ${idea.hook}`, caption: idea.line };
    } catch {
      /* база недоступна — обойдёмся именем файла */
    }
  }
  return { taskPath: null };
}

async function send(filePath, meta, origName) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(filePath)], { type: 'video/mp4' }), basename(filePath));
  form.append('name', meta.name || basename(origName, extname(origName)));
  form.append('source', 'папка «Ролики VibePost»');
  if (meta.caption) form.append('caption', meta.caption);

  const res = await fetch(`${url}/functions/v1/ingest-video`, {
    method: 'POST',
    headers: { 'x-ingest-secret': secret },
    body: form,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Переносит файл в архив, не затирая уже лежащий там одноимённый.
 * К имени приписывается, что с роликом сделали, — иначе в архиве лежат
 * два одинаковых с виду файла и непонятно, чем они отличаются.
 */
function moveTo(dir, filePath, пометка = '') {
  const ext = extname(filePath);
  const stem = basename(filePath, ext) + (пометка ? ` (${пометка})` : '');
  let target = join(dir, stem + ext);
  for (let i = 1; existsSync(target); i++) {
    target = join(dir, `${stem}-${i}${ext}`);
  }
  renameSync(filePath, target);
  const caption = filePath.replace(/\.[^.]+$/, '.txt');
  if (existsSync(caption)) renameSync(caption, target.replace(/\.[^.]+$/, '.txt'));
}

// Python на Windows печатает русский в кодировке консоли, и разбор вывода
// по русским словам тогда не совпадает. Просим UTF-8 явно.
const ПИТОН = { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } };

/** Короткое сообщение Татьяне в бота. Молча падает, если бот недоступен. */
async function вБота(текст, кнопки) {
  try {
    const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
    const [p] = await (await fetch(
      `${url}/rest/v1/profiles?error_notify_tg_id=not.is.null` +
      `&select=error_notify_tg_id,error_notify_bot_id&limit=1`, { headers: h })).json();
    const [b] = await (await fetch(
      `${url}/rest/v1/bots?id=eq.${p.error_notify_bot_id}&select=token_secret_id`, { headers: h })).json();
    const token = await (await fetch(`${url}/rest/v1/rpc/get_bot_token`, {
      method: 'POST', headers: h, body: JSON.stringify({ p_secret_id: b.token_secret_id }),
    })).json();
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: p.error_notify_tg_id, text: текст,
        ...(кнопки ? { reply_markup: { inline_keyboard: кнопки } } : {}),
      }),
    });
  } catch { /* без связи — не беда, обработка важнее */ }
}

/**
 * Полоса хода работы в боте.
 *
 * Пока бригада пишет промт, окно разговора молчит по пятнадцать минут, и
 * Татьяна не отличает работу от зависшего компьютера. Строку дела заводит
 * Claude (scripts/ход.mjs), но двигать полосу он не может — он в это время
 * занят. Двигает приёмник: он и так опрашивает базу каждые пять секунд.
 *
 * Правим одно и то же сообщение, а не шлём новые: иначе бот засыплет её
 * лентой из сорока одинаковых полос. Раз в 15 секунд — Telegram разрешает
 * около двадцати правок в минуту на чат, берём с большим запасом.
 */
const ЧАСЫ = ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛'];
let кадрПолосы = 0;
let тиковДоПравки = 0;
let ботКэш = null;

async function ботДоступ() {
  if (ботКэш) return ботКэш;
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const [p] = await (await fetch(
    `${url}/rest/v1/profiles?error_notify_tg_id=not.is.null` +
    `&select=error_notify_tg_id,error_notify_bot_id&limit=1`, { headers: h })).json();
  const [b] = await (await fetch(
    `${url}/rest/v1/bots?id=eq.${p.error_notify_bot_id}&select=token_secret_id`, { headers: h })).json();
  const token = await (await fetch(`${url}/rest/v1/rpc/get_bot_token`, {
    method: 'POST', headers: h, body: JSON.stringify({ p_secret_id: b.token_secret_id }),
  })).json();
  ботКэш = { token, chat: p.error_notify_tg_id, h };
  return ботКэш;
}

function текстПолосы(дело, кадр) {
  const всего = дело.stages.length;
  const сделано = Math.max(0, Math.min(дело.step, всего));
  const ЯЧЕЕК = 10;
  const залито = Math.round((сделано / всего) * ЯЧЕЕК);
  let бар = '▰'.repeat(залито);
  if (дело.done_at) {
    бар = '▰'.repeat(ЯЧЕЕК);
  } else {
    // Огонёк бежит по незалитой части — это и есть признак жизни.
    const пусто = ЯЧЕЕК - залито;
    const где = пусто ? кадр % пусто : 0;
    бар += Array.from({ length: пусто }, (_, i) => (i === где ? '◆' : '▱')).join('');
  }

  const строки = дело.stages.map((имя, i) => {
    if (i < сделано) return `✅ ${имя}`;
    if (i === сделано && !дело.done_at) return `🔸 ${имя}${дело.note ? ` — ${дело.note}` : ''}`;
    return `▫️ ${имя}`;
  });

  const мин = Math.max(1, Math.round((Date.now() - new Date(дело.started_at).getTime()) / 60000));
  const наЭтапе = Math.round((Date.now() - new Date(дело.updated_at).getTime()) / 60000);
  const шапка = дело.done_at
    ? `✅ ${дело.title}`
    : `${ЧАСЫ[кадр % ЧАСЫ.length]} ${дело.title}`;

  // Честность про застрявший этап. Полоса, которая бодро бежит, пока этап не
  // двигался двадцать минут, — обман хуже молчания: 8 августа она показывала
  // «0/4, начинаю» через десять минут после начала, потому что этап никто не
  // переключил. Пусть лучше прямо говорит, что движения нет.
  const низ = дело.done_at
    ? `${дело.outcome === 'готово' ? 'Готово' : дело.outcome} · заняло ${мин} мин`
    : наЭтапе >= 12
      ? `идёт ${мин} мин · этап не двигался ${наЭтапе} мин — это дольше обычного`
      : `идёт ${мин} мин${наЭтапе >= 3 ? `, на этапе ${наЭтапе}` : ''} · работа пишется`;

  return `${шапка}\n\n${бар}  ${сделано}/${всего}\n\n${строки.join('\n')}\n\n${низ}`;
}

async function двигатьПолосу() {
  if (!url || !serviceKey) return;
  if (тиковДоПравки-- > 0) return;
  тиковДоПравки = 2;                       // раз в 15 секунд при опросе в 5

  let дела;
  try {
    const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    дела = await (await fetch(
      `${url}/rest/v1/work_progress?or=(done_at.is.null,and(done_at.not.is.null,tg_message_id.not.is.null))` +
      `&order=started_at.desc&limit=3`, { headers: h })).json();
  } catch {
    return;
  }
  if (!Array.isArray(дела) || !дела.length) return;

  кадрПолосы++;
  for (const дело of дела) {
    // Законченное дело правим один раз — и снимаем номер сообщения, чтобы
    // больше к нему не возвращаться.
    if (дело.done_at && !дело.tg_message_id) continue;

    let доступ;
    try { доступ = await ботДоступ(); } catch { return; }
    const текст = текстПолосы(дело, кадрПолосы);

    try {
      if (!дело.tg_message_id) {
        const r = await (await fetch(`https://api.telegram.org/bot${доступ.token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: доступ.chat, text: текст }),
        })).json();
        if (r?.result?.message_id) {
          await fetch(`${url}/rest/v1/work_progress?id=eq.${дело.id}`, {
            method: 'PATCH', headers: доступ.h,
            body: JSON.stringify({ tg_message_id: r.result.message_id }),
          });
        }
      } else {
        await fetch(`https://api.telegram.org/bot${доступ.token}/editMessageText`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: доступ.chat, message_id: дело.tg_message_id, text: текст,
          }),
        });
        if (дело.done_at) {
          await fetch(`${url}/rest/v1/work_progress?id=eq.${дело.id}`, {
            method: 'PATCH', headers: доступ.h, body: JSON.stringify({ tg_message_id: null }),
          });
        }
      }
    } catch { /* связь моргнула — поправим на следующем тике */ }
  }
}

/**
 * Замер динамики — первым делом, до всякой обработки.
 *
 * Смысл: если ролик слабый по удержанию, Татьяна должна узнать это сразу и
 * решить — оставляем или переделываем. Вешать титры на заведомо провальный
 * ролик и только потом показывать числа — трата её времени.
 *
 * Ориентиры из CLAUDE.md: среднее 20+, худшая секунда не ниже 10.
 */
async function замер(input, имя, id) {
  let вывод;
  try {
    вывод = await run('python', [join(POSTPROD_DIR, 'measure.py'), input], ПИТОН);
  } catch (e) {
    console.log(`   [замер не вышел] ${String(e.message).slice(0, 100)}`);
    return null;
  }

  const среднее = Number(вывод.match(/среднее\s+([\d.]+)/)?.[1] ?? NaN);
  const худшая = Number(вывод.match(/худшая сек\s+([\d.]+)/)?.[1] ?? NaN);
  const склеек = Number(вывод.match(/склеек\s+(\d+)/)?.[1] ?? 0);
  const совет = вывод.match(/переписывать сегмент ([\d.]+-[\d.]+)/)?.[1] ?? null;
  if (Number.isNaN(среднее)) return null;

  // 28.10.2026, заказчица: «Бригада не обращает внимание на 0 сек… и крючка в
  // конце нет». Промты их содержат, генератор не играет: старт стоит, финал
  // замирает. Среднее этого не видит — края меряются отдельно. На норму и
  // решение «годится» не влияют (расчёт она велела не трогать до 31.10).
  let краяВывод = '';
  try {
    краяВывод = await run('python', [join(dirname(fileURLToPath(import.meta.url)), 'kraya.py'), input], ПИТОН);
  } catch { /* края не вышли — замер всё равно идёт */ }
  const стартСтоит = /старт\s+[\d.]+\s+стоит/.test(краяВывод);
  const финалЗамер = /финал\s+[\d.]+\s+замер/.test(краяВывод);
  const краяИзвестны = /старт/.test(краяВывод);

  // Порог приёмки — тот же, по которому судит check.py: 18 и 9. Двадцатка
  // с десяткой были «ориентиром», и от этого числа в отчёте противоречили
  // вердикту. Норма в проекте одна.
  // 26.10.2026, заказчица: «Добавь строку смысл прошёл/не прошёл, и тогда
  // числа не будут в норме». Смысл даёт разбор Gemini из video-from-bot: он
  // приходит раньше замера и кончается строкой «Смысл: прошёл / не прошёл —».
  let смысл = null;
  let текстРазбора = "";
  if (id && url && serviceKey) {
    // Разбор обычно уже готов; если нет — ждём до минуты, потом «не проверен».
    for (let попытка = 0; попытка < 6 && !смысл; попытка++) {
      try {
        const [к] = await (await fetch(`${url}/rest/v1/incoming_videos?id=eq.${id}&select=review`, {
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        })).json();
        текстРазбора = String(к?.review ?? '');
        смысл = parseMeaningReview(текстРазбора).label;
        if (смысл || /Смысл:/i.test(String(к?.review ?? ''))) break;
        if (к?.review) break;       // старый разбор без строки смысла — не ждём
      } catch { break; }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  const оценка = assessVideoMeasurement(среднее, худшая, текстРазбора,
    { average: НОРМА_СРЕДНЕЕ, worst: НОРМА_ХУДШАЯ });
  const смыслНе = оценка.meaningState === 'failed';
  const числаВНорме = оценка.numbersPassed;
  const смыслНеПроверен = оценка.needsMeaningReview;
  const годится = оценка.accepted;
  console.log(`   замер: среднее ${среднее}, худшая ${худшая}, склеек ${склеек}, смысл: ${смысл ?? 'нет'}`);

  await вБота(
    `📏 Замер: ${имя}\n\n` +
    `Среднее: ${среднее}  (норма ${НОРМА_СРЕДНЕЕ}+)\n` +
    `Худшая секунда: ${худшая}  (норма ${НОРМА_ХУДШАЯ}+)\n` +
    `Склеек: ${склеек}\n` +
    `Смысл: ${смысл ?? 'не проверен'}\n` +
    (краяИзвестны
      ? `0 сек: ${стартСтоит ? 'камера стоит ⚠️' : 'движется'}\n` +
        `Крючок в конце: ${финалЗамер ? 'замер ⚠️' : 'движется'}\n`
      : '') + '\n' +
    (годится
      ? 'Числа в норме — по динамике вопросов нет.\n\nПосмотрите ролик и нажмите кнопку.'
      : смыслНеПроверен
      ? 'Числа в норме, но смысл не проверен. Это ещё не успешная приёмка. Проверю существующий разбор; новый ролик для этого не нужен.\n\nПосмотрите ролик и нажмите кнопку.'
      : `Ниже нормы${!числаВНорме && совет ? `, провал на ${совет} с` : ''}` +
        `${смыслНе ? ' — смысл не прошёл' : ''}.\n\n` +
        'Промт перепишу — вашего разрешения на это не нужно. ' +
        'Но если у вас есть мысль, каким должен быть кадр, скажите: сделаю по-вашему.'),
    // Кнопки несут в себе id ролика. Без них Татьяна пишет замечание, не зная,
    // к чему оно прилипнет: бот угадывал ролик по времени присылки.
    //
    // Ниже нормы кнопки другие. Раньше там висело «Годится / Не годится» под
    // текстом «переписываю сам» — одно отменяло другое, и Татьяна не понимала,
    // ждут от неё чего-то или нет. Теперь выбор честный: взять вопреки числам,
    // сказать своё или отдать переписывание целиком.
    // «Поправь звук» — отдельно от «Не годится». Не всякая беда стоит нового
    // промта: чаще всего испорчено одно слово или ударение, а картинка хороша.
    // Пересъёмка ради этого — сожжённая генерация и риск потерять то, что уже
    // получилось. Звук чинится донором из прошлого дубля, за минуту.
    !id ? undefined : годится ? [
      [{ text: '✅ Годится', callback_data: `vid:ok:${id}` }],
      [{ text: '🔊 Поправь звук', callback_data: `vid:snd:${id}` }],
      [{ text: '✏️ Не годится', callback_data: `vid:no:${id}` }],
    ] : [
      [{ text: '✍️ У меня есть мысль', callback_data: `vid:no:${id}` }],
      [{ text: '🔊 Поправь звук', callback_data: `vid:snd:${id}` }],
      [{ text: '🔁 Переписывай сам', callback_data: `vid:self:${id}` }],
      [{ text: '✅ Всё равно беру', callback_data: `vid:ok:${id}` }],
    ],
  );
  return { среднее, худшая, склеек, годится, совет, смысл, смыслНе, смыслНеПроверен, стартСтоит, финалЗамер };
}

/**
 * Записывает числа замера к ролику во «Входящих».
 *
 * Если ролик не дотянул до нормы — сам заводит задание на переписывание
 * промта. Татьяна сказала прямо: про нормы её не спрашивать, ниже порога —
 * переделывать молча. Раньше слабый ролик просто лежал во «Входящих», и
 * узнать о нём можно было, только заглянув в базу.
 */
// Края ролика словами для бригады: генератор начинает с неподвижного кадра и
// замораживает финал, хотя в промте облёт и крючок есть (28.10.2026).
function краяЗадания(ч) {
  const части = [];
  if (ч.стартСтоит) {
    части.push('НА 0 СЕК КАМЕРА В ГОТОВОМ РОЛИКЕ СТОИТ — генератор не начал движение. ' +
      'Первый бит: полёт камеры уже идёт с кадра 0 (не «начинает облёт»), предмет или ' +
      'герой проносится у самой линзы в первые 0,3 с');
  }
  if (ч.финалЗамер) {
    части.push('КРЮЧОК В КОНЦЕ ЗАМЕР — последние 0,7 с стоят. Крючок — действие, которое ' +
      'ещё идёт в последнем кадре (падает, катится, летит, камера ещё движется), а не ' +
      'застывшая картинка');
  }
  return части.length ? ` ПО КАДРАМ: ${части.join('; ')}.` : '';
}

async function записатьЗамер(id, ч) {
  if (!id || !ч) return;
  const h = {
    apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  await fetch(`${url}/rest/v1/incoming_videos?id=eq.${id}`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({
      measure_avg: ч.среднее, measure_worst: ч.худшая, measure_cuts: ч.склеек,
    }),
  }).catch(() => {});

  const [ролик] = await (await fetch(
    `${url}/rest/v1/incoming_videos?id=eq.${id}` +
    `&select=name,user_id,idea_id,target_platform,causal_pattern`, { headers: h },
  )).json().catch(() => [null]);
  if (!ролик) return;

  // Эталон едет в КАЖДУЮ переделку: без него дежурный чинит по голым цифрам
  // и с каждым дублем уезжает от того, что реально собрало миллионы.
  let эталон = '';
  if (ролик.idea_id) {
    const [идея] = await (await fetch(
      `${url}/rest/v1/video_ideas?id=eq.${ролик.idea_id}` +
      `&select=reference_title,reference_source_url,reference_views,payoff_class`,
      { headers: h },
    )).json().catch(() => [null]);
    if (идея?.reference_source_url) {
      эталон = ` ЭТАЛОН ИЗ YOUTUBE — ролик построен по нему, чинить с оглядкой ` +
        `на его сцену и развязку, а не только на цифры: ` +
        `«${(идея.reference_title ?? '').slice(0, 60)}» ${идея.reference_source_url}` +
        `${идея.reference_views ? `, ${идея.reference_views} просмотров` : ''}` +
        `${идея.payoff_class ? `, развязка: ${идея.payoff_class}` : ''}.`;
    }
  }

  // 27.10.2026, заказчица: при замере в норме задания нет — ей приходит
  // замер с кнопками, решает она. Смысл — строкой «Смысл» из разбора Gemini.
  if (ч.годится) return;

  const заданиеНаРазбор = `Смысл ролика «${ролик.name}» не проверен при нормальном замере ${ч.среднее}/${ч.худшая}. ` +
    'Прочитай существующий разбор и проверь именно этот готовый ролик по цели docs/ЦЕЛЬ_РОЛИКА.md. ' +
    'Отсутствие строки смысла не означает брак сюжета. Не переписывай промт и не запускай генерацию только из-за отсутствия разбора. ' +
    'Если смысл фактически не прошёл — передай бригаде конкретные причины и цель дословно; решение о принятии остаётся заказчице.';

  await fetch(`${url}/rest/v1/claude_tasks`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      user_id: ролик.user_id, video_id: id, idea_id: ролик.idea_id ?? null,
      text: ч.смыслНеПроверен ? заданиеНаРазбор : (ч.смыслНе
        ? `Смысл не прошёл (${ч.смысл}) при замере ${ч.среднее}/${ч.худшая}. `
        : `Замер ниже нормы: среднее ${ч.среднее} (норма ${НОРМА_СРЕДНЕЕ}), ` +
        `худшая секунда ${ч.худшая} (норма ${НОРМА_ХУДШАЯ})` +
        `${ч.совет ? `, провал на ${ч.совет} с` : ''}. `) +
        `Перепиши промт ролика «${ролик.name}» бригадой и пришли новый. ` +
        `Заказчицу про нормы не спрашивать. ` +
        // 27.10.2026, заказчица: чинить одно место в тоскливом ролике — ролик
        // остаётся тоскливым. Бригада переписывает до цели ролика целиком.
        // Раскадровка прошлого дубля убрана тогда же (4,5 минуты впустую).
        `ПОРЯДОК: 1) найди промт и план этого ролика (карточка или prompts/) — это ` +
        `справка, не основа; 2) каждому агенту первым абзацем — docs/ЦЕЛЬ_РОЛИКА.md ` +
        `дословно и этот текст дословно; задание агенту не сужать: без «только бит X», ` +
        `«камеру не менять», «остальное не трогай»; 3) сценарист, режиссёр, оператор, ` +
        `счётчик, критик — ролик должен стать таким, как в цели; провальное место ` +
        `(по замеру) тем же текстом не повторять; 4) критик пишет <имя>.critic.md.` +
        краяЗадания(ч) +
        эталон +
        (ролик.target_platform === 'youtube_shorts' && ролик.causal_pattern
          ? ` TRUSTED INTERNAL METADATA: target_platform=youtube_shorts; ` +
            `causal_pattern=${JSON.stringify(ролик.causal_pattern)}. Сохранить ` +
            `causal beats, violation и payoff class при targeted correction.`
          : ''),
    }),
  }).catch(() => {});
  console.log('   заведено задание на переписывание промта');
}

/**
 * Титры по фактической речи и бесшовная петля.
 *
 * Распознавание, разбивка на титры и расчёт момента печати живут в питоновском
 * пакете — там это уже отработано и проверено замерами. Здесь только вызов.
 *
 * Возвращает путь к готовому файлу либо null, если постобработка не удалась:
 * в этом случае ролик уходит во «Входящие» как есть, без титров, но уходит.
 * Терять ролик из-за титров — хуже, чем выпустить его голым.
 */
/**
 * Заголовок в кадре из названия ролика.
 *
 * По правилу заголовок стоит во всех роликах без исключения, поэтому
 * названия вида «duration_seconds_aspect (11).mp4» не годятся: вжигать в
 * кадр имя файла нельзя, а молча выпускать ролик без заголовка — тоже.
 * Такие ролики ждут, пока Татьяна пришлёт название.
 *
 * Возвращает null, если заголовок из названия не вытащить.
 */
function заголовокИз(имя = '') {
  // Только формат «Герой — ЗАГОЛОВОК», никаких догадок. Раньше любое русское
  // название шло в кадр целиком, и 4 августа в ролик вжглось замечание
  // Татьяны «САМ ДОБАВЬ БУКВУ А. ХВАТИТ ПРОМТОВ». Нет тире — нет заголовка,
  // ролик ждёт названия.
  const t = String(имя).trim();
  return t.includes('—') ? (t.split('—').pop().trim() || null) : null;
}

async function титрыИПетля(input, имя = '') {
  const хук = заголовокИз(имя) ?? '';
  const питон = хук
    ? { env: { ...ПИТОН.env, CAP_HOOK: хук } }
    : ПИТОН;
  const слова = join(tmpdir(), `words-${Date.now()}.json`);
  const сТитрами = join(tmpdir(), `subs-${Date.now()}.mp4`);
  const времянки = [слова, сТитрами];

  try {
    process.stdout.write('распознаю речь… ');
    await run('python', [join(POSTPROD_DIR, 'raspoznat.py'), input, слова], ПИТОН);

    process.stdout.write('титры… ');
    await run('python', [join(POSTPROD_DIR, 'subs_v8.py'), input, слова, сТитрами], питон);

    process.stdout.write('петля… ');
    await run('python', [join(POSTPROD_DIR, 'loop_v2.py'), сТитрами, '0.80'], ПИТОН);

    // loop_v2 кладёт результат рядом с исходником, добавляя _loop.
    const петля = сТитрами.replace(/\.mp4$/, '_loop.mp4');
    if (!existsSync(петля)) throw new Error('петля не собралась');

    rmSync(слова, { force: true });
    rmSync(сТитрами, { force: true });
    return петля;
  } catch (e) {
    for (const f of времянки) rmSync(f, { force: true });
    console.log(`\n   [без титров] ${String(e.message).slice(0, 120)}`);
    return null;
  }
}

async function обработать(filePath, { переозвучить }) {
  const meta = await метаданные(filePath);
  const времянки = [];
  let рабочий = filePath;

  try {
    const { w, h } = await размеры(рабочий);
    if (w > h) {
      process.stdout.write('в вертикаль… ');
      рабочий = await вВертикаль(рабочий);
      времянки.push(рабочий);
    }

    if (переозвучить) {
      if (!meta.caption) throw new Error('нечего озвучивать: реплика не найдена');
      process.stdout.write('озвучиваю… ');
      const { dubVideo } = await import(pathToFileURL(DUB_MODULE).href);
      const out = join(tmpdir(), `dub-${Date.now()}.mp4`);
      await dubVideo({
        input: рабочий,
        output: out,
        text: meta.caption,
        hook: meta.name?.split('—').pop()?.trim(),
      });
      рабочий = out;
      времянки.push(out);
    }

    // Один путь для всех роликов, откуда бы они ни пришли. Папка кладёт
    // ролик во «Входящие» СЫРЫМ и только замеряет. Титры вешает общий шаг
    // присланныеБоту() — когда появится заголовок, то есть когда Татьяна
    // скажет «годится». Раньше папка была отдельной веткой: титры сразу,
    // без её решения и без выбора заголовка.
    const ответ = await send(рабочий, meta, filePath);
    const заголовок = заголовокИз(meta.name);
    if (ответ?.id) {
      await записатьЗамер(
        ответ.id,
        await замер(рабочий, meta.name || basename(filePath), ответ.id),
      );
      const патч = {};
      if (заголовок) патч.hook = заголовок;
      // «Без титров» — ролики, где текст уже нарисован самой видеомоделью.
      // Помечаем обработанными, чтобы общий проход их не трогал.
      if (filePath.includes('Без титров')) патч.polished_at = new Date().toISOString();
      if (Object.keys(патч).length) {
        await fetch(`${url}/rest/v1/incoming_videos?id=eq.${ответ.id}`, {
          method: 'PATCH',
          headers: {
            apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(патч),
        }).catch(() => {});
      }
    }
    moveTo(
      doneDir,
      filePath,
      (переозвучить ? 'голос Дмитрия' : 'звук родной') +
        (заголовок ? ', заголовок есть' : ', ждёт решения'),
    );
    if (meta.taskPath && existsSync(meta.taskPath)) moveTo(doneDir, meta.taskPath);
    console.log(заголовок
      ? 'во «Входящих», заголовок есть — титры навешу следующим проходом.'
      : 'во «Входящих», замерен. Жду решения: годится или нет.');
  } finally {
    for (const f of времянки) rmSync(f, { force: true });
  }
}

async function просмотр(dir, переозвучить) {
  let files;
  try {
    files = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of files) {
    if (!entry.isFile()) continue;
    if (!VIDEO_EXT.has(extname(entry.name).toLowerCase())) continue;

    const filePath = join(dir, entry.name);
    let size;
    try {
      size = statSync(filePath).size;
    } catch {
      continue;
    }
    if (size === 0) continue;

    // Ждём, пока размер перестанет меняться: файл ещё скачивается.
    if (stableSizes.get(filePath) !== size) {
      stableSizes.set(filePath, size);
      continue;
    }
    stableSizes.delete(filePath);

    const mb = (size / 1024 / 1024).toFixed(1);
    process.stdout.write(`«${entry.name}» (${mb} МБ): `);
    try {
      await обработать(filePath, { переозвучить });
    } catch (err) {
      // Файл мог исчезнуть, пока мы с ним возились (например, его забрала
      // вторая запущенная копия программы). Тогда это не ошибка — просто
      // молча пропускаем, иначе разбор всей папки прервётся.
      if (!existsSync(filePath)) {
        console.log('файл уже забрали, пропускаю.');
        continue;
      }
      try {
        moveTo(failDir, filePath);
        console.log(`не удалось — ${err.message}`);
        console.log('  Файл убран в подпапку «Ошибка».');
      } catch {
        console.log(`не удалось — ${err.message}`);
      }
    }
  }
}

// Обработка ролика (вертикаль, озвучка, отправка) идёт заметно дольше пяти
// секунд. Без этого флага следующая проверка успевала взяться за тот же файл,
// и он обрабатывался по несколько раз разом.
/**
 * Ролики, присланные боту с телефона, до компьютера сами не доезжают:
 * на сервере нет ffmpeg, титры там вжечь нечем. Поэтому забираем их сюда,
 * обрабатываем и кладём обратно — уже с титрами и петлёй.
 */
/**
 * Подтверждение доделок.
 *
 * Нажатую в приложении кнопку «На доделку» раньше не видел никто: приёмник
 * берёт только необработанные ролики (`polished_at is null`), а у готового
 * ролика эта пометка уже стоит. Замечание ложилось в базу, и Татьяне никто
 * не отвечал — со стороны выглядело как «написала, а он ничего не делает».
 *
 * Теперь бот подтверждает каждое замечание сразу, как только оно появилось,
 * и помечает подтверждённое, чтобы не написать дважды.
 */
async function подтвердитьДоделки() {
  if (!url || !serviceKey) return;
  const h = {
    apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  let новые;
  try {
    // Не «подтверждения ещё не было», а «замечание новее подтверждения»:
    // иначе второе замечание к тому же ролику уходило в тишину. Сравнение
    // двух столбцов PostgREST не умеет, поэтому отбираем здесь.
    const все = await (await fetch(
      `${url}/rest/v1/incoming_videos?status=eq.rework` +
      `&select=id,name,user_id,idea_id,rework_note,rework_at,rework_ack_at&order=rework_at&limit=20`,
      { headers: h },
    )).json();
    новые = Array.isArray(все)
      ? все.filter((в) => !в.rework_ack_at ||
          (в.rework_at && new Date(в.rework_at) > new Date(в.rework_ack_at))).slice(0, 5)
      : [];
  } catch {
    return;                         // сеть моргнула — попробуем на следующем тике
  }
  if (!Array.isArray(новые) || !новые.length) return;

  for (const в of новые) {
    // Замечание из ПРИЛОЖЕНИЯ должно рождать задание дежурному, как и из
    // бота. С 04.08 этот путь только отвечал «принял» и молчал дальше —
    // 30.08 заказчица написала две доделки из VibePost, и промты не пришли.
    const задание = await fetch(`${url}/rest/v1/claude_tasks`, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        user_id: в.user_id,
        video_id: в.id,
        idea_id: в.idea_id ?? null,
        text: `Замечание заказчицы из VibePost по ролику «${в.name}»: ` +
          `${в.rework_note ?? 'без пояснения'}`,
      }),
    }).catch(() => null);
    if (!задание || !задание.ok) {
      // Задание не записалось — квитанцию не ставим, чтобы доделка не
      // спряталась: возьмём её на следующем тике.
      console.log(`[доделка] задание не записалось, отложил: ${в.name}`);
      continue;
    }
    await вБота(
      `↩︎ Принял замечание по ролику «${в.name}»:\n\n` +
      `«${в.rework_note ?? 'без пояснения'}»\n\n` +
      'Беру в работу. Пришлю новый промт.',
    );
    await fetch(`${url}/rest/v1/incoming_videos?id=eq.${в.id}`, {
      method: 'PATCH', headers: h,
      body: JSON.stringify({ rework_ack_at: new Date().toISOString() }),
    }).catch(() => {});
    console.log(`[доделка] подтвердил и завёл задание: ${в.name}`);
  }
}

// Ни один сетевой запрос приёмника не ждёт вечно. Повисший запрос — это
// остановка всего конвейера: 8 августа так пропали три ролика подряд.
const СЕТЬ_МС = 25_000;
const _fetch = globalThis.fetch;
globalThis.fetch = (адрес, опции = {}) =>
  _fetch(адрес, { ...опции, signal: опции.signal ?? AbortSignal.timeout(СЕТЬ_МС) });

/** Ролики, о которых уже написано «жду название» — чтобы не повторяться. */
const ждутНазвания = new Set();

/**
 * Будит Claude, когда Татьяна прислала задание.
 *
 * Раньше её ждал дежурный раз в час: написала в 16:25 — разбор в 17:05.
 * Приёмник и так смотрит в базу каждые пять секунд, так что будить может он.
 *
 * Минута отсрочки: если Claude сейчас работает, он увидит задание сам —
 * через хук завершения. Поднимать второго ни к чему.
 *
 * Второго условия больше нет. Раньше дежурный не поднимался, пока открыто окно
 * разговора: считалось, что задание увидит Claude в окне. Но он видит его
 * только между ответами, и задание лежало, пока он занят. Захват теперь
 * атомарный, драться за одну задачу невозможно — значит и придерживать
 * дежурного незачем.
 */
// Будим сразу. Пауз больше нет: задание Татьяны не должно лежать ни минуты.
// Лавину держит замок живого дежурного, а не время — см. dezhurny.pid.
//
// Минимальный зазор в полминуты оставлен на случай, если замок не успел
// появиться: дежурный пишет его через секунду после старта, и без зазора
// приёмник за эту секунду успел бы поднять ещё пятерых.
const ЗАЗОР_МС = 30 * 1000;
const замокДежурного = join(base, 'dezhurny.pid');
const следЗапуска = join(base, 'dezhurny-last.txt');
const паузаДежурного = join(base, 'dezhurny-pause.json');

function прочитатьПаузуДежурного() {
  try {
    const пауза = JSON.parse(readFileSync(паузаДежурного, 'utf8'));
    if (пауза?.until && new Date(пауза.until).getTime() > Date.now()) return пауза;
    rmSync(паузаДежурного, { force: true });
  } catch { /* паузы нет либо файл уже устарел */ }
  return null;
}

function записатьПаузуДежурного(остановка) {
  if (!остановка.until) return;
  writeFileSync(паузаДежурного, JSON.stringify({
    reason: остановка.reason,
    detail: остановка.detail,
    progress: остановка.progress,
    until: остановка.until,
  }, null, 2));
}

async function полосыОжидаютClaude(подпись = null) {
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
              'Content-Type': 'application/json' };
  let полосы;
  try {
    полосы = await (await fetch(
      `${url}/rest/v1/work_progress?done_at=is.null&select=id,note,stages,step`,
      { headers: h },
    )).json();
  } catch { return; }
  if (!Array.isArray(полосы)) return;

  for (const полоса of полосы.filter((п) => (п.note ?? '').startsWith('задание '))) {
    const ждётСейчас = Array.isArray(полоса.stages) &&
      String(полоса.stages[1] ?? '').startsWith('ждёт Claude');
    const stages = подпись
      ? ['задание принято', подпись, 'пишу промпт', 'отправлен вам']
      : ['задание принято', 'пишу промпт', 'отправлен вам'];
    if ((подпись && ждётСейчас && полоса.stages[1] === подпись) ||
        (!подпись && !ждётСейчас)) continue;
    await fetch(`${url}/rest/v1/work_progress?id=eq.${полоса.id}`, {
      method: 'PATCH', headers: h,
      body: JSON.stringify({ stages, step: 1, updated_at: new Date().toISOString() }),
    }).catch(() => {});
  }
}

async function разбудитьЕслиЖдут() {
  if (!url || !serviceKey) return;
  let ждут;
  try {
    ждут = await (await fetch(
      `${url}/rest/v1/claude_tasks?status=eq.new&select=id&limit=1`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    )).json();
  } catch {
    return;
  }
  if (!Array.isArray(ждут) || !ждут.length) return;

  // Лимит Claude — не поломка и не повод запускать его каждые пять минут.
  // Оставляем задание в очереди и ждём времени сброса, которое сообщил CLI.
  const пауза = null;   // пауза по дате выброшена 27.08, см. 07_ПРАВИЛА.md
  if (пауза) {
    await полосыОжидаютClaude(пауза.progress ?? 'ждёт Claude');
    return;
  }

  // Дежурный жив — второго не надо. Проверяем по настоящему номеру процесса,
  // который он записал сам.
  try {
    process.kill(Number(readFileSync(замокДежурного, 'utf8')), 0);
    return;
  } catch { /* замка нет либо процесс из него умер */ }

  try {
    if (Date.now() - statSync(следЗапуска).mtimeMs < ЗАЗОР_МС) return;
  } catch { /* следа нет — первый запуск */ }

  // Дежурный может умирать на входе: истёк вход в Claude, упал обход связи.
  // Тогда будить его бессмысленно — он не доживёт до задания. Раньше приёмник
  // всё равно дёргал его каждые полминуты: в журнале накопилось 130 подъёмов
  // подряд, и ни один ничего не сделал.
  //
  // Смотрим хвост его журнала: если последняя запись свежая и это отказ входа,
  // молчим полчаса и один раз говорим Татьяне, что именно поднять.
  try {
    const журнал = join(base, '..', 'dezhurny.log');
    const путь = fileURLToPath(new URL('dezhurny.log', root));
    if (Date.now() - statSync(путь).mtimeMs < 5 * 60 * 1000) {
      const хвост = readFileSync(путь, 'utf8').slice(-600);
      const остановка = причинаОстановкиClaude(хвост);
      if (остановка) {
        const метка = join(base, 'dezhurny-otkaz.txt');
        let говорили = 0;
        try { говорили = statSync(метка).mtimeMs; } catch { /* не говорили */ }
        if (остановка.reason === 'limit') записатьПаузуДежурного(остановка);
        await полосыОжидаютClaude(остановка.progress);
        // Причину кладём в базу СРАЗУ, а не раз в полчаса: бот должен уметь
        // ответить правдиво в любую минуту, а не только после тревоги.
        fetch(`${url}/rest/v1/worker_health?id=eq.1`, {
          method: 'PATCH',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
                     'Content-Type': 'application/json' },
          body: JSON.stringify({
            reason: остановка.reason,
            detail: остановка.detail,
            happened_at: new Date().toISOString(),
          }),
        }).catch(() => {});
        if (Date.now() - говорили > 30 * 60 * 1000) {
          writeFileSync(метка, new Date().toISOString());
          await вБота(остановка.message);
          console.log('[будильник] дежурный не заводится, сказал Татьяне');
        }
        return;
      }
    }
  } catch { /* журнала нет — значит и отказов не было */ }
  // Старая пауза закончилась либо причина исчезла — только теперь возвращаем
  // обычные этапы. Нельзя сбрасывать и снова ставить подпись каждые пять секунд.
  await полосыОжидаютClaude();
  writeFileSync(следЗапуска, new Date().toISOString());
  // Раз дошли сюда — отказов в журнале нет, значит здоров.
  fetch(`${url}/rest/v1/worker_health?id=eq.1`, {
    method: 'PATCH',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
               'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'ok', detail: null, happened_at: new Date().toISOString() }),
  }).catch(() => {});

  const пускач = fileURLToPath(new URL('Дежурный.vbs', root));
  const дитя = spawn('wscript.exe', ['//B', '//Nologo', пускач], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  дитя.unref();
  console.log('[будильник] пришло задание — поднимаю Claude');
}

/**
 * Полоса заводится сама на каждое задание.
 *
 * Раньше строку хода работы создавал Claude отдельной командой — и на задания
 * из бота её не заводил никто. Татьяна писала в бота, в приложении было пусто,
 * и понять, взята работа или лежит, было невозможно.
 *
 * Теперь: пришло задание — появилась полоса. Задание закрыли — полоса закрылась.
 */
async function полосаПоЗаданиям() {
  if (!url || !serviceKey) return;
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  let задания, полосы;
  try {
    [задания, полосы] = await Promise.all([
      // Оба рабочих статуса. Раньше спрашивались только «new», а после
      // атомарного захвата задача в работе становится «processing» — и
      // закрыватель гасил полосу ровно тогда, когда работа начиналась.
      (await fetch(`${url}/rest/v1/claude_tasks?status=in.(new,processing)` +
        `&select=id,text,user_id,status&order=created_at&limit=20`, { headers: h })).json(),
      (await fetch(`${url}/rest/v1/work_progress?done_at=is.null` +
        `&select=id,note,stages,step,updated_at&limit=30`, { headers: h })).json(),
    ]);
  } catch { return; }
  if (!Array.isArray(задания) || !Array.isArray(полосы)) return;

  // Связь задания и полосы держим в note: «задание <id>».
  const естьПолоса = new Set(
    полосы.map((п) => (п.note ?? '').replace('задание ', '')).filter(Boolean),
  );

  for (const з of задания) {
    if (естьПолоса.has(з.id)) continue;
    await fetch(`${url}/rest/v1/work_progress`, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        user_id: з.user_id,
        title: String(з.text).slice(0, 60),
        stages: ['задание принято', 'пишу промт', 'отправлен вам'],
        step: 1,
        note: `задание ${з.id}`,
      }),
    }).catch(() => {});
  }

  // Задание ушло из работы — закрываем полосу. Чем закончилось, спрашиваем у
  // самого задания: «failed» нельзя показывать как «готово», иначе в
  // приложении висит успех там, где на самом деле сбой.
  const вРаботе = new Set(задания.map((з) => з.id));
  for (const п of полосы) {
    const idЗадания = (п.note ?? '').startsWith('задание ')
      ? (п.note ?? '').replace('задание ', '') : null;
    if (!idЗадания || вРаботе.has(idЗадания)) continue;

    let итог = 'готово';
    try {
      const [задача] = await (await fetch(
        `${url}/rest/v1/claude_tasks?id=eq.${idЗадания}&select=status,error`, { headers: h },
      )).json();
      if (задача?.status === 'failed') {
        итог = `ошибка: ${String(задача.error ?? 'без пояснения').slice(0, 120)}`;
      } else if (!задача) {
        итог = 'задание удалено';
      }
    } catch { /* не спросили — считаем, что доведено */ }

    await fetch(`${url}/rest/v1/work_progress?id=eq.${п.id}`, {
      method: 'PATCH', headers: h,
      body: JSON.stringify({
        // Последний этап берём из самой полосы, а не числом 3: у полос с
        // другим числом этапов выходило «3 из 4» навсегда.
        step: Array.isArray(п.stages) ? п.stages.length : п.step,
        done_at: new Date().toISOString(),
        outcome: итог,
        updated_at: new Date().toISOString(),
      }),
    }).catch(() => {});
  }

  // Страховка для полос без задания: их заводят руками (scripts/ход.mjs), и
  // закрыть их автоматически некому. Отсюда и брались «идёт 900 минут» —
  // работа давно кончилась, а строка висела вечно.
  //
  // Трогаем ТОЛЬКО дошедшие до последнего этапа и не менявшиеся полчаса.
  // Незавершённую полосу не закрываем ни при каких условиях: это и есть
  // настоящее зависание, и прятать его нельзя.
  const ПОЛЧАСА = 30 * 60 * 1000;
  for (const п of полосы) {
    if ((п.note ?? '').startsWith('задание ')) continue;
    const всего = Array.isArray(п.stages) ? п.stages.length : 0;
    if (!всего || п.step < всего) continue;
    if (Date.now() - new Date(п.updated_at).getTime() < ПОЛЧАСА) continue;
    await fetch(`${url}/rest/v1/work_progress?id=eq.${п.id}`, {
      method: 'PATCH', headers: h,
      body: JSON.stringify({
        done_at: п.updated_at,
        outcome: 'готово',
      }),
    }).catch(() => {});
    console.log('[полоса] закрыл забытую строку хода работы');
  }
}

/**
 * Умная приставка описаний (30.08). Ролик встал в YouTube-очередь с дефолтным
 * описанием — дежурный получает задание придумать 3 варианта с подвохом.
 * Заказчица тыкает один в карточке VibePost. '[]' в description_options —
 * отметка «задание уже создано», чтобы не заказывать дважды.
 */
async function заказатьОписания() {
  if (!url || !serviceKey) return;
  const h = {
    apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  let строки;
  try {
    // Ограничитель лавины: пока у дежурного лежат незакрытые задания-описания,
    // новых не заказываем. Иначе 36 черновиков дают 36 заданий за полторы
    // минуты (тик — 5 секунд, наплодил 12, пока ловили).
    const открытых = await (await fetch(
      `${url}/rest/v1/claude_tasks?text=like.*${encodeURIComponent('Придумай описания')}*` +
      `&status=eq.new&select=id&limit=2`,
      { headers: h },
    )).json();
    if (Array.isArray(открытых) && открытых.length >= 2) return;

    // С 31.08 описание — свойство РОЛИКА (одно на все площадки): источник —
    // карточки «Входящих», принятые или свежие, без сочинённых вариантов.
    строки = await (await fetch(
      `${url}/rest/v1/incoming_videos?description_options=is.null` +
      `&status=in.(new,scheduled)&video_url=not.is.null` +
      // Заказчица 26.10, трижды за день: «Если плохой дубль, то зачем писать
      // к нему описание?» Описание — только принятому ЕЮ ролику: выбрала
      // заголовок (owner_accepted_at) или поставила в очередь (scheduled).
      // Замер в норме и закрытая приёмка — не её решение.
      `&or=(status.eq.scheduled,owner_accepted_at.not.is.null)` +
      `&select=id,user_id,name,video_url&order=created_at.desc&limit=1`,
      { headers: h },
    )).json();
  } catch { return; }
  if (!Array.isArray(строки) || !строки.length) return;

  for (const с of строки) {
    с.title = с.name;
    const видео = с.video_url;
    // Хэштеги берём не из головы, а из счётчиков ТикТока: мало снято при
    // высоких просмотрах на ролик. 10.09 оказалось, что прежний набор
    // (#личныефинансы, #финансоваяграмотность) даёт 19 тысяч на ролик, а
    // #говорящиеживотные — 204 тысячи при тысяче роликов конкуренции.
    let наборТегов = '#финансовыйюмор #юморпроденьги #взрослыйюмор';
    try {
      const теги = await (await fetch(
        `${url}/rest/v1/tiktok_tegi?rolikov=lt.50000&select=teg&order=na_rolik.desc&limit=4`,
        { headers: h },
      )).json();
      if (Array.isArray(теги) && теги.length >= 3) {
        наборТегов = теги.map((т) => `#${т.teg}`).join(' ');
      }
    } catch { /* нет счётчиков — идём с набором по умолчанию */ }

    const задание = await fetch(`${url}/rest/v1/claude_tasks`, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        user_id: с.user_id,
        text: `Придумай описания для YouTube-ролика «${с.title}». ` +
          `Скачай и распознай реплику (python raspoznat.py, файл: ${видео}). ` +
          `Затем 3 варианта описания, каждый из трёх строк: первая — подвох, ` +
          `продолжающий мысль реплики (НЕ пересказ её и НЕ повтор), для взрослых: ` +
          `сухо, зло, без «смешных зверушек»; вторая — повод переслать, до 7 слов, ` +
          `сухо, без восклицаний и смайлов, адресат узнаваемый по теме ` +
          `(«Перешли тому, кто взял кредит под ремонт»); третья — хэштеги: ` +
          `#shorts ${наборТегов} плюс 1-2 по теме ролика ` +
          `(#ипотека #налоги #страхование #инфляция #сбережения #кредиты #пенсия #зарплата). ` +
          `Первые — самые щедрые теги по счётчикам ТикТока на сегодня. ` +
          `Запрещены голые #животные #рек #юмор и клички зверей. Запиши их: ` +
          `node scripts/описания.mjs ${с.id} "вариант 1" "вариант 2" "вариант 3" ` +
          `(перенос строки внутри варианта — \\n). Заказчице ничего не шли: ` +
          `варианты сами появятся у неё в приложении.`,
      }),
    }).catch(() => null);
    if (задание && задание.ok) {
      await fetch(`${url}/rest/v1/incoming_videos?id=eq.${с.id}`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({ description_options: [] }),
      }).catch(() => {});
      console.log(`[описания] заказал дежурному: ${с.title}`);
    }
  }
}

async function присланныеБоту() {
  if (!url || !serviceKey) return;
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  let ждут;
  try {
    const r = await fetch(
      // Только «new». Ролик на доработке не обрабатываем вовсе: Татьяна может
      // сказать «переписывай полностью», и титры с заголовком окажутся
      // выброшенной работой. Сначала её решение — потом название и титры.
      // Только те, с кем есть работа: незамеренные или с выбранным заголовком.
      // 14.10.2026 три ролика не замерились до утра: 19 замеренных, ждущих её
      // решения, занимали окно limit=20, и новые оказывались 21-м и дальше.
      `${url}/rest/v1/incoming_videos?polished_at=is.null&status=eq.new` +
      `&or=(measure_avg.is.null,hook.not.is.null)` +
      `&select=id,name,hook,tag,status,rework_note,video_url,measure_avg` +
      `&order=created_at&limit=20`,
      { headers: h },
    );
    ждут = await r.json();
  } catch {
    return;                       // сеть моргнула — попробуем на следующем тике
  }
  if (!Array.isArray(ждут) || !ждут.length) return;

  // Замеренные ролики без заголовка ждут решения Татьяны и делать с ними
  // нечего. Раньше они всё равно попадали в выборку — и намертво занимали её.
  // 8 августа три таких ролика висели в начале очереди, а три новых, присланных
  // следом, не замерялись вовсе: приёмник брал три самых старых и каждый раз
  // упирался в те же три. Со стороны это выглядело как зависание.
  const кработе = ждут
    .filter((р) => р.measure_avg == null || (р.hook ?? '').trim())
    .slice(0, 3);
  const ждутРешения = ждут.length - кработе.length;
  if (ждутРешения > 0 && кработе.length) {
    console.log(`   (пропускаю ${ждутРешения} замеренных — они ждут решения Татьяны)`);
  }

  for (const ролик of кработе) {
    // Заголовок в кадр — ТОЛЬКО тот, что Татьяна выбрала кнопкой из пяти
    // вариантов. Из имени карточки его больше не берём: имя ставит бот, и
    // 10.09.2026 через эту лазейку 37 роликов получили в кадр чужой заголовок
    // («КОПИТЬ ИЛИ ЖИТЬ СЕГОДНЯ?» на ролике про рыбу). Порядок её: сперва она
    // смотрит визуал и жмёт «годится», потом выбирает заголовок, и только
    // тогда он печатается.
    const заголовок = (ролик.hook ?? '').trim();
    // Замер идёт ПЕРВЫМ и не зависит от названия. Иначе выходил замкнутый
    // круг: Татьяна не может решить, годится ли ролик, потому что чисел нет,
    // а чисел нет, потому что она не дала названия. Ждёт названия только шаг
    // с титрами — без названия заголовок в кадр не поставить.
    if (!заголовок && ролик.measure_avg != null) {
      // Замерен и ждёт решения — качать заново нечего.
      if (!ждутНазвания.has(ролик.id)) {
        ждутНазвания.add(ролик.id);
        console.log(`[из бота] «${ролик.name}» — замерен, жду вашего решения`);
      }
      continue;
    }
    ждутНазвания.delete(ролик.id);
    const исходник = join(tmpdir(), `bot-${ролик.id}.mp4`);
    let готовый = null;
    try {
      console.log(`\n[из бота] ${ролик.name}`);
      const данные = Buffer.from(await (await fetch(ролик.video_url)).arrayBuffer());
      writeFileSync(исходник, данные);

      const { w, h: вы } = await размеры(исходник);
      let рабочий = исходник;
      if (w > вы) {
        process.stdout.write('в вертикаль… ');
        рабочий = await вВертикаль(рабочий);
      }

      if (ролик.measure_avg == null) {
        // Подписываем замер меткой по смыслу — «скорпион», «скат».
        // «Ролик из Telegram» Татьяна в переписке не узнаёт, а два замера
        // подряд с одинаковой подписью не различить вовсе.
        const подпись = (ролик.tag ?? '').trim() || ролик.name;
        await записатьЗамер(ролик.id, await замер(рабочий, подпись, ролик.id));
      }
      // Титры — только когда есть заголовок. Ролик остаётся необработанным
      // и дождётся названия, а числа Татьяна уже получила.
      if (!заголовок) {
        if (рабочий !== исходник) rmSync(рабочий, { force: true });
        rmSync(исходник, { force: true });
        console.log('   замер есть, титры ждут названия');
        continue;
      }
      // Заголовок передаём готовым: он мог прийти отдельным полем, а не
      // из названия после тире.
      готовый = await титрыИПетля(рабочий, `— ${заголовок}`);
      if (рабочий !== исходник) rmSync(рабочий, { force: true });
      if (!готовый) {
        // Титры не легли — помечаем обработанным, иначе застрянет навсегда.
        await fetch(`${url}/rest/v1/incoming_videos?id=eq.${ролик.id}`, {
          method: 'PATCH',
          headers: { ...h, 'Content-Type': 'application/json' },
          body: JSON.stringify({ polished_at: new Date().toISOString() }),
        });
        continue;
      }

      // Кладём новый файл рядом со старым и переставляем ссылку.
      const путь = `videos/${ролик.id}-titry.mp4`;
      const up = await fetch(`${url}/storage/v1/object/post-photos/${путь}`, {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
        body: readFileSync(готовый),
      });
      if (!up.ok) throw new Error(`хранилище: ${up.status}`);

      // ?v= — чтобы телефон не показал старые титры из кэша после перевески.
      await fetch(`${url}/rest/v1/incoming_videos?id=eq.${ролик.id}`, {
        method: 'PATCH',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_url: `${url}/storage/v1/object/public/post-photos/${путь}?v=${Date.now()}`,
          polished_at: new Date().toISOString(),
          burned_hook: заголовок,
        }),
      });
      console.log('готово, во «Входящих» уже с титрами.');
      if (ролик.status === 'rework') {
        await вБота(
          `✅ Готово: ${ролик.name}

` +
          'Титры, заголовок и петля на месте, ролик во «Входящих». ' +
          'Пометку «на доделку» не снимаю — снимите сами, когда посмотрите.',
        );
      }
    } catch (e) {
      console.log(`   [сбой] ${String(e.message).slice(0, 120)}`);
    } finally {
      rmSync(исходник, { force: true });
      if (готовый) rmSync(готовый, { force: true });
    }
  }
}

/**
 * Сторож цикла.
 *
 * 8 августа приёмник висел живым процессом: журнал оборвался, три ролика
 * Татьяны лежали без замера, а в списке задач всё выглядело нормально —
 * процесс-то есть. Причина: у запросов не было тайм-аута. Один запрос,
 * который не вернулся, оставлял флаг «занят» поднятым навсегда, и цикл
 * больше не запускался ни разу.
 *
 * Живой процесс не значит работающий. Поэтому тик ограничен по времени:
 * если не уложился, мы об этом пишем и всё равно отпускаем замок.
 */
const ПРЕДЕЛ_ТИКА_МС = 3 * 60 * 1000;

/**
 * Переименовала карточку после титров — заголовок в кадре должен смениться.
 * Раньше переименование меняло только hook в базе: 01.09 заказчица трижды
 * писала «поменяй название», а в кадре стояло старое. Сравниваем нужный
 * заголовок с вожжённым (burned_hook); разошлись — возвращаем сырой файл
 * (raw_video_url) и снимаем polished_at, дальше обычный проход навесит титры.
 */
async function перевеситьТитры() {
  if (!url || !serviceKey) return;
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  let строки;
  try {
    строки = await (await fetch(
      `${url}/rest/v1/incoming_videos?polished_at=not.is.null&raw_video_url=not.is.null` +
      `&burned_hook=not.is.null&status=in.(new,scheduled)` +
      `&select=id,name,hook,burned_hook,raw_video_url&limit=20`,
      { headers: h },
    )).json();
  } catch { return; }
  if (!Array.isArray(строки)) return;
  const норм = (s) => (s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  for (const р of строки) {
    const нужен = (р.hook ?? '').trim();
    if (!нужен || норм(нужен) === норм(р.burned_hook)) continue;
    console.log(`[перевеска] «${р.name}»: в кадре «${р.burned_hook}», нужно «${нужен}»`);
    await fetch(`${url}/rest/v1/incoming_videos?id=eq.${р.id}`, {
      method: 'PATCH',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_url: р.raw_video_url, polished_at: null }),
    }).catch(() => {});
  }
}

/**
 * Счётчики хэштегов ТикТока — раз в сутки. Их не может собрать облако:
 * TikTok не отвечает серверам Supabase, а с этой машины отвечает всем.
 * Разбор дня в облаке читает готовую таблицу.
 */
let тегиСобраны = 0;
async function собратьТегиТиктока() {
  if (Date.now() - тегиСобраны < 20 * 3600_000) return;
  тегиСобраны = Date.now();
  try {
    const свой = dirname(fileURLToPath(import.meta.url));
    const модуль = await import(pathToFileURL(join(свой, 'теги-тиктока.mjs')).href);
    const строки = await модуль.собратьТеги();
    const сколько = await модуль.записатьТеги(строки);
    console.log(`[теги ТикТока] собрано: ${сколько}`);
  } catch (e) {
    тегиСобраны = 0; // не вышло — попробуем на следующем тике
    console.log(`   [теги ТикТока] ${String(e.message).slice(0, 120)}`);
  }
}

let занят = false;
let началТик = 0;
let последнийКонвейер = 0;

async function tick() {
  if (занят) {
    if (Date.now() - началТик > ПРЕДЕЛ_ТИКА_МС) {
      console.log(`[сторож] тик висит ${Math.round((Date.now() - началТик) / 1000)} с — отпускаю замок`);
      занят = false;
    }
    return;
  }
  занят = true;
  началТик = Date.now();
  try {
    // Первым делом: подтверждение доделок не должно ждать обработки роликов.
    // Обработка занимает минуты, а Татьяне важно услышать «принял» сразу.
    await подтвердитьДоделки();
    await двигатьПолосу();
    await разбудитьЕслиЖдут();
    await просмотр(readyDir, false);
    await просмотр(dubDir, true);
    await просмотр(noSubsDir, false);
    await присланныеБоту();
    if (Date.now() - последнийКонвейер >= КОНВЕЙЕР_МС) {
      последнийКонвейер = Date.now();
      await заказатьОписания();
      await полосаПоЗаданиям();
      await перевеситьТитры();
      await собратьТегиТиктока();
    }
  } finally {
    занят = false;
  }
}

await tick();
setInterval(tick, POLL_MS);
