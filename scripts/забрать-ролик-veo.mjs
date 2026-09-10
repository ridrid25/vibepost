/**
 * Забирает готовый ролик по операции Veo, запущенной проверкой промта.
 *
 *   node scripts/забрать-ролик-veo.mjs <operation> [куда.mp4]
 *
 * Зачем отдельно от veo-poll: тот забирает только то, что записано в veo_jobs
 * кнопкой «Сгенерируй». Прогон из `проверить-промт-в-veo.mjs` в очередь не
 * попадает, и без этого скрипта оплаченный ролик просто пропал бы.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
const b64url = (д) => Buffer.from(д).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function токенGoogle() {
  const сырой = await (await fetch(`${url}/rest/v1/rpc/get_secret`, {
    method: 'POST', headers: h, body: JSON.stringify({ p_name: 'google_sa_json' }),
  })).json();
  const sa = JSON.parse(сырой);
  const сейчас = Math.floor(Date.now() / 1000);
  const шапка = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const тело = b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token', iat: сейчас, exp: сейчас + 3600,
  }));
  const подпись = createSign('RSA-SHA256').update(`${шапка}.${тело}`).sign(sa.private_key);
  const т = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${шапка}.${тело}.${b64url(подпись)}`,
    }),
  })).json();
  return { токен: т.access_token, проект: sa.project_id };
}

const операция = process.argv[2];
const куда = process.argv[3] ?? 'volk.mp4';
if (!операция) { console.error('укажите operation'); process.exit(1); }

const { токен, проект } = await токенGoogle();
const модель = операция.split('/models/')[1].split('/operations/')[0];
const адрес = `https://us-central1-aiplatform.googleapis.com/v1/projects/${проект}` +
  `/locations/us-central1/publishers/google/models/${модель}:fetchPredictOperation`;

for (let попытка = 1; попытка <= 40; попытка++) {
  const о = await (await fetch(адрес, {
    method: 'POST',
    headers: { Authorization: `Bearer ${токен}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationName: операция }),
  })).json();

  if (о.error) { console.log('ошибка:', JSON.stringify(о.error).slice(0, 500)); process.exit(2); }
  if (!о.done) { process.stdout.write('.'); await new Promise((r) => setTimeout(r, 10000)); continue; }

  const видео = о.response?.videos?.[0] ?? о.response?.generatedSamples?.[0];
  const байты = видео?.bytesBase64Encoded ?? видео?.video?.bytesBase64Encoded;
  const ссылка = видео?.gcsUri ?? видео?.video?.uri;
  if (байты) {
    writeFileSync(куда, Buffer.from(байты, 'base64'));
    console.log(`\nготово: ${куда}`);
  } else if (ссылка) {
    console.log(`\nготово, лежит в облаке: ${ссылка}`);
  } else {
    // Фильтр мог отсеять уже готовый кадр — тогда причина в ответе операции.
    console.log('\nвидео в ответе нет:', JSON.stringify(о.response ?? о).slice(0, 700));
  }
  process.exit(0);
}
console.log('\nне дождался за семь минут — операция ещё идёт');
