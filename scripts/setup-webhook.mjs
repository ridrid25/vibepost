// Регистрация telegram-webhook:
// 1) кладёт TELEGRAM_WEBHOOK_SECRET из .env в Vault (RPC setup_webhook_secret);
// 2) вызывает setWebhook у Telegram с секретом и allowed_updates
//    ["message","message_reaction","message_reaction_count"] — без
//    message_reaction* реакции просто не приходят (ограничение Telegram).
// Секреты в консоль не печатаются. Запуск: node scripts/setup-webhook.mjs
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL?.replace(/\/$/, '');
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const botToken = env.TELEGRAM_TEST_BOT_TOKEN;
const secret = env.TELEGRAM_WEBHOOK_SECRET;
if (!url || !serviceKey || !botToken || !secret) {
  console.error('В .env не хватает SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TELEGRAM_TEST_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET');
  process.exit(1);
}

// 1. Секрет — в Vault
const vaultRes = await fetch(`${url}/rest/v1/rpc/setup_webhook_secret`, {
  method: 'POST',
  headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_secret: secret }),
});
if (!vaultRes.ok) { console.error('Vault:', await vaultRes.text()); process.exit(1); }
console.log('Секрет вебхука сохранён в Vault');

// 2. setWebhook у Telegram
const hookUrl = `${url}/functions/v1/telegram-webhook`;
const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: hookUrl,
    secret_token: secret,
    // callback_query нужен для кнопок под карточками идей — без него
    // нажатия просто не доходят до нас.
    allowed_updates: [
      'message',
      'message_reaction',
      'message_reaction_count',
      'callback_query',
    ],
  }),
});
const tg = await tgRes.json();
if (!tg.ok) { console.error('setWebhook:', tg.description); process.exit(1); }
console.log('setWebhook: OK');

// 3. Меню команд бота (кнопка «Меню» в чате)
const cmdRes = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    commands: [
      { command: 'status', description: 'Всё ли работает' },
      { command: 'queue', description: 'Ближайшие публикации' },
      { command: 'today', description: 'Сводка за день' },
      { command: 'sos', description: 'Что делать, если сломалось' },
    ],
  }),
});
console.log(`Меню команд: ${(await cmdRes.json()).ok ? 'OK' : 'ошибка'}`);

// 4. Контроль
const info = await (await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`)).json();
console.log(`Вебхук: ${info.result?.url === hookUrl ? 'зарегистрирован правильно' : 'АДРЕС НЕ СОВПАДАЕТ'}`);
console.log(`Ожидающих обновлений: ${info.result?.pending_update_count ?? 0}`);
