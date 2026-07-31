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
import { pathToFileURL } from 'node:url';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const POLL_MS = 5000;
// Модуль озвучки живёт в соседнем проекте «Генерация роликов» — там же его
// зависимости (msedge-tts).
const DUB_MODULE = join(
  homedir(), 'Downloads', 'Обучение', 'CLAUD', 'Генерация роликов',
  'scripts', 'lib', 'dub.mjs',
);

const stableSizes = new Map();

const root = new URL('..', import.meta.url);
const env = {};
for (const line of readFileSync(new URL('.env', root), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

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
const doneDir = join(base, '3 Ушло в постинг');
const failDir = join(base, 'Ошибка');
for (const dir of [promptDir, join(promptDir, 'Сделай платно'), readyDir, dubDir, doneDir, failDir]) {
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
console.log('Окно можно свернуть. Закрыть — значит остановить.\n');

/** Запускает ffmpeg/ffprobe и отдаёт stdout. */
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

    await send(рабочий, meta, filePath);
    moveTo(doneDir, filePath, переозвучить ? 'голос Дмитрия' : 'звук родной');
    if (meta.taskPath && existsSync(meta.taskPath)) moveTo(doneDir, meta.taskPath);
    console.log('готово, ролик во «Входящих».');
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
let занят = false;
async function tick() {
  if (занят) return;
  занят = true;
  try {
    await просмотр(readyDir, false);
    await просмотр(dubDir, true);
  } finally {
    занят = false;
  }
}

await tick();
setInterval(tick, POLL_MS);
