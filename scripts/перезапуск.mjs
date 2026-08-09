/**
 * Кнопка «Перезапустить» из бота.
 *
 *   node scripts/перезапуск.mjs проверить  — просят ли перезапуск (снимает флаг)
 *
 * Печатает ПРОСЯТ или НЕТ. Дежурный зовёт это первым делом при старте.
 *
 * Почему не долгоживущий воркер с мгновенной кнопкой: дежурный разовый и
 * поднимается планировщиком каждый час. Свежий запуск сам по себе и есть
 * перезапуск — вечная сессия накапливает блокировки и ложится на них,
 * а разовая начинает с чистого листа.
 */
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL?.replace(/\/$/, '');
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

if (process.argv[2] !== 'проверить') {
  console.log('команда: проверить');
  process.exit(0);
}

try {
  const [строка] = await (await fetch(
    `${url}/rest/v1/worker_control?id=eq.1&select=restart_requested`,
    { headers: h, signal: AbortSignal.timeout(20000) },
  )).json();

  if (!строка?.restart_requested) {
    console.log('НЕТ');
    process.exit(0);
  }

  await fetch(`${url}/rest/v1/worker_control?id=eq.1`, {
    method: 'PATCH', headers: h, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ restart_requested: false, handled_at: new Date().toISOString() }),
  });
  console.log('ПРОСЯТ');
} catch (e) {
  // Не смогли спросить — не повод не работать.
  console.log('НЕТ');
}
