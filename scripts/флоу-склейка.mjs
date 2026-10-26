// Склейка «неожиданного начала» из Flow с роликом Gemini (принцип 1а, 26.10.2026).
//
// Заказчица: «Неожиданность — 2–3 сек из Flow и 10 сек остальное в Gemini.
// Давай попробуем 12–13 сек». Flow-пролёт 4 с, в ролик идёт только
// сам полёт: отрезок [с, по] сжимается до нужной длины и ставится перед роликом
// Gemini. Пролёт во Flow генерируют на 4 с. Звук Flow не берём — ускоренный он рвётся; под пролётом тишина,
// дальше звук Gemini как есть.
//
//   node scripts/флоу-склейка.mjs <flow.mp4> <gemini.mp4> <итог.mp4> [с=0] [по=конец] [длина=2.5]
//
// Пролёт должен кончаться на первом кадре ролика Gemini — тогда стык не виден.

import { spawnSync } from 'node:child_process';

const [flow, gemini, итог, с = '0', по = '', длина = '2.5'] = process.argv.slice(2);
if (!flow || !gemini || !итог) {
  console.error('нужно: <flow.mp4> <gemini.mp4> <итог.mp4> [с] [по] [длина]');
  process.exit(1);
}

const длит = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim());

const начало = Number(с);
const конец = по ? Number(по) : длит(flow);
const нужно = Number(длина);
const сжатие = нужно / (конец - начало);
if (!(сжатие > 0) || сжатие > 1.0001) {
  console.error(`отрезок ${начало}–${конец} с короче нужных ${нужно} с — растягивать не буду`);
  process.exit(1);
}

const кадр = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1';
const фильтр =
  `[0:v]trim=${начало}:${конец},setpts=(PTS-STARTPTS)*${сжатие.toFixed(5)},${кадр}[v0];` +
  `anullsrc=r=48000:cl=stereo,atrim=0:${нужно}[a0];` +
  `[1:v]${кадр},setpts=PTS-STARTPTS[v1];` +
  `[1:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a1];` +
  `[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`;

const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', flow, '-i', gemini,
  '-filter_complex', фильтр, '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', итог], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(r.stderr.slice(-600));
  process.exit(1);
}
console.log(`готово: ${итог} — пролёт ${начало}–${конец} с сжат до ${нужно} с, всего ${длит(итог).toFixed(2)} с`);
