// Регистрация планировщика: кладёт URL проекта и service-ключ в Vault
// и создаёт cron-задачу vibepost-scheduler (раз в минуту) через RPC
// setup_scheduler. Ключ уходит по HTTPS напрямую в базу — в консоль
// и в чат не попадает. Запуск: node scripts/setup-scheduler.mjs
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const url = env.SUPABASE_URL?.replace(/\/$/, '');
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('В .env не заполнены SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const res = await fetch(`${url}/rest/v1/rpc/setup_scheduler`, {
  method: 'POST',
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ p_project_url: url, p_service_key: serviceKey }),
});

const body = await res.text();
if (!res.ok) {
  console.error(`Ошибка ${res.status}: ${body}`);
  process.exit(1);
}
console.log('Планировщик зарегистрирован:', body);
