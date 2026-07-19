// Живой тест Этапа 1: validate-bot и resolve-chat.
// Запуск: node scripts/test-stage1.mjs
// Читает .env (SUPABASE_URL, SUPABASE_ANON_KEY, TELEGRAM_TEST_BOT_TOKEN,
// TELEGRAM_TEST_CHAT_ID). Служебного пользователя создаёт сам и дописывает
// его данные в .env. Секреты в консоль не печатает.
import { readFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const envPath = new URL('../.env', import.meta.url);
const env = {};
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const url = env.SUPABASE_URL?.replace(/\/$/, '');
const anon = env.SUPABASE_ANON_KEY;
const botToken = env.TELEGRAM_TEST_BOT_TOKEN;
const chatId = env.TELEGRAM_TEST_CHAT_ID;
if (!url || !anon || !botToken || !chatId) {
  console.error('В .env не хватает SUPABASE_URL / SUPABASE_ANON_KEY / TELEGRAM_TEST_BOT_TOKEN / TELEGRAM_TEST_CHAT_ID');
  process.exit(1);
}

// 1. Служебный пользователь для тестов (создаём один раз, храним в .env)
let email = env.TEST_USER_EMAIL;
let password = env.TEST_USER_PASSWORD;
if (!email || !password) {
  email = 'ridsochi+vibepost.test@gmail.com';
  password = randomBytes(18).toString('base64url');
  const res = await fetch(`${url}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error('Регистрация тестового пользователя не удалась:', body.msg ?? body.error_description ?? res.status);
    process.exit(1);
  }
  appendFileSync(envPath, `\n# Служебный тестовый пользователь (создан автоматически для проверок)\nTEST_USER_EMAIL=${email}\nTEST_USER_PASSWORD=${password}\n`);
  console.log('Тестовый пользователь создан, данные дописаны в .env');
}

// 2. Вход → JWT
const loginRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: anon, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const login = await loginRes.json();
if (!loginRes.ok) {
  console.error(`Вход не удался (${loginRes.status}): ${login.error_code ?? ''} ${login.msg ?? login.error_description ?? ''}`);
  console.error(login.error_code === 'email_not_confirmed'
    ? 'Нужно подтвердить почту тестового пользователя (это сделает Claude через SQL).'
    : '');
  process.exit(2);
}
const jwt = login.access_token;
console.log('Вход выполнен, JWT получен');

const invoke = async (fn, payload) => {
  const res = await fetch(`${url}/functions/v1/${fn}`, {
    method: 'POST',
    headers: {
      apikey: anon,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// 3. validate-bot с реальным токеном из .env
const vb = await invoke('validate-bot', { token: botToken, name: 'Тестовый бот' });
if (vb.status !== 200) {
  console.error(`validate-bot: ошибка ${vb.status}: ${vb.body?.error ?? JSON.stringify(vb.body)}`);
  process.exit(3);
}
console.log(`validate-bot: OK — бот @${vb.body.username} записан, id=${vb.body.id}`);

// 4. resolve-chat с реальным каналом из .env
const rc = await invoke('resolve-chat', { bot_id: vb.body.id, telegram_chat_id: chatId });
if (rc.status !== 200) {
  console.error(`resolve-chat: ошибка ${rc.status}: ${rc.body?.error ?? JSON.stringify(rc.body)}`);
  process.exit(4);
}
console.log(`resolve-chat: OK — чат «${rc.body.title}» (тип: ${rc.body.type}) привязан, id=${rc.body.id}`);

console.log('\nЭтап 1: обе функции работают с реальным Telegram.');
