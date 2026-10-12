// analitika: ежедневный разбор вышедшего и запись выводов в мозг завода.
//
// Зачем. Генератор идей (suggest-ideas) читает content_lessons и подмешивает
// их в промт. До 10.09.2026 эта таблица была пуста: разбором занималась
// content-brigade, но она смотрит в старую таблицу videos (43 строки месячной
// давности), а настоящее производство живёт в incoming_videos и
// published_shorts. Мозг работал вслепую, идеи выходили однообразными.
//
// Что делает эта функция. Каждое утро в 08:00 МСК, до идей в 09:00:
//   1. берёт вышедшие шортсы с их просмотрами и связывает с карточками и идеями;
//   2. считает, какие признаки (тип хука, тема, герой, замер, час выхода)
//      встречаются у взлетевших чаще, чем у провалившихся;
//   3. пишет выводы в content_lessons — их читает генератор идей;
//   4. кладёт отчёт дня в content_analysis_results, чтобы было видно,
//      что разбор сделан. По этой записи suggest-ideas утром проверяет,
//      жив ли мозг, и зовёт заказчицу в бот, если разбора нет.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { refreshAccessToken } from "../_shared/youtube-oauth.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function callerIsService(req: Request, serviceKey: string): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return false;
  if (m[1] === serviceKey) return true;
  const parts = m[1].split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

// Темы канала: по ним же генератор пишет хэштеги, по ним же считаем попадание.
const ТЕМЫ: Array<[string, RegExp]> = [
  ["ипотека", /ипотек|жиль|квартир/i],
  ["инфляция", /инфляц|цен[аыу]|подорожа|ценник/i],
  ["налоги", /налог|фнс|вычет|деклар/i],
  ["кредиты", /кредит|долг|займ|рассрочк/i],
  ["зарплата", /зарплат|получк|оклад|премия/i],
  ["сбережения", /копи|накопл|вклад|сбереж|депозит|подушк/i],
  ["пенсия", /пенси|старост/i],
  ["подписки", /подписк|автоплат|сервис/i],
  ["страхование", /страхов|полис/i],
  ["инвестиции", /инвест|акци|дивиденд|доходност|бирж/i],
];

function темаТекста(текст: string): string {
  for (const [имя, шаблон] of ТЕМЫ) if (шаблон.test(текст)) return имя;
  return "без темы";
}

/** Хук-вопрос против хука-утверждения: у двух взлетевших были утверждения. */
function типХука(хук: string): string {
  return /\?\s*$/.test(хук.trim()) ? "вопрос" : "утверждение";
}

function медиана(значения: number[]): number {
  if (!значения.length) return 0;
  const s = [...значения].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

type Ролик = {
  youtube_id: string;
  title: string;
  views: number;
  vph: number;
  часов: number;
  час_выхода: number;
  тема: string;
  тип_хука: string;
  замер: number | null;
  схема: string;
  зверь: string;
  взлетел: boolean;
};

/**
 * Один срез: как признак делит ролики. Вывод пишем, только если признак
 * встречается хотя бы у трёх роликов с обеих сторон — иначе это шум.
 */
function срез(
  ролики: Ролик[],
  имя: string,
  ключ: (р: Ролик) => string,
): Array<{ значение: string; n: number; медиана: number; взлётов: number }> {
  const группы = new Map<string, Ролик[]>();
  for (const р of ролики) {
    const k = ключ(р);
    if (!группы.has(k)) группы.set(k, []);
    группы.get(k)!.push(р);
  }
  return [...группы.entries()]
    .map(([значение, список]) => ({
      значение,
      n: список.length,
      медиана: Math.round(медиана(список.map((р) => р.views))),
      взлётов: список.filter((р) => р.взлетел).length,
    }))
    .sort((a, b) => b.медиана - a.медиана);
}

/**
 * Имя вида из названия карточки: «Сельдь — КОПИТЬ ИЛИ ЖИТЬ» → «Сельдь».
 * Довесок роли отбрасываем: «Гиена с чеком» и «Гиена на самолёте» — одна гиена,
 * иначе каждый зверь окажется в срезе по одному ролику и вывода не будет.
 */
function зверьИзИмени(имя: unknown): string {
  const целиком = String(имя ?? "").split(/\s[—–-]\s/)[0].trim();
  const вид = целиком.split(/\s+/)[0].trim();
  return (вид.length > 3 ? вид : целиком).toLowerCase();
}

/** Заголовок ролика к сравнимому виду: без регистра, знаков и лишних пробелов. */
function ключТекста(t: string): string {
  return (t || "").toLowerCase().replace(/[^a-zа-яё0-9 ]+/gi, " ").replace(/\s+/g, " ").trim();
}

async function собратьРолики(admin: SupabaseClient, uid: string): Promise<Ролик[]> {
  const { data: shorts } = await admin.from("published_shorts")
    .select("youtube_id, title, views, vph, published_at, idea_id, video_id")
    .eq("user_id", uid).not("published_at", "is", null);
  if (!shorts?.length) return [];

  // Связи idea_id/video_id у большинства строк пусты: шортсы берутся с канала,
  // а не из очереди. Поэтому ищем идею и карточку по заголовку — иначе мозг
  // не видит ни темы, ни типа хука и учится на одном часе выхода.
  const { data: ideas } = await admin.from("video_ideas")
    .select("id, animal, hook, line").eq("user_id", uid);
  const { data: cards } = await admin.from("incoming_videos")
    .select("id, name, hook, measure_avg, shema_dvizheniya, tag").eq("user_id", uid);

  const поИдее = new Map((ideas ?? []).map((i) => [i.id as string, i]));
  const поКарточке = new Map((cards ?? []).map((c) => [c.id as string, c]));

  const найтиИдею = (title: string) => {
    const t = ключТекста(title);
    if (!t) return null;
    for (const i of ideas ?? []) {
      const h = ключТекста(String(i.hook ?? ""));
      if (h && h.length > 8 && t.includes(h)) return i;
    }
    return null;
  };
  const найтиКарточку = (title: string) => {
    const t = ключТекста(title);
    if (!t) return null;
    for (const c of cards ?? []) {
      const n = ключТекста(String(c.name ?? ""));
      if (n && n.length > 8 && (t.includes(n) || n.includes(t))) return c;
    }
    return null;
  };

  const просмотры = shorts.map((s) => Number(s.views ?? 0));
  const порог = Math.max(3 * медиана(просмотры), 100);

  return shorts.map((s) => {
    const title = String(s.title ?? "");
    const идея = (s.idea_id ? поИдее.get(s.idea_id as string) : null) ?? найтиИдею(title);
    const карточка = (s.video_id ? поКарточке.get(s.video_id as string) : null) ?? найтиКарточку(title);
    // Хук берём из самого заголовка: у наших заливок он стоит после тире.
    // Идею по кличке зверя не подбираем — 10.09 так подтянулась чужая идея
    // с вопросом, и вывод про тип хука вышел обратный правде.
    const послеТире = title.split(/[—–-]/).slice(1).join("-").trim();
    const хук = послеТире || String((карточка?.hook as string) ?? (идея?.hook as string) ?? "");
    const всё = [title, хук, идея?.line, идея?.animal, карточка?.name].filter(Boolean).join(" ");
    const вышел = new Date(s.published_at as string);
    const часов = Math.max(1, (Date.now() - вышел.getTime()) / 3.6e6);
    const views = Number(s.views ?? 0);
    return {
      youtube_id: String(s.youtube_id),
      title,
      views,
      vph: Number(s.vph ?? views / часов),
      часов,
      час_выхода: (вышел.getUTCHours() + 3) % 24,
      тема: темаТекста(всё),
      тип_хука: хук ? типХука(хук) : "хук не определён",
      замер: карточка?.measure_avg == null ? null : Number(карточка.measure_avg),
      // Схема движения: чем снят ролик. Заказчица 22.09 руками запретила бригаде
      // бег на камеру, и просмотры выросли с 9 до 1200 — решает схема, а мерили
      // мы темы и часы. Считаем, но генератору пока не отдаём: сперва цифры.
      схема: (карточка?.shema_dvizheniya as string) ?? "схема не определена",
      // Кто в кадре. 23.09.2026 заказчица: «он не ведёт статистику по зверю,
      // а просто по тематике — я бы добавила, чтобы звери-тематика тоже».
      зверь: зверьИзИмени(карточка?.name) || String(идея?.animal ?? "").toLowerCase() ||
        зверьИзИмени(карточка?.tag) || "зверь не определён",
      взлетел: views >= порог,
    };
  });
}

/**
 * ТикТок — главный источник: там просмотры расходятся от нуля до тысячи, а на
 * YouTube почти все ролики лежат на пятнадцати. Берём свежий снимок каждого
 * ролика и режем по всем признакам, какие отдаёт их API: тема, длина, час и
 * день выхода, доля репостов и доля лайков.
 *
 * Репосты здесь важнее лайков: именно они разгоняют ролик по чужим лентам.
 * Поэтому смотрим не только «сколько получилось», но и с какого уровня
 * репостов ролик начинает набирать.
 */
/**
 * Кто в кадре у тиктоковского ролика. В самом ТикТоке зверь нигде не записан:
 * оттуда приходят только просмотры и текст описания. Но описание заказчица
 * копирует из карточки — по первой его строке (шутке) ролик и узнаётся.
 * Связь по idea_id тут не годится: из 69 готовых роликов с листком связаны 18.
 */
/**
 * Опознание по обложке (tiktok-opoznanie, 12.10.2026): ролик ТикТока → карточка
 * завода. Это главный путь — заказчица пишет в ТикТоке свои подписи, и по тексту
 * ролики не связывались вовсе. По описанию ищем только то, чего опознание не нашло.
 */
async function карточкиПоОбложке(
  admin: SupabaseClient,
  uid: string,
): Promise<Map<string, { зверь: string; схема: string | null; замер: number | null }>> {
  const { data } = await admin.from("tiktok_kartochki")
    .select("external_video_id, incoming_videos(name, shema_dvizheniya, measure_avg)")
    .eq("user_id", uid).not("incoming_video_id", "is", null);
  const карта = new Map<string, { зверь: string; схема: string | null; замер: number | null }>();
  for (const x of (data ?? []) as Array<Record<string, any>>) {
    const к = x.incoming_videos;
    if (!к) continue;
    карта.set(String(x.external_video_id), {
      зверь: зверьИзИмени(к.name),
      схема: к.shema_dvizheniya ?? null,
      замер: к.measure_avg == null ? null : Number(к.measure_avg),
    });
  }
  return карта;
}

async function зверипоОписаниям(
  admin: SupabaseClient,
  uid: string,
): Promise<Map<string, string>> {
  const { data } = await admin.from("incoming_videos")
    .select("name, tag, post_description, description_options").eq("user_id", uid);
  const карта = new Map<string, string>();
  for (const к of data ?? []) {
    const зверь = зверьИзИмени(к.name) || зверьИзИмени(к.tag);
    if (зверь.length < 3) continue;
    const тексты = [к.post_description, ...(Array.isArray(к.description_options) ? к.description_options : [])];
    for (const т of тексты) {
      if (!т) continue;
      const шутка = String(т).split(/[\r\n]+/).map((с) => с.trim())
        .find((с) => с && !с.startsWith("#"));
      const ключ = ключТекста(шутка ?? "");
      if (ключ.length > 12 && !карта.has(ключ)) карта.set(ключ, зверь);
    }
  }
  return карта;
}

async function тиктокРазбор(admin: SupabaseClient, uid: string) {
  // Тянем не весь raw_payload: там лежит embed_html, и на паре тысяч строк
  // функция падала с Internal Server Error. Берём только нужные поля.
  const { data, error } = await admin.from("tiktok_raw_video_items")
    .select("external_video_id, view_count:raw_payload->>view_count, " +
      "like_count:raw_payload->>like_count, share_count:raw_payload->>share_count, " +
      "comment_count:raw_payload->>comment_count, create_time:raw_payload->>create_time, " +
      "duration:raw_payload->>duration, title:raw_payload->>title, " +
      "video_description:raw_payload->>video_description")
    .eq("user_id", uid).order("captured_at", { ascending: false }).limit(3000);
  if (error) throw new Error(`тикток: ${error.message}`);
  if (!data?.length) return null;

  const звери = await зверипоОписаниям(admin, uid);
  const поОбложке = await карточкиПоОбложке(admin, uid);

  const свежие = new Map<string, Record<string, unknown>>();
  for (const строка of data) {
    const id = String((строка as unknown as Record<string, unknown>).external_video_id);
    if (!свежие.has(id)) свежие.set(id, строка as unknown as Record<string, unknown>);
  }

  const ролики = [...свежие.values()].map((p) => {
    const views = Number(p.view_count ?? 0);
    const вышел = new Date(Number(p.create_time ?? 0) * 1000);
    const мск = new Date(вышел.getTime() + 3 * 3600_000);
    return {
      views,
      likes: Number(p.like_count ?? 0),
      shares: Number(p.share_count ?? 0),
      comments: Number(p.comment_count ?? 0),
      длина: Number(p.duration ?? 0),
      час: мск.getUTCHours(),
      день: ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"][мск.getUTCDay()],
      текст: String(p.title ?? p.video_description ?? ""),
      зверь: поОбложке.get(String(p.external_video_id))?.зверь ??
        звери.get(ключТекста(String(p.title ?? p.video_description ?? ""))) ?? null,
      схема: поОбложке.get(String(p.external_video_id))?.схема ?? null,
      замер: поОбложке.get(String(p.external_video_id))?.замер ?? null,
    };
  }).filter((р) => р.views > 0);

  if (ролики.length < 8) return null;

  const доля = (часть: number, целое: number) => (целое ? часть / целое : 0);

  /**
   * По каждой группе меряем три вещи: сколько посмотрели, сколько из
   * посмотревших лайкнули и сколько переслали. Просмотры говорят, донесла ли
   * лента, а лайки и репосты — попала ли шутка: их доля от просмотров почти
   * не зависит от того, повезло ролику с лентой или нет.
   *
   * Бинов по самой доле лайков не делаем: у ролика с тысячей просмотров доля
   * всегда ниже, чем у ролика с десятью, и вывод выходит вывернутым наизнанку
   * — «снимай так, чтобы лайкали пореже». 10.09.2026 такой вывод уже попал в
   * память завода, пришлось стирать.
   */
  const режем = (
    имя: string,
    ключ: (р: (typeof ролики)[number]) => string | null,
  ) => {
    const группы = new Map<string, (typeof ролики)>();
    for (const р of ролики) {
      const k = ключ(р);
      if (!k) continue;
      if (!группы.has(k)) группы.set(k, []);
      группы.get(k)!.push(р);
    }
    const строки = [...группы.entries()]
      .filter(([, v]) => v.length >= 3)
      .map(([значение, v]) => {
        // Долю считаем только по роликам, которые видели хотя бы полсотни раз.
        // На ролике с четырьмя просмотрами один лайк даёт «25% зрителей в
        // восторге» — и завод уходит снимать провальную тему.
        const заметные = v.filter((р) => р.views >= 50);
        const хватает = заметные.length >= 3;
        return {
          значение,
          n: v.length,
          медиана: Math.round(медиана(v.map((р) => р.views))),
          доля_на: заметные.length,
          лайков_процент: хватает
            ? Math.round(медиана(заметные.map((р) => доля(р.likes, р.views))) * 1000) / 10
            : -1,
          репостов_процент: хватает
            ? Math.round(медиана(заметные.map((р) => доля(р.shares, р.views))) * 1000) / 10
            : -1,
          секунд: Math.round(медиана(v.map((р) => р.длина))),
        };
      })
      .sort((a, b) => b.медиана - a.медиана);
    return { имя, строки };
  };

  return {
    всего: ролики.length,
    репостов_всего: ролики.reduce((с, р) => с + р.shares, 0),
    срезы: [
      режем("Тема", (р) => темаТекста(р.текст)),
      режем("Зверь", (р) => р.зверь),
      режем("Зверь и тема", (р) => (р.зверь ? `${р.зверь} · ${темаТекста(р.текст)}` : null)),
      режем("Схема съёмки", (р) => р.схема),
      режем("Замер динамики", (р) => (р.замер == null ? null : р.замер >= 18 ? "18 и выше" : "ниже 18")),
      режем("Длина ролика", (р) =>
        р.длина <= 0 ? null : р.длина <= 10 ? "до 10 секунд" : р.длина <= 15 ? "11-15 секунд" : "16 секунд и длиннее"),
      режем("Час выхода в ТикТоке", (р) => `${String(р.час).padStart(2, "0")}:00`),
      режем("День недели", (р) => р.день),
    ].filter((с) => с.строки.length >= 2),
  };
}

/**
 * Где мало снято, а смотрят. Творческий центр ТикТока отдаёт такие темы
 * только после входа, поэтому считаем то же самое по YouTube: за месяц по
 * каждой нашей денежной теме смотрим, сколько вышло коротких роликов и
 * какая у них медиана просмотров. Мало роликов при высокой медиане —
 * пустая ниша, туда и снимать.
 */
async function нишиПоТемам(ключ: string) {
  const месяцНазад = new Date(Date.now() - 30 * 86400_000).toISOString();
  const итог: Array<{ тема: string; роликов: number; медиана: number; спрос: number }> = [];
  for (const [тема] of ТЕМЫ) {
    try {
      const s = await fetch(
        "https://www.googleapis.com/youtube/v3/search?part=id&type=video" +
        "&videoDuration=short&regionCode=RU&relevanceLanguage=ru&maxResults=25" +
        `&publishedAfter=${месяцНазад}&q=${encodeURIComponent(тема + " деньги")}&key=${ключ}`,
      );
      const sj = await s.json();
      const всего = Number(sj?.pageInfo?.totalResults ?? 0);
      const ids = (sj?.items ?? []).map((i: { id?: { videoId?: string } }) => i.id?.videoId)
        .filter(Boolean).slice(0, 25);
      if (!ids.length) continue;
      const v = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.join(",")}&key=${ключ}`,
      );
      const vj = await v.json();
      const просмотры = (vj?.items ?? [])
        .map((x: { statistics?: { viewCount?: string } }) => Number(x.statistics?.viewCount ?? 0));
      const мед = Math.round(медиана(просмотры));
      итог.push({ тема, роликов: всего, медиана: мед, спрос: всего ? Math.round(мед / Math.max(1, всего / 1000)) : 0 });
    } catch { /* тема пропущена — не роняем весь разбор */ }
  }
  return итог.sort((a, b) => b.спрос - a.спрос);
}

/**
 * Хэштеги ТикТока: где мало снято, а смотрят много. Считает не эта функция:
 * TikTok не отвечает серверам Supabase (10.09.2026 из облака пришло ноль
 * тегов, а с домашней машины — все сорок пять). Собирает приёмник скриптом
 * `scripts/теги-тиктока.mjs` раз в сутки, здесь только читаем готовое.
 */
async function тегиТиктока(admin: SupabaseClient) {
  const { data } = await admin.from("tiktok_tegi")
    .select("teg, rolikov, na_rolik, sobrano_at")
    .gte("sobrano_at", new Date(Date.now() - 7 * 86400_000).toISOString())
    .order("na_rolik", { ascending: false });
  return (data ?? []).map((с) => ({
    тег: String(с.teg),
    роликов: Number(с.rolikov),
    на_ролик: Number(с.na_rolik),
  }));
}

/** «1 репост», «2 репоста», «5 репостов» — иначе отчёт читается как машинный. */
function склонить(n: number, одна: string, две: string, пять: string): string {
  const с = Math.abs(n) % 100;
  const е = с % 10;
  if (с > 10 && с < 20) return `${n} ${пять}`;
  if (е > 1 && е < 5) return `${n} ${две}`;
  if (е === 1) return `${n} ${одна}`;
  return `${n} ${пять}`;
}

/**
 * Шортсы крутятся по кругу, поэтому досмотр бывает больше ста процентов:
 * 180% значит, что ролик в среднем посмотрели почти дважды. Пишем это
 * словами, иначе «досмотрели на 179% длины» читается как ошибка.
 */
function досмотрСловами(п: number): string {
  return п >= 115
    ? `пересматривают по кругу ${(п / 100).toFixed(1)} раза`
    : п >= 90 ? "досматривают до конца" : `досматривают ${п}% длины`;
}

/**
 * Досмотр. Ни ТикТок, ни обычный YouTube Data API его не отдают — только
 * YouTube Analytics по своему каналу: там на каждый ролик есть, какую долю
 * длины зритель просмотрел, сколько переслал и сколько подписалось.
 *
 * Это единственная метрика, которая говорит про сам ролик, а не про ленту:
 * просмотры зависят от того, кому лента его показала, а досмотр — только от
 * того, дослушали ли шутку.
 */
async function досмотрЮтуба(admin: SupabaseClient, uid: string) {
  const { data: аккаунт } = await admin.from("youtube_accounts")
    .select("id").eq("user_id", uid).eq("auth_status", "active").limit(1).maybeSingle();
  if (!аккаунт) return null;

  let токен: string;
  try {
    const { data: bundleRaw } = await admin.rpc("get_youtube_token_bundle", { p_account_id: аккаунт.id });
    const bundle = JSON.parse(String(bundleRaw ?? "{}"));
    if (!bundle.refresh_token) return null;
    const t = await refreshAccessToken({
      clientId: Deno.env.get("YOUTUBE_OAUTH_CLIENT_ID")!,
      clientSecret: Deno.env.get("YOUTUBE_OAUTH_CLIENT_SECRET")!,
      refreshToken: bundle.refresh_token,
    });
    токен = t.access_token;
  } catch { return null; }

  const с = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
  const по = new Date().toISOString().slice(0, 10);
  const адрес = "https://youtubeanalytics.googleapis.com/v2/reports" +
    `?ids=channel%3D%3DMINE&startDate=${с}&endDate=${по}&dimensions=video` +
    "&metrics=views,averageViewPercentage,averageViewDuration,likes,shares,comments,subscribersGained" +
    "&sort=-views&maxResults=200";
  const ответ = await fetch(адрес, { headers: { Authorization: `Bearer ${токен}` } });
  if (!ответ.ok) return null;
  const j = await ответ.json();
  const строки = (j?.rows ?? []) as Array<Array<string | number>>;
  if (строки.length < 4) return null;

  return строки.map((r) => ({
    youtube_id: String(r[0]),
    просмотров: Number(r[1] ?? 0),
    досмотр: Number(r[2] ?? 0),
    секунд: Number(r[3] ?? 0),
    лайков: Number(r[4] ?? 0),
    репостов: Number(r[5] ?? 0),
    комментариев: Number(r[6] ?? 0),
    подписалось: Number(r[7] ?? 0),
  }));
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!callerIsService(req, serviceKey)) return json(403, { error: "forbidden" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const { data: profile } = await admin.from("profiles")
    .select("id").not("error_notify_tg_id", "is", null).limit(1).maybeSingle();
  if (!profile) return json(200, { ok: false, причина: "нет владельца" });
  const uid = profile.id as string;

  const ролики = await собратьРолики(admin, uid);
  if (ролики.length < 4) {
    return json(200, { ok: false, причина: `роликов для разбора мало: ${ролики.length}` });
  }

  const взлетевшие = ролики.filter((р) => р.взлетел);
  const срезы = {
    тема: срез(ролики, "тема", (р) => р.тема),
    тип_хука: срез(ролики, "тип хука", (р) => р.тип_хука),
    час: срез(ролики, "час выхода", (р) => `${р.час_выхода}:00`),
    схема: срез(ролики, "схема движения", (р) => р.схема),
    зверь: срез(ролики, "зверь", (р) => р.зверь),
    зверь_и_тема: срез(ролики, "зверь и тема", (р) => `${р.зверь} · ${р.тема}`),
    замер: срез(ролики, "замер", (р) =>
      р.замер == null ? "не мерян" : р.замер >= 18 ? "18 и выше" : "ниже 18"),
  };

  // Выводы пишем словами, как их прочтёт генератор идей.
  // Словарь у таблицы строгий: генератор берёт только WINNING_PATTERN/SUPPORTED
  // и FAILED_PATTERN/REJECTED. Пишем парами: что брать и чего избегать.
  const выводы: Array<{ lesson: string; category: string; status: string; evidence: unknown[] }> = [];
  const пара = (берём: string, избегаем: string, факты: unknown) => {
    выводы.push({ lesson: берём, category: "WINNING_PATTERN", status: "SUPPORTED", evidence: [факты] });
    выводы.push({ lesson: избегаем, category: "FAILED_PATTERN", status: "REJECTED", evidence: [факты] });
  };
  const общаяМедиана = Math.round(медиана(ролики.map((р) => р.views)));
  let тиктокРоликов = 0;

  const тикток = await тиктокРазбор(admin, uid);
  тиктокРоликов = тикток?.всего ?? 0;
  if (тикток) {
    for (const срез of тикток.срезы) {
      const общий = { источник: "tiktok", срез: срез.имя, строки: срез.строки, всего: тикток.всего };

      // 1. Просмотры: донесла ли лента.
      const л = срез.строки[0];
      const х = срез.строки[срез.строки.length - 1];
      if (л.медиана >= х.медиана * 1.8) {
        пара(
          `${срез.имя} «${л.значение}»: в ТикТоке медиана ${л.медиана} просмотров на ${л.n} роликах.`,
          `${срез.имя} «${х.значение}»: медиана ${х.медиана} на ${х.n} роликах, не брать.`,
          общий,
        );
      }

      // 2. Лайки: попала ли шутка. Считаем от просмотров, поэтому ролику с
      // маленьким охватом это не даёт форы.
      const счётные = срез.строки.filter((с) => с.лайков_процент >= 0);
      const поЛайкам = [...счётные].sort((a, b) => b.лайков_процент - a.лайков_процент);
      const лл = поЛайкам[0];
      const лх = поЛайкам[поЛайкам.length - 1];
      if (поЛайкам.length >= 2 && лл.лайков_процент >= 1 && лл.лайков_процент >= лх.лайков_процент * 2) {
        пара(
          `${срез.имя} «${лл.значение}»: лайк ставят ${лл.лайков_процент}% посмотревших — шутка попадает.`,
          `${срез.имя} «${лх.значение}»: лайк ставят ${лх.лайков_процент}% — зритель досматривает молча.`,
          общий,
        );
      }

      // 3. Репосты: пересылают ли друзьям. Именно они разгоняют ролик по
      // чужим лентам, поэтому смотрим отдельно от лайков — но только когда
      // репосты вообще есть, иначе сравниваем ноль с нулём.
      if (тикток.репостов_всего >= 10) {
        const поРепостам = [...счётные].sort((a, b) => b.репостов_процент - a.репостов_процент);
        const рл = поРепостам[0];
        const рх = поРепостам[поРепостам.length - 1];
        if (поРепостам.length >= 2 && рл.репостов_процент >= 0.3 && рл.репостов_процент >= рх.репостов_процент * 2) {
          пара(
            `${срез.имя} «${рл.значение}»: пересылают ${рл.репостов_процент}% посмотревших — этим делятся.`,
            `${срез.имя} «${рх.значение}»: пересылают ${рх.репостов_процент}%, ролик дальше своей ленты не уходит.`,
            общий,
          );
        }
      }
    }
  }

  // Досмотр, репосты и подписки — по своему каналу через YouTube Analytics.
  // Просмотры говорят про ленту, эти три — про сам ролик.
  const досмотр = await досмотрЮтуба(admin, uid);
  if (досмотр) {
    const поId = new Map(ролики.map((р) => [р.youtube_id, р]));
    const сНашими = досмотр
      .map((д) => ({ ...д, наш: поId.get(д.youtube_id) }))
      .filter((д) => д.наш && д.просмотров >= 20);

    if (сНашими.length >= 6) {
      const срезДосмотра = (имя: string, ключ: (н: Ролик) => string) => {
        const группы = new Map<string, (typeof сНашими)>();
        for (const д of сНашими) {
          const k = ключ(д.наш!);
          if (!группы.has(k)) группы.set(k, []);
          группы.get(k)!.push(д);
        }
        return [...группы.entries()]
          .filter(([, v]) => v.length >= 3)
          .map(([значение, v]) => ({
            значение,
            n: v.length,
            досмотр: Math.round(медиана(v.map((д) => д.досмотр))),
            секунд: Math.round(медиана(v.map((д) => д.секунд))),
            репостов: v.reduce((с, д) => с + д.репостов, 0),
            подписалось: v.reduce((с, д) => с + д.подписалось, 0),
          }))
          .sort((a, b) => b.досмотр - a.досмотр);
      };

      for (const [имя, строки] of [
        ["Тема", срезДосмотра("Тема", (н) => н.тема)],
        ["Тип хука", срезДосмотра("Тип хука", (н) => н.тип_хука)],
        ["Замер движения", срезДосмотра("Замер", (н) =>
          н.замер == null ? "не мерян" : н.замер >= 18 ? "18 и выше" : "ниже 18")],
      ] as Array<[string, ReturnType<typeof срезДосмотра>]>) {
        if (строки.length < 2) continue;
        const л = строки[0];
        const х = строки[строки.length - 1];
        if (л.досмотр < х.досмотр * 1.25) continue;
        пара(
          `${имя} «${л.значение}»: ${досмотрСловами(л.досмотр)} — ${склонить(л.n, "ролик", "ролика", "роликов")}, лучший досмотр канала.`,
          `${имя} «${х.значение}»: досмотр ${х.досмотр}% против ${л.досмотр}% у лучших — шутку дослушивают хуже.`,
          { источник: "youtube-analytics", признак: имя, строки },
        );
      }

      // Репосты и подписки считаем по каналу целиком: их мало, по срезам
      // делить нечего, но заказчице важно видеть, что ролики вообще пересылают.
      const репостов = сНашими.reduce((с, д) => с + д.репостов, 0);
      const подписалось = сНашими.reduce((с, д) => с + д.подписалось, 0);
      const лучший = [...сНашими].sort((a, b) => b.репостов - a.репостов)[0];
      выводы.push({
        lesson: `За 90 дней на YouTube: ${склонить(репостов, "репост", "репоста", "репостов")} и ` +
          `${склонить(подписалось, "подписка", "подписки", "подписок")} с ` +
          `${склонить(сНашими.length, "ролика", "роликов", "роликов")}. ` +
          `Больше всех пересылали «${лучший.наш!.title}»: ${склонить(лучший.репостов, "репост", "репоста", "репостов")}, ` +
          `${досмотрСловами(Math.round(лучший.досмотр))}.`,
        category: "CONFIRMED_LESSON",
        status: "CONFIRMED",
        evidence: [{ источник: "youtube-analytics", репостов, подписалось, роликов: сНашими.length }],
      });
    }
  }

  for (const [поле, строки] of Object.entries(срезы)) {
    const годные = strokiGodnye(строки);
    if (годные.length < 2) continue;
    const лучший = годные[0];
    const худший = годные[годные.length - 1];
    if (лучший.медиана < худший.медиана * 1.8) continue;
    пара(
      `${podpis(поле)} «${лучший.значение}»: медиана ${лучший.медиана} просмотров на ${лучший.n} роликах.`,
      `${podpis(поле)} «${худший.значение}»: медиана ${худший.медиана} просмотров на ${худший.n} роликах, не брать.`,
      { поле, лучший, худший, всего_роликов: ролики.length },
    );
  }

  if (взлетевшие.length) {
    выводы.push({
      lesson: `Взлетели только ${взлетевшие.length} из ${ролики.length}: ` +
        взлетевшие.map((р) => `«${р.title.slice(0, 40)}» (${р.views})`).join(", ") +
        `. Общая медиана канала — ${общаяМедиана} просмотров.`,
      category: "CONFIRMED_LESSON",
      status: "SUPPORTED",
      evidence: [{ медиана: общаяМедиана, взлетевшие: взлетевшие.map((р) => р.youtube_id) }],
    });
  }

  // Хэштеги ТикТока: берём пять самых щедрых при малой конкуренции и три
  // перегретых. Это готовый набор для описания следующего ролика.
  const теги = await тегиТиктока(admin);
  if (теги.length >= 6) {
    const мало = теги.filter((т) => т.роликов < 50000).slice(0, 5);
    const перегрето = [...теги].sort((a, b) => b.роликов - a.роликов).slice(0, 3);
    if (мало.length >= 3) {
      пара(
        `Хэштеги ТикТока, где мало снято и много смотрят: ` +
          мало.map((т) => `#${т.тег} (${т.роликов} роликов, ${т.на_ролик} просмотров на ролик)`).join(", ") +
          `. Ставить их в описание.`,
        `Перегретые хэштеги: ` +
          перегрето.map((т) => `#${т.тег} (${т.роликов} роликов, всего ${т.на_ролик} на ролик)`).join(", ") +
          `. Не ставить, ролик там тонет.`,
        { источник: "tiktok challenge api", строки: теги.slice(0, 20) },
      );
    }
  }

  const ключYT = Deno.env.get("YOUTUBE_API_KEY");
  let ниши: Awaited<ReturnType<typeof нишиПоТемам>> = [];
  if (ключYT) {
    ниши = await нишиПоТемам(ключYT);
    if (ниши.length >= 3) {
      const пусто = ниши[0];
      const густо = ниши[ниши.length - 1];
      пара(
        `Свободная ниша «${пусто.тема}»: за месяц ${пусто.роликов} коротких роликов при медиане ` +
          `${пусто.медиана} просмотров, лучший спрос на снятое, снимать сюда.`,
        `Ниша «${густо.тема}» перегрета: ${густо.роликов} роликов, медиана ${густо.медиана}, отложить.`,
        { источник: "youtube search", ниши },
      );
    }
  }

  // Вчерашние автоматические выводы убираем: история остаётся в разборах,
  // а генератор должен видеть только сегодняшнюю картину.
  await admin.from("content_lessons").delete()
    .eq("user_id", uid).eq("source", "аналитика дня");

  let ошибкаУроков: string | null = null;
  if (выводы.length) {
    const { error } = await admin.from("content_lessons").insert(выводы.map((в) => ({
      user_id: uid,
      lesson: в.lesson,
      category: в.category,
      evidence: в.evidence,
      videos_used: [],
      sample_size: { роликов: ролики.length, взлетевших: взлетевшие.length },
      confidence: ролики.length >= 12 ? "MEDIUM" : "LOW",
      status: в.status,
      source: "аналитика дня",
      source_platform: "youtube_shorts",
      applicable_topics: [...new Set(ролики.map((р) => р.тема))],
    })));
    if (error) ошибкаУроков = (error.code + ": " + error.message).slice(0, 200);
  }

  const отчёт = [
    `Разбор за ${new Date().toISOString().slice(0, 10)}.`,
    `Роликов на канале: ${ролики.length}, взлетело: ${взлетевшие.length}, медиана: ${общаяМедиана}.`,
    ...выводы.map((в) => `— ${в.lesson}`),
  ].join("\n");

  // content_analysis_results держит разбор одного ролика (video_id обязателен),
  // поэтому сводку дня пишем в свою таблицу. По ней генератор идей проверяет
  // утром, был ли разбор, и зовёт заказчицу, если его нет.
  const { error: сбойРазбора } = await admin.from("analitika_dnya").insert({
    user_id: uid,
    otchet: отчёт,
    vyvodov: выводы.length,
    metrics: {
      роликов: ролики.length,
      взлетело: взлетевшие.length,
      медиана: общаяМедиана,
      выводов: выводы.length,
      тикток_роликов: тиктокРоликов,
    },
    evidence: { срезы, ниши, теги, тикток: тикток ?? null },
  });

  return json(200, {
    ok: !ошибкаУроков && !сбойРазбора,
    ошибка_уроков: ошибкаУроков,
    ошибка_разбора: сбойРазбора ? (сбойРазбора.code + ": " + сбойРазбора.message).slice(0, 200) : null,
    роликов: ролики.length,
    взлетело: взлетевшие.length,
    выводов: выводы.length,
    тикток_роликов: тиктокРоликов,
    отчёт,
  });
});

/** Группы меньше трёх роликов — шум, в выводы не берём. */
function strokiGodnye(
  строки: Array<{ значение: string; n: number; медиана: number; взлётов: number }>,
) {
  return строки.filter((с) => с.n >= 3 && с.значение !== "не мерян" && с.значение !== "хук не определён");
}

function podpis(поле: string): string {
  if (поле === "тема") return "Тема";
  if (поле === "тип_хука") return "Хук в кадре";
  if (поле === "схема") return "Схема движения";
  if (поле === "час") return "Час выхода";
  return "Замер динамики";
}
