// Живой тест Этапа 4 (чекап 4): цепочка из 2 шагов (задержки 2 и 4 мин),
// пауза после первого шага, возобновление со сдвигом, статус done.
// Запуск: node scripts/test-stage4.mjs  (полный прогон ~7-8 минут)
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL?.replace(/\/$/, '');
const anon = env.SUPABASE_ANON_KEY;
const t0 = Date.now();
const stamp = () => `[+${((Date.now() - t0) / 60000).toFixed(1)} мин]`;
const log = (msg) => console.log(`${stamp()} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Вход
const loginRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: anon, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.TEST_USER_EMAIL, password: env.TEST_USER_PASSWORD }),
});
const login = await loginRes.json();
if (!loginRes.ok) { console.error('Вход не удался'); process.exit(1); }
const headers = { apikey: anon, Authorization: `Bearer ${login.access_token}`, 'Content-Type': 'application/json' };

const rest = async (path, opts = {}) => {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const invoke = async (fn, payload) => {
  const res = await fetch(`${url}/functions/v1/${fn}`, {
    method: 'POST', headers, body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const { body: bots } = await rest('bots?select=id&limit=1');
const { body: chats } = await rest('chats?select=id&limit=1');

// 1. Цепочка с 2 шагами: задержки 2 и 4 минуты
const { body: chainRows } = await rest('message_chains', {
  method: 'POST', headers: { Prefer: 'return=representation' },
  body: JSON.stringify({ name: 'Тестовая цепочка (чекап 4)' }),
});
const chain = chainRows[0];
await rest('chain_steps', {
  method: 'POST',
  body: JSON.stringify([
    { chain_id: chain.id, position: 1, delay_minutes: 2, format: 'text', text: '🔗 Цепочка, шаг 1/2 (задержка 2 мин)' },
    { chain_id: chain.id, position: 2, delay_minutes: 4, format: 'text', text: '🔗 Цепочка, шаг 2/2 (задержка 4 мин; если вы видите это ПОЗЖЕ — работала пауза)' },
  ]),
});
log(`Цепочка «${chain.name}» с 2 шагами создана`);

// 2. Запуск
const { status: actStatus, body: act } = await invoke('activate-chain', {
  chain_id: chain.id, bot_id: bots[0].id, chat_id: chats[0].id,
});
if (actStatus !== 200) { console.error(`activate-chain: ${JSON.stringify(act)}`); process.exit(1); }
log(`Цепочка запущена (id ${act.id}), шагов: ${act.steps}`);

const stepsState = async () => {
  const { body } = await rest(`active_chain_steps?active_chain_id=eq.${act.id}&select=status,scheduled_at,tg_message_id,error&order=scheduled_at`);
  return body;
};
const chainState = async () => {
  const { body } = await rest(`active_chains?id=eq.${act.id}&select=status`);
  return body?.[0]?.status;
};

// 3. Ждём отправку шага 1, затем сразу пауза
let paused = false;
let originalStep2At = null;
for (let i = 0; i < 20; i++) {
  await sleep(15_000);
  const steps = await stepsState();
  if (!originalStep2At) originalStep2At = steps[1]?.scheduled_at;
  if (steps[0]?.status === 'sent' && !paused) {
    log(`Шаг 1 отправлен (tg_message_id ${steps[0].tg_message_id}) — ставлю паузу`);
    const { status: pStatus, body: pBody } = await invoke('toggle-chain', { active_chain_id: act.id, action: 'pause' });
    if (pStatus !== 200) { console.error(`pause: ${JSON.stringify(pBody)}`); process.exit(1); }
    log(`Цепочка на паузе (статус: ${pBody.status})`);
    paused = true;
    break;
  }
  if (steps[0]?.status === 'failed') { console.error(`Шаг 1 failed: ${steps[0].error}`); process.exit(1); }
}
if (!paused) { console.error('Шаг 1 не отправился за 5 минут'); process.exit(1); }

// 4. Пережидаем исходное время шага 2 — он НЕ должен отправиться
const waitUntil = new Date(originalStep2At).getTime() + 45_000;
log(`Жду ${(Math.max(0, waitUntil - Date.now()) / 60000).toFixed(1)} мин — за это время шаг 2 отправиться НЕ должен`);
while (Date.now() < waitUntil) await sleep(15_000);

const midSteps = await stepsState();
if (midSteps[1].status !== 'scheduled') {
  console.error(`ПРОВАЛ ПАУЗЫ: шаг 2 в статусе ${midSteps[1].status}, хотя цепочка на паузе`);
  process.exit(1);
}
log(`Проверка паузы: OK — время шага 2 прошло, но он не отправлен (статус: ${midSteps[1].status}, цепочка: ${await chainState()})`);

// 5. Возобновление
const { status: rStatus, body: rBody } = await invoke('toggle-chain', { active_chain_id: act.id, action: 'resume' });
if (rStatus !== 200) { console.error(`resume: ${JSON.stringify(rBody)}`); process.exit(1); }
const afterResume = await stepsState();
const shiftMin = (new Date(afterResume[1].scheduled_at) - new Date(originalStep2At)) / 60000;
log(`Возобновлена. Шаг 2 сдвинут на ${shiftMin.toFixed(1)} мин (это длительность паузы)`);

// 6. Ждём шаг 2 и статус done
for (let i = 0; i < 20; i++) {
  await sleep(15_000);
  const steps = await stepsState();
  if (steps[1]?.status === 'sent') {
    log(`Шаг 2 отправлен (tg_message_id ${steps[1].tg_message_id})`);
    await sleep(20_000); // дать планировщику проставить done
    const st = await chainState();
    console.log(`\nИТОГ: оба шага sent, сдвиг ${shiftMin.toFixed(1)} мин, статус цепочки: ${st}`);
    process.exit(st === 'done' ? 0 : 1);
  }
  if (steps[1]?.status === 'failed') { console.error(`Шаг 2 failed: ${steps[1].error}`); process.exit(1); }
}
console.error('Шаг 2 не отправился за 5 минут после возобновления');
process.exit(1);
