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

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const POLL_MS = 5000;
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

  // Порог приёмки — тот же, по которому судит check.py: 18 и 9. Двадцатка
  // с десяткой были «ориентиром», и от этого числа в отчёте противоречили
  // вердикту. Норма в проекте одна.
  const годится = среднее >= НОРМА_СРЕДНЕЕ && худшая >= НОРМА_ХУДШАЯ;
  console.log(`   замер: среднее ${среднее}, худшая ${худшая}, склеек ${склеек}`);

  await вБота(
    `📏 Замер: ${имя}\n\n` +
    `Среднее: ${среднее}  (норма ${НОРМА_СРЕДНЕЕ}+)\n` +
    `Худшая секунда: ${худшая}  (норма ${НОРМА_ХУДШАЯ}+)\n` +
    `Склеек: ${склеек}\n\n` +
    (годится
      ? 'Числа в норме — по динамике вопросов нет.'
      : `Ниже нормы${совет ? `, провал на ${совет} с` : ''}. ` +
        'Промт переписываю сам, спрашивать не буду.') +
    '\n\nПосмотрите ролик и нажмите кнопку — тогда я точно пойму, о каком ' +
    'ролике речь.',
    // Кнопки несут в себе id ролика. Без них Татьяна пишет замечание, не зная,
    // к чему оно прилипнет: бот угадывал ролик по времени присылки.
    id ? [[
      { text: '✅ Годится', callback_data: `vid:ok:${id}` },
      { text: '✏️ Не годится', callback_data: `vid:no:${id}` },
    ]] : undefined,
  );
  return { среднее, худшая, склеек, годится, совет };
}

/**
 * Записывает числа замера к ролику во «Входящих».
 *
 * Если ролик не дотянул до нормы — сам заводит задание на переписывание
 * промта. Татьяна сказала прямо: про нормы её не спрашивать, ниже порога —
 * переделывать молча. Раньше слабый ролик просто лежал во «Входящих», и
 * узнать о нём можно было, только заглянув в базу.
 */
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

  if (ч.годится) return;
  const [ролик] = await (await fetch(
    `${url}/rest/v1/incoming_videos?id=eq.${id}&select=name,user_id`, { headers: h },
  )).json().catch(() => [null]);
  if (!ролик) return;
  await fetch(`${url}/rest/v1/claude_tasks`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      user_id: ролик.user_id, video_id: id,
      text: `Замер ниже нормы: среднее ${ч.среднее} (норма ${НОРМА_СРЕДНЕЕ}), ` +
        `худшая секунда ${ч.худшая} (норма ${НОРМА_ХУДШАЯ})` +
        `${ч.совет ? `, провал на ${ч.совет} с` : ''}. ` +
        `Перепиши промт ролика «${ролик.name}» сам и пришли новый. ` +
        `Татьяну про нормы не спрашивать.`,
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
      `&select=id,name,rework_note,rework_at,rework_ack_at&order=rework_at&limit=20`,
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
    await вБота(
      `↩︎ Принял замечание по ролику «${в.name}»:\n\n` +
      `«${в.rework_note ?? 'без пояснения'}»\n\n` +
      'Беру в работу. Пришлю новый промт.',
    );
    await fetch(`${url}/rest/v1/incoming_videos?id=eq.${в.id}`, {
      method: 'PATCH', headers: h,
      body: JSON.stringify({ rework_ack_at: new Date().toISOString() }),
    }).catch(() => {});
    console.log(`[доделка] подтвердил: ${в.name}`);
  }
}

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
 */
const ОТСРОЧКА_МС = 60 * 1000;
const замокДежурного = join(base, 'dezhurny.lock');

async function разбудитьЕслиЖдут() {
  if (!url || !serviceKey) return;
  let ждут;
  try {
    ждут = await (await fetch(
      `${url}/rest/v1/claude_tasks?status=eq.new&select=id,created_at&order=created_at&limit=1`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    )).json();
  } catch {
    return;
  }
  if (!Array.isArray(ждут) || !ждут.length) return;
  if (Date.now() - new Date(ждут[0].created_at).getTime() < ОТСРОЧКА_МС) return;

  // Дежурный уже поднят — второго не надо.
  if (existsSync(замокДежурного)) {
    try {
      process.kill(Number(readFileSync(замокДежурного, 'utf8')), 0);
      return;
    } catch { /* процесс из замка умер — можно поднимать заново */ }
  }

  const дежурный = fileURLToPath(new URL('scripts/dezhurny.mjs', root));
  const дитя = spawn('cmd.exe', ['/c', 'node', дежурный], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  writeFileSync(замокДежурного, String(дитя.pid));
  дитя.on('exit', () => rmSync(замокДежурного, { force: true }));
  дитя.unref();
  console.log('[будильник] пришло задание — поднимаю Claude');
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
      `${url}/rest/v1/incoming_videos?polished_at=is.null&status=eq.new` +
      `&select=id,name,hook,tag,status,rework_note,video_url,measure_avg` +
      `&order=created_at&limit=3`,
      { headers: h },
    );
    ждут = await r.json();
  } catch {
    return;                       // сеть моргнула — попробуем на следующем тике
  }
  if (!Array.isArray(ждут) || !ждут.length) return;

  for (const ролик of ждут) {
    // Заголовок задан прямо — название при этом любое.
    const заголовок = (ролик.hook ?? '').trim() || заголовокИз(ролик.name);
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

      await fetch(`${url}/rest/v1/incoming_videos?id=eq.${ролик.id}`, {
        method: 'PATCH',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_url: `${url}/storage/v1/object/public/post-photos/${путь}`,
          polished_at: new Date().toISOString(),
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

let занят = false;
async function tick() {
  if (занят) return;
  занят = true;
  try {
    // Первым делом: подтверждение доделок не должно ждать обработки роликов.
    // Обработка занимает минуты, а Татьяне важно услышать «принял» сразу.
    await подтвердитьДоделки();
    await разбудитьЕслиЖдут();
    await просмотр(readyDir, false);
    await просмотр(dubDir, true);
    await просмотр(noSubsDir, false);
    await присланныеБоту();
  } finally {
    занят = false;
  }
}

await tick();
setInterval(tick, POLL_MS);
