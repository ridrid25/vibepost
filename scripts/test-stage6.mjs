// Живой тест Этапа 6 (чекап 6): пост с неверным Chat ID →
// failed + запись в notifications + сообщение в личный Telegram.
// Запуск: node scripts/test-stage6.mjs
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL?.replace(/\/$/, '');
const anon = env.SUPABASE_ANON_KEY;
const notifyTgId = env.ERROR_NOTIFY_TG_ID;
if (!notifyTgId) { console.error('В .env пуст ERROR_NOTIFY_TG_ID'); process.exit(1); }

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

const { body: bots } = await rest('bots?select=id&limit=1');
const botId = bots[0].id;

// 1. Настройки уведомлений в профиле (как это сделает страница «Настройки»)
const { status: profStatus } = await rest('profiles', {
  method: 'PATCH',
  body: JSON.stringify({ error_notify_tg_id: notifyTgId, error_notify_bot_id: botId }),
});
if (profStatus >= 300) { console.error('Не удалось обновить профиль'); process.exit(1); }
console.log('Профиль: уведомления настроены (Telegram ID + бот)');

// 2. «Сломанный» чат с несуществующим Chat ID
const { status: chatStatus, body: chatRows } = await rest('chats', {
  method: 'POST',
  headers: { Prefer: 'return=representation' },
  body: JSON.stringify({
    bot_id: botId,
    title: 'ТЕСТ: сломанный чат',
    telegram_chat_id: '-100999999999999',
    type: 'channel',
  }),
});
if (chatStatus !== 201) { console.error('Чат не создался:', JSON.stringify(chatRows)); process.exit(1); }
const badChat = chatRows[0];
console.log('Создан чат с заведомо неверным Chat ID');

// 3. Пост в него — на ближайшую минуту
const { status: postStatus, body: postRows } = await rest('posts', {
  method: 'POST',
  headers: { Prefer: 'return=representation' },
  body: JSON.stringify({
    bot_id: botId,
    chat_id: badChat.id,
    format: 'text',
    text: 'Этот пост никогда не дойдёт — Chat ID неверный (тест чекапа 6)',
    scheduled_at: new Date().toISOString(),
  }),
});
if (postStatus !== 201) { console.error('Пост не создался:', JSON.stringify(postRows)); process.exit(1); }
const post = postRows[0];
console.log('Пост запланирован, ждём планировщик...');

// 4. Ждём failed
let finalPost = null;
for (let i = 0; i < 16; i++) {
  await new Promise((r) => setTimeout(r, 15_000));
  const { body: rows } = await rest(`posts?id=eq.${post.id}&select=status,error`);
  if (rows?.[0] && !['scheduled', 'processing'].includes(rows[0].status)) { finalPost = rows[0]; break; }
}
if (!finalPost) { console.error('Пост не обработался за 4 минуты'); process.exit(1); }
console.log(`Статус поста: ${finalPost.status}`);
console.log(`Текст ошибки в БД: ${finalPost.error}`);

// 5. Уведомление в notifications (колокольчик)
await new Promise((r) => setTimeout(r, 5_000));
const { body: notifs } = await rest('notifications?select=type,message,is_read&order=created_at.desc&limit=1');
if (notifs?.length) {
  console.log(`Уведомление в БД: [${notifs[0].type}] непрочитанное=${!notifs[0].is_read}`);
  console.log(`Текст: ${notifs[0].message.split('\n')[0]}...`);
} else {
  console.error('Уведомление в notifications НЕ появилось');
  process.exit(1);
}

// 6. Уборка: сломанный чат удаляем (пост уйдёт каскадом), уведомление оставляем
await rest(`chats?id=eq.${badChat.id}`, { method: 'DELETE' });
console.log('Сломанный чат удалён (уборка)');

console.log(`\nИТОГ: ${finalPost.status === 'failed' ? 'чекап 6 на стороне БД пройден' : 'ПРОВАЛ'}. Проверьте личный Telegram!`);
process.exit(finalPost.status === 'failed' ? 0 : 1);
