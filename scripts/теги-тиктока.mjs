/**
 * Счётчики хэштегов ТикТока: сколько под тегом снято и сколько там смотрят.
 *
 *   node scripts/теги-тиктока.mjs
 *
 * Зачем. Заказчица искала «темы, на которых мало снято». Творческий центр
 * ТикТока отдаёт такие темы только после входа, зато публичная страница тега
 * отвечает всем: /api/challenge/detail возвращает videoCount и viewCount.
 * Делим одно на другое — получаем спрос на снятое.
 *
 * Почему с её машины, а не с сервера. Supabase ходит с адресов, которым TikTok
 * не отвечает: 10.09.2026 из Edge-функции пришло ноль тегов, а тот же запрос
 * с домашнего адреса отработал полностью. Поэтому собирает приёмник, а разбор
 * в облаке читает готовую таблицу `tiktok_tegi`.
 */
import { readFileSync } from 'node:fs';
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

export const ТЕГИ = [
  // деньги
  'финансы', 'деньги', 'финансоваяграмотность', 'инвестиции', 'кредит', 'ипотека',
  'налоги', 'зарплата', 'пенсия', 'накопления', 'сбережения', 'экономия', 'инфляция',
  'бюджет', 'долги', 'банк', 'вклад', 'маркетплейс', 'подписки', 'кэшбэк', 'налоговая',
  // формат канала
  'говорящиеживотные', 'озвучкаживотных', 'животныеговорят', 'говорящаясобака',
  'говорящийкот', 'смешныеживотные', 'животные', 'звери', 'мультик', 'пиксар',
  'анимация', '3danimation', 'нейросеть',
  // тон
  'юмор', 'сатира', 'сарказм', 'ирония', 'абсурд', 'чёрныйюмор', 'взрослыйюмор',
  'офисныйюмор', 'финансовыйюмор', 'юморпроденьги', 'мемы', 'приколы',
];

const ЗАГОЛОВКИ = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
  Accept: 'application/json',
};

export async function собратьТеги(теги = ТЕГИ) {
  const строки = [];
  for (const тег of теги) {
    try {
      const ответ = await fetch(
        `https://www.tiktok.com/api/challenge/detail/?challengeName=${encodeURIComponent(тег)}&aid=1988`,
        { headers: ЗАГОЛОВКИ, signal: AbortSignal.timeout(10000) },
      );
      const данные = await ответ.json();
      const s = данные?.challengeInfo?.statsV2;
      const роликов = Number(s?.videoCount ?? 0);
      const просмотров = Number(s?.viewCount ?? 0);
      // Меньше полусотни роликов — тег мёртвый, а не свободный.
      if (роликов > 50) {
        строки.push({
          teg: тег,
          rolikov: роликов,
          prosmotrov: просмотров,
          na_rolik: Math.round(просмотров / роликов),
          sobrano_at: new Date().toISOString(),
        });
      }
    } catch { /* тег пропускаем, сбор не роняем */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return строки;
}

export async function записатьТеги(строки) {
  if (!строки.length) return 0;
  const ответ = await fetch(`${url}/rest/v1/tiktok_tegi?on_conflict=teg`, {
    method: 'POST',
    headers: { ...h, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(строки),
  });
  if (!ответ.ok) throw new Error(`хранилище: ${ответ.status} ${(await ответ.text()).slice(0, 160)}`);
  return строки.length;
}

// Запущен напрямую — собираем и печатаем. Импортирован — молчим.
if (process.argv[1] && process.argv[1].endsWith('теги-тиктока.mjs')) {
  const строки = await собратьТеги();
  const сколько = await записатьТеги(строки);
  const лучшие = [...строки].filter((с) => с.rolikov < 50000)
    .sort((a, b) => b.na_rolik - a.na_rolik).slice(0, 5);
  console.log(`собрано тегов: ${сколько}`);
  for (const т of лучшие) {
    console.log(`  #${т.teg}: ${т.rolikov} роликов, ${т.na_rolik} просмотров на ролик`);
  }
}
