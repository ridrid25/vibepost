// Живой тест Этапа 3: шаблон → пост из шаблона → канал.
// Запуск: node scripts/test-stage3.mjs
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL?.replace(/\/$/, '');
const anon = env.SUPABASE_ANON_KEY;

// Вход тестовым пользователем
const loginRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: anon, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.TEST_USER_EMAIL, password: env.TEST_USER_PASSWORD }),
});
const login = await loginRes.json();
if (!loginRes.ok) { console.error('Вход не удался:', login.msg ?? loginRes.status); process.exit(1); }
const jwt = login.access_token;
const headers = { apikey: anon, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };
console.log('Вход выполнен');

const rest = async (path, opts = {}) => {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

// Свои бот и чат (RLS отдаёт только свои)
const { body: bots } = await rest('bots?select=id,username&limit=1');
const { body: chats } = await rest('chats?select=id,title&limit=1');
if (!bots?.length || !chats?.length) { console.error('Нет бота или чата у тестового пользователя'); process.exit(1); }

// 1. Создаём шаблон (как это сделает страница «Шаблоны»)
const { status: tplStatus, body: tplBody } = await rest('message_templates', {
  method: 'POST',
  headers: { Prefer: 'return=representation' },
  body: JSON.stringify({
    name: 'Анонс из шаблона',
    format: 'text',
    text: '📋 Тест Этапа 3: этот пост создан ИЗ ШАБЛОНА в один вызов',
    inline_buttons: [[{ text: 'Кнопка из шаблона', url: 'https://t.me' }]],
    disable_link_preview: true,
  }),
});
if (tplStatus !== 201) { console.error('Шаблон не создался:', JSON.stringify(tplBody)); process.exit(1); }
const template = tplBody[0];
console.log(`Шаблон создан: «${template.name}»`);

// 2. Пост из шаблона одним вызовом RPC (кнопка «Запланировать из шаблона»)
const scheduledAt = new Date(Date.now() + 60_000).toISOString();
const { status: rpcStatus, body: post } = await rest('rpc/create_post_from_template', {
  method: 'POST',
  body: JSON.stringify({
    p_template_id: template.id,
    p_bot_id: bots[0].id,
    p_chat_id: chats[0].id,
    p_scheduled_at: scheduledAt,
  }),
});
if (rpcStatus !== 200) { console.error('create_post_from_template:', JSON.stringify(post)); process.exit(1); }
console.log(`Пост из шаблона запланирован на +60 сек (id ${post.id}), формат: ${post.format}`);

// 3. Негативный тест: чужой/несуществующий бот должен быть отвергнут
const { status: badStatus, body: badBody } = await rest('rpc/create_post_from_template', {
  method: 'POST',
  body: JSON.stringify({
    p_template_id: template.id,
    p_bot_id: '00000000-0000-0000-0000-000000000000',
    p_chat_id: chats[0].id,
    p_scheduled_at: scheduledAt,
  }),
});
console.log(badStatus >= 400
  ? `Негативный тест: OK — чужой бот отвергнут (${badBody?.message ?? badStatus})`
  : 'Негативный тест: ПРОВАЛ — пост с чужим ботом прошёл!');

// 4. Ждём отправку планировщиком
for (let i = 0; i < 16; i++) {
  await new Promise((r) => setTimeout(r, 15_000));
  const { body: rows } = await rest(`posts?id=eq.${post.id}&select=status,tg_message_id,error`);
  const p = rows?.[0];
  if (p && p.status !== 'scheduled' && p.status !== 'processing') {
    console.log(`\nИтог: статус=${p.status}, tg_message_id=${p.tg_message_id}, ошибка=${p.error ?? 'нет'}`);
    process.exit(p.status === 'sent' ? 0 : 1);
  }
}
console.error('Таймаут: пост не отправился за 4 минуты');
process.exit(1);
