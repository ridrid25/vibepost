/**
 * Переписывает строку хэштегов во всех уже готовых описаниях по свежим
 * счётчикам ТикТока.
 *
 *   node scripts/обновить-хэштеги.mjs          — показать, что получится
 *   node scripts/обновить-хэштеги.mjs записать — записать в карточки
 *
 * Зачем. 10.09.2026 счётчики показали: прежний набор (#финансы, #экономика,
 * #финансоваяграмотность) даёт 12–19 тысяч просмотров на ролик при сотнях
 * тысяч конкурентов, а #говорящиеживотные — 204 тысячи при тысяче роликов.
 * Новые описания завод уже пишет по-новому, но в готовых карточках остались
 * старые хэштеги. Этот скрипт правит только вторую строку — шутку не трогает.
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

// Формат канала: эти три подходят любому ролику и почти не заняты.
const ФОРМАТ = ['говорящиеживотные', 'озвучкаживотных', 'пиксар'];
// Денежный юмор: конкурентов сотни, а не миллионы.
const ЮМОР = ['финансовыйюмор'];

const ТЕМЫ = [
  // Латиница тоже: часть карточек названа по-английски (01-raccoon-inflation).
  ['инфляция', /инфляц|подорожа|ценник|цены|дорож|inflation/i],
  ['ценырастут', /подорожа|цены|ценник|дорож|price/i],
  ['ипотека', /ипотек|жиль|квартир|mortgage/i],
  ['налоги', /налог|фнс|вычет|деклар|tax/i],
  ['кредит', /кредит|долг|займ|рассрочк|коллектор|credit|loan|debt/i],
  ['зарплата', /зарплат|получк|оклад|премия|salary/i],
  ['сбережения', /копи|накопл|вклад|сбереж|депозит|подушк|saving/i],
  ['пенсия', /пенси|старост|pension/i],
  ['экономия', /эконом|скид|дешев|распродаж/i],
  ['банк', /банк|счёт|карта|перевод/i],
  ['страхование', /страхов|полис/i],
];

const темыТекста = (текст) => {
  const найдены = [];
  for (const [тег, шаблон] of ТЕМЫ) {
    if (шаблон.test(текст) && !найдены.includes(тег)) найдены.push(тег);
    if (найдены.length === 2) break;
  }
  return найдены;
};

/** Первая строка — шутка, её не трогаем. Вторая и дальше — хэштеги. */
function переписать(описание, живые, имя = '') {
  const строки = String(описание).split('\n').map((с) => с.trim()).filter(Boolean);
  const шутка = строки.filter((с) => !с.startsWith('#')).join(' ');
  if (!шутка) return null;
  const формат = ФОРМАТ.filter((т) => живые.has(т));
  const юмор = ЮМОР.filter((т) => живые.has(т));
  // Тему ищем и в шутке, и в названии карточки: слово «инфляция» часто
  // стоит только в имени ролика.
  const темы = темыТекста(`${имя} ${шутка}`).filter((т) => живые.has(т));
  const теги = [...new Set([...формат, ...юмор, ...темы])].slice(0, 6);
  if (теги.length < 3) return null;
  return `${шутка}\n${теги.map((т) => `#${т}`).join(' ')}`;
}

const записывать = process.argv.includes('записать');

const счётчики = await (await fetch(
  `${url}/rest/v1/tiktok_tegi?select=teg,na_rolik&order=na_rolik.desc`,
  { headers: h },
)).json();
const живые = new Set((счётчики ?? []).map((с) => с.teg));
if (живые.size < 10) {
  console.error('счётчиков тегов мало — сперва node scripts/теги-тиктока.mjs');
  process.exit(1);
}

const карточки = await (await fetch(
  `${url}/rest/v1/incoming_videos?or=(description_options.not.is.null,post_description.not.is.null)` +
  `&select=id,name,description_options,post_description`,
  { headers: h },
)).json();

let тронуто = 0;
for (const к of карточки) {
  const патч = {};
  if (Array.isArray(к.description_options) && к.description_options.length) {
    const новые = к.description_options
      .map((о) => переписать(о, живые, к.name))
      .filter(Boolean);
    if (новые.length) патч.description_options = новые;
  }
  if (к.post_description) {
    const новое = переписать(к.post_description, живые, к.name);
    if (новое) патч.post_description = новое;
  }
  if (!Object.keys(патч).length) continue;
  тронуто++;
  if (тронуто <= 3) {
    console.log(`— ${к.name}`);
    console.log(`  ${(патч.post_description ?? патч.description_options[0]).split('\n')[1]}`);
  }
  if (записывать) {
    await fetch(`${url}/rest/v1/incoming_videos?id=eq.${к.id}`, {
      method: 'PATCH', headers: h, body: JSON.stringify(патч),
    });
  }
}

console.log(записывать
  ? `переписано карточек: ${тронуто}`
  : `к переписи готово карточек: ${тронуто} (запустите с «записать»)`);
