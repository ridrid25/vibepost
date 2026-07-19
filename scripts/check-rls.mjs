// Мини-проверка RLS: анонимный клиент (anon key) не должен видеть данные.
// Запуск:  node scripts/check-rls.mjs
// Скрипт читает SUPABASE_URL и SUPABASE_ANON_KEY из .env — ключи в консоль не выводит.
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const url = env.SUPABASE_URL?.replace(/\/$/, '');
const anon = env.SUPABASE_ANON_KEY;
if (!url || !anon) {
  console.error('В .env не заполнены SUPABASE_URL / SUPABASE_ANON_KEY');
  process.exit(1);
}

const tables = [
  'profiles', 'bots', 'chats', 'message_templates', 'posts',
  'message_chains', 'chain_steps', 'active_chains', 'active_chain_steps',
  'post_analytics', 'notifications',
];

let failed = 0;
for (const table of tables) {
  const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=5`, {
    headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  });
  const body = await res.json().catch(() => null);
  const ok = res.ok && Array.isArray(body) && body.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${table.padEnd(20)} — аноним видит строк: ${Array.isArray(body) ? body.length : `ошибка HTTP ${res.status}`}`);
}

if (failed === 0) {
  console.log('\nRLS в порядке: анонимный клиент не видит ни одной строки ни в одной таблице.');
} else {
  console.error(`\nПроблема: ${failed} таблиц(ы) отдают данные анониму или недоступны!`);
  process.exit(1);
}
