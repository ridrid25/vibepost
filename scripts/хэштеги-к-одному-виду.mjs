/**
 * Приводит хэштеги во всех описаниях к одному набору — заводскому.
 *
 *   node scripts/хэштеги-к-одному-виду.mjs          — показать, что изменится
 *   node scripts/хэштеги-к-одному-виду.mjs записать — записать
 *
 * Зачем. 10.09.2026 я переписал 95 карточек своим набором
 * (#говорящиеживотные #озвучкаживотных #пиксар #финансовыйюмор), а завод
 * пишет другой (#shorts #говорящиеживотные #ценырастут #короткометражка
 * #пиксар). В карточках стало два разных набора, и заказчица 11.09 сказала:
 * «у меня в VibePost все описания неправильные».
 *
 * Прав завод: в моём наборе нет #shorts, а без него YouTube не опознаёт ролик
 * как Shorts. Шутку — первую строку — не трогаем, меняем только хэштеги.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const корень = dirname(dirname(fileURLToPath(import.meta.url)));
const env = {};
for (const с of readFileSync(join(корень, '.env'), 'utf8').split(/\r?\n/)) {
  const m = с.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL.replace(/\/$/, '');
const h = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

// Пять постоянных — по счётчикам ТикТока на 11.09.2026, они же в задании завода.
const ПОСТОЯННЫЕ = ['shorts', 'говорящиеживотные', 'ценырастут', 'короткометражка', 'пиксар'];

// Денежная тема ролика: 1–2 тега сверх постоянных.
const ТЕМЫ = [
  ['инфляция', /инфляц|подорожа|ценник|дорож|цены|inflation|price/i],
  ['зарплата', /зарплат|получк|оклад|премия|белая|salary|wage/i],
  ['кредиты', /кредит|долг|займ|рассрочк|коллектор|процент|credit|loan|debt/i],
  ['ипотека', /ипотек|жиль|квартир|хатк|mortgage/i],
  ['налоги', /налог|фнс|вычет|деклар|чек|tax/i],
  ['сбережения', /копи|накопл|вклад|сбереж|депозит|подушк|сейф|saving/i],
  ['пенсия', /пенси|старост|pension/i],
  ['страхование', /страхов|полис|случай/i],
  ['подписки', /подписк|автоплат|списыва|subscription/i],
];

const темы = (текст) => {
  const найдены = [];
  for (const [тег, шаблон] of ТЕМЫ) {
    if (шаблон.test(текст)) найдены.push(тег);
    if (найдены.length === 2) break;
  }
  return найдены;
};

/** Первая строка — шутка, её не трогаем. Хэштеги собираем заново. */
function переписать(описание, имя = '') {
  const строки = String(описание).split('\n').map((с) => с.trim()).filter(Boolean);
  const шутка = строки.filter((с) => !с.startsWith('#')).join(' ');
  if (!шутка) return null;
  const теги = [...ПОСТОЯННЫЕ, ...темы(`${имя} ${шутка}`)];
  const новое = `${шутка}\n${теги.map((т) => `#${т}`).join(' ')}`;
  return новое === описание ? null : новое;
}

const записывать = process.argv.includes('записать');
const карточки = await (await fetch(
  `${url}/rest/v1/incoming_videos?or=(description_options.not.is.null,post_description.not.is.null)` +
  `&select=id,name,description_options,post_description`,
  { headers: h },
)).json();

let тронуто = 0;
for (const к of карточки) {
  const патч = {};
  if (Array.isArray(к.description_options) && к.description_options.length) {
    const новые = к.description_options.map((о) => переписать(о, к.name) ?? о);
    if (JSON.stringify(новые) !== JSON.stringify(к.description_options)) {
      патч.description_options = новые;
    }
  }
  if (к.post_description) {
    const новое = переписать(к.post_description, к.name);
    if (новое) патч.post_description = новое;
  }
  if (!Object.keys(патч).length) continue;
  тронуто++;
  if (тронуто <= 3) {
    const образец = патч.post_description ?? патч.description_options[0];
    console.log(`— ${к.name}\n  ${образец.split('\n')[1]}`);
  }
  if (записывать) {
    await fetch(`${url}/rest/v1/incoming_videos?id=eq.${к.id}`, {
      method: 'PATCH', headers: h, body: JSON.stringify(патч),
    });
  }
}

console.log(записывать
  ? `приведено к одному виду карточек: ${тронуто}`
  : `к правке готово карточек: ${тронуто} (запустите с «записать»)`);
