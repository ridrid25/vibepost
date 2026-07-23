// Настройка приёмника роликов ingest-video: кладёт секрет заголовка и
// user_id владельца из .env в Vault (через RPC store_ingest_config).
// Запуск: node scripts/setup-ingest.mjs   Секреты в консоль не печатает.
import { readFileSync } from 'node:fs';
const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL?.replace(/\/$/, '');
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key || !env.INGEST_SECRET || !env.INGEST_OWNER_ID) {
  console.error('В .env нужны SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, INGEST_SECRET, INGEST_OWNER_ID'); process.exit(1);
}
const res = await fetch(`${url}/rest/v1/rpc/store_ingest_config`, {
  method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_secret: env.INGEST_SECRET, p_owner: env.INGEST_OWNER_ID }),
});
console.log(res.ok ? 'Конфиг приёмника сохранён в Vault' : `Ошибка ${res.status}: ${await res.text()}`);
