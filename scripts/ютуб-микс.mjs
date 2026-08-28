/**
 * Микшер музыки для YouTube-очереди.
 *
 *   node scripts/ютуб-микс.mjs
 *
 * Татьяна выбирает трек к ролику в VibePost (закладка с роликами). Этот
 * скрипт находит такие ролики, вшивает музыку ffmpeg-ом (тихо, под речь),
 * заливает результат в storage и ставит ролик в расписание — по 2 в день,
 * 10:00 и 17:00 МСК, в хвост уже назначенных.
 *
 * Видеопоток не перекодируется (-c:v copy): картинка не портится, кадры не
 * режутся — известная грабля «-shortest» обойдена (amix duration=first).
 * Музыка: громкость 0.2 от исходной, затухание в конце, длина ровно по видео.
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
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

const ждущие = await (await fetch(
  `${url}/rest/v1/youtube_publish_queue?status=eq.draft&music_track_id=not.is.null` +
  `&select=id,title,description,storage_bucket,storage_path,music_track_id,music_storage_path,music_added_at,music_mixed_at` +
  `&order=music_added_at.asc`,
  { headers: h },
)).json();
const работа = ждущие.filter((r) =>
  r.storage_path && r.music_storage_path &&
  (!r.music_mixed_at || r.music_added_at > r.music_mixed_at));
if (!работа.length) {
  // process.exit здесь роняет libuv на Windows (незакрытый fetch) — выходим тихо.
  console.log('Вшивать нечего.');
} else {
await основная();
}

async function основная() {
console.log(`Роликов с выбранной музыкой: ${работа.length}`);

// Хвост расписания: продолжаем по 2 в день после последнего назначенного.
const [последний] = await (await fetch(
  `${url}/rest/v1/youtube_publish_queue?status=eq.scheduled&select=scheduled_at` +
  `&order=scheduled_at.desc&limit=1`,
  { headers: h },
)).json();
function следующийСлот(после) {
  const т = new Date(после);
  const слоты = [7, 14]; // 10:00 и 17:00 МСК
  for (const час of слоты) {
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
  const { writeFileSync } = await import('node:fs');
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
    await скачать(бакет, р.storage_path, видео);
    await скачать('post-photos', р.music_storage_path, музыка);

    const длит = parseFloat(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', видео,
    ], { encoding: 'utf8' }).trim());
    const затухание = Math.max(длит - 1.2, 0).toFixed(2);

    execFileSync('ffmpeg', [
      '-y', '-i', видео, '-stream_loop', '-1', '-i', музыка,
      '-filter_complex',
      `[1:a]volume=0.2,afade=t=out:st=${затухание}:d=1.2[m];` +
      `[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      выход,
    ], { stdio: 'pipe' });

    const новыйПуть = р.storage_path.replace(/\.mp4$/i, '') + '-music.mp4';
    const тело = readFileSync(выход);
    const залив = await fetch(`${url}/storage/v1/object/${бакет}/${новыйПуть}`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
      body: тело,
    });
    if (!залив.ok) throw new Error(`заливка: ${залив.status} ${(await залив.text()).slice(0, 120)}`);

    // Лицензия CC BY: автор трека обязан быть в описании ролика.
    let описание = р.description ?? '';
    if (р.music_track_id) {
      const [трек] = await (await fetch(
        `${url}/rest/v1/music_tracks?id=eq.${р.music_track_id}&select=attribution`, { headers: h },
      )).json();
      if (трек?.attribution && !описание.includes(трек.attribution)) {
        описание = `${описание}\n\n${трек.attribution}`.trim();
      }
    }

    слот = следующийСлот(слот);
    const патч = await fetch(`${url}/rest/v1/youtube_publish_queue?id=eq.${р.id}`, {
      method: 'PATCH', headers: hj,
      body: JSON.stringify({
        storage_path: новыйПуть,
        description: описание,
        music_mixed_at: new Date().toISOString(),
        status: 'scheduled',
        scheduled_at: слот.toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
    if (!патч.ok) throw new Error(`обновление очереди: ${патч.status}`);
    готово++;
    console.log(`  вшито: ${р.title} → ${слот.toISOString()}`);
  } catch (e) {
    console.error(`  СБОЙ: ${р.title} — ${String(e.message).slice(0, 160)}`);
  } finally {
    rmSync(врем, { recursive: true, force: true });
  }
}
console.log(`Готово: ${готово} из ${работа.length}.`);
}
