/**
 * Микшер музыки для YouTube-очереди, порядок от 29.08.
 *
 *   node scripts/ютуб-микс.mjs
 *
 * Заказчица выбирает отрывок в VibePost (кнопочки ▶ в карточке ролика) —
 * выбор ложится в youtube_publish_queue.chosen_candidate_id. Этот скрипт
 * вшивает выбранный отрывок под речь, заливает результат в storage и ставит
 * ролик в расписание (по 2 в день, 10:00 и 17:00 МСК, в хвост назначенных).
 * Дальше облачный воркер сам заливает его в студию скрытым с publishAt.
 *
 * Ничего не выбрано — ролик стоит в draft и никуда не уходит.
 *
 * Видеопоток не перекодируется (-c:v copy): картинка не портится, кадры не
 * режутся (amix duration=first, грабля «-shortest» обойдена). Отрывок 10-11 с
 * ложится с начала ролика, громкость 0.2, затухание в конце.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const корень = dirname(dirname(fileURLToPath(import.meta.url)));
const env = {};
for (const line of readFileSync(join(корень, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL.replace(/\/$/, '');
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: key, Authorization: `Bearer ${key}` };
const hj = { ...h, 'Content-Type': 'application/json' };

const строки = await (await fetch(
  `${url}/rest/v1/youtube_publish_queue?status=eq.draft&chosen_candidate_id=not.is.null` +
  `&select=id,title,storage_bucket,storage_path,chosen_candidate_id,music_storage_path,scheduled_at` +
  `&order=updated_at.asc`,
  { headers: h },
)).json();

const работа = [];
for (const р of строки) {
  const [к] = await (await fetch(
    `${url}/rest/v1/music_candidates?id=eq.${р.chosen_candidate_id}&select=storage_bucket,storage_path,title`,
    { headers: h },
  )).json();
  // Уже вшит этот же отрывок — пропускаем; выбор сменился — перевошьём.
  if (к && р.music_storage_path !== к.storage_path) работа.push({ ...р, отрывок: к });
}
if (!работа.length) {
  console.log('Вшивать нечего.');
} else {
await основная();
}

async function основная() {
console.log(`Роликов с выбранной музыкой: ${работа.length}`);

const [последний] = await (await fetch(
  `${url}/rest/v1/youtube_publish_queue?status=in.(scheduled,processing,uploaded)` +
  `&select=scheduled_at&order=scheduled_at.desc&limit=1`,
  { headers: h },
)).json();
function следующийСлот(после) {
  const т = new Date(после);
  for (const час of [7, 14]) { // 10:00 и 17:00 МСК
    const с = new Date(Date.UTC(т.getUTCFullYear(), т.getUTCMonth(), т.getUTCDate(), час));
    if (с > т && с > new Date()) return с;
  }
  const з = new Date(т); з.setUTCDate(з.getUTCDate() + 1);
  return new Date(Date.UTC(з.getUTCFullYear(), з.getUTCMonth(), з.getUTCDate(), 7));
}
let слот = последний ? new Date(последний.scheduled_at) : new Date();

const скачать = async (bucket, path, файл) => {
  const r = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, { headers: h });
  if (!r.ok) throw new Error(`скачивание ${path}: ${r.status}`);
  writeFileSync(файл, Buffer.from(await r.arrayBuffer()));
};

let готово = 0;
for (const р of работа) {
  const врем = mkdtempSync(join(tmpdir(), 'ytmix-'));
  try {
    const видео = join(врем, 'in.mp4');
    const музыка = join(врем, 'music.mp3');
    const выход = join(врем, 'out.mp4');
    const бакет = р.storage_bucket ?? 'post-photos';
    // Всегда мешаем от оригинала, а не от прошлого микса.
    const оригинал = р.storage_path.replace(/-music\.mp4$/i, '.mp4');
    await скачать(бакет, оригинал, видео);
    await скачать(р.отрывок.storage_bucket, р.отрывок.storage_path, музыка);

    const длит = parseFloat(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', видео,
    ], { encoding: 'utf8' }).trim());
    const затухание = Math.max(длит - 1.2, 0).toFixed(2);

    execFileSync('ffmpeg', [
      '-y', '-i', видео, '-stream_loop', '-1', '-i', музыка,
      '-filter_complex',
      // 0.2 было неслышно на телефоне (жалоба 30.08: «все без музыки») —
      // музыка должна читаться фоном, ~6-8 дБ под речью.
      `[1:a]volume=0.7,afade=t=out:st=${затухание}:d=1.2[m];` +
      `[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      выход,
    ], { stdio: 'pipe' });

    const новыйПуть = оригинал.replace(/\.mp4$/i, '') + '-music.mp4';
    const залив = await fetch(`${url}/storage/v1/object/${бакет}/${новыйПуть}`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
      body: readFileSync(выход),
    });
    if (!залив.ok) throw new Error(`заливка: ${залив.status}`);

    // Если заказчица назначила ролику своё время и оно в будущем — держим его,
    // хвост расписания только для роликов без срока.
    const своёВремя = new Date(р.scheduled_at ?? 0);
    if (своёВремя > new Date()) {
      var слотРолика = своёВремя;
    } else {
      слот = следующийСлот(слот);
      слотРолика = слот;
    }
    const патч = await fetch(`${url}/rest/v1/youtube_publish_queue?id=eq.${р.id}`, {
      method: 'PATCH', headers: hj,
      body: JSON.stringify({
        storage_path: новыйПуть,
        music_storage_path: р.отрывок.storage_path,
        music_mixed_at: new Date().toISOString(),
        status: 'scheduled',
        scheduled_at: слотРолика.toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
    if (!патч.ok) throw new Error(`обновление очереди: ${патч.status}`);
    готово++;
    console.log(`  вшито: ${р.title} + «${р.отрывок.title}» → ${слот.toISOString()}`);
  } catch (e) {
    console.error(`  СБОЙ: ${р.title} — ${String(e.message).slice(0, 160)}`);
  } finally {
    rmSync(врем, { recursive: true, force: true });
  }
}
console.log(`Готово: ${готово} из ${работа.length}.`);
}
