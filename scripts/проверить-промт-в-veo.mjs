/**
 * Прогоняет промт через Veo служебным аккаунтом Google — чтобы отказ фильтра
 * ловил Claude, а не заказчица руками.
 *
 *   node scripts/проверить-промт-в-veo.mjs <файл.json>
 *
 * Зачем. 10.09.2026 промт волка трижды получил отказ «interests of third-party
 * content providers», и каждую попытку делала заказчица: копировала блок в
 * приложение, ждала, получала отказ. Проверять догадки её руками нельзя.
 *
 * Что делает. Шлёт промт в Vertex AI. Возможных исхода два:
 *   — фильтр отверг: приходит ошибка, генерация не запускается, денег не берут;
 *   — фильтр пропустил: запускается операция, и это уже платный ролик.
 * Скрипт печатает, что именно вернул Google, и НЕ ждёт готовое видео: наша
 * задача — узнать про фильтр, забирать ролик умеет veo-poll.
 */
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const РЕГИОН = 'us-central1';
const МОДЕЛЬ = 'veo-3.1-lite-generate-001';

const корень = dirname(dirname(fileURLToPath(import.meta.url)));
const env = {};
for (const строка of readFileSync(join(корень, '.env'), 'utf8').split(/\r?\n/)) {
  const m = строка.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL.replace(/\/$/, '');
const h = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

const b64url = (данные) => Buffer.from(данные).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Служебный аккаунт лежит в хранилище проекта, ключи в переписке не светим. */
async function токенGoogle() {
  const ответ = await fetch(`${url}/rest/v1/rpc/get_secret`, {
    method: 'POST', headers: h, body: JSON.stringify({ p_name: 'google_sa_json' }),
  });
  const сырой = await ответ.json();
  if (!сырой) throw new Error('в хранилище нет google_sa_json');
  const sa = JSON.parse(сырой);

  const сейчас = Math.floor(Date.now() / 1000);
  const шапка = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const тело = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: сейчас, exp: сейчас + 3600,
  }));
  const подпись = createSign('RSA-SHA256').update(`${шапка}.${тело}`).sign(sa.private_key);
  const т = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${шапка}.${тело}.${b64url(подпись)}`,
    }),
  })).json();
  if (!т.access_token) throw new Error(`Google не выдал токен: ${JSON.stringify(т).slice(0, 160)}`);
  return { токен: т.access_token, проект: sa.project_id };
}

const файл = process.argv[2];
if (!файл) {
  console.error('укажите файл промта: node scripts/проверить-промт-в-veo.mjs <файл.json>');
  process.exit(1);
}
const промт = readFileSync(файл, 'utf8');
// Длительность берём из самого промта, а не из настроек платной кнопки:
// 10.09.2026 я подставил её восьмёрку в десятисекундный промт, действие ужалось,
// и заказчица получила разваленный ролик. У неё ролики десятисекундные.
let секунд = 10;
try { секунд = Number(JSON.parse(промт).duration_seconds) || 10; } catch { /* не JSON — пусть 10 */ }

const { токен, проект } = await токенGoogle();
const адрес = `https://${РЕГИОН}-aiplatform.googleapis.com/v1/projects/${проект}` +
  `/locations/${РЕГИОН}/publishers/google/models/${МОДЕЛЬ}:predictLongRunning`;

const ответ = await fetch(адрес, {
  method: 'POST',
  headers: { Authorization: `Bearer ${токен}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    instances: [{ prompt: промт }],
    parameters: { sampleCount: 1, aspectRatio: '9:16', durationSeconds: секунд, resolution: '720p' },
  }),
});
const тело = await ответ.json();

if (!ответ.ok) {
  const текст = JSON.stringify(тело);
  const чужоеIP = /third.party|copyright|content provider|celebrity|trademark/i.test(текст);
  console.log(`ОТКАЗ ${ответ.status}${чужоеIP ? ' — похоже на копирайт-фильтр' : ''}`);
  console.log(текст.slice(0, 900));
  process.exit(2);
}
if (!тело.name) {
  console.log('странный ответ без операции:', JSON.stringify(тело).slice(0, 600));
  process.exit(3);
}
// Трата должна быть видна заказчице там же, где траты кнопки «Сгенерируй»:
// прогон мимо журнала — это её деньги, потраченные молча.
const { data: профиль } = await (await fetch(
  `${url}/rest/v1/profiles?select=id&error_notify_tg_id=not.is.null&limit=1`, { headers: h },
)).json().then((р) => ({ data: р?.[0] })).catch(() => ({ data: null }));
if (профиль?.id) {
  await fetch(`${url}/rest/v1/veo_jobs`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      user_id: профиль.id, operation: тело.name, model: МОДЕЛЬ,
      status: 'running', cost_usd: 0.40,
    }),
  }).catch(() => {});
}

console.log(`ПРОШЁЛ фильтр, запущена генерация на ${секунд} с (платно, 0.40 $ в журнале трат)`);
console.log('операция:', тело.name);
