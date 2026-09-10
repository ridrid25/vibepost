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
    .select("id, name, hook, measure_avg").eq("user_id", uid);

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
      взлетел: views >= порог,
    };
  });
}

/**
 * ТикТок — второй и более честный источник: там просмотры расходятся от нуля
 * до тысячи, а на YouTube почти все ролики лежат на пятнадцати. Берём
 * последний снимок по каждому ролику и разбираем описание по темам.
 */
async function тиктокПоТемам(admin: SupabaseClient, uid: string) {
  const { data } = await admin.from("tiktok_raw_video_items")
    .select("external_video_id, raw_payload, captured_at")
    .eq("user_id", uid).order("captured_at", { ascending: false }).limit(4000);
  if (!data?.length) return null;

  const свежие = new Map<string, Record<string, unknown>>();
  for (const строка of data) {
    const id = String(строка.external_video_id);
    if (!свежие.has(id)) свежие.set(id, строка.raw_payload as Record<string, unknown>);
  }
  const ролики = [...свежие.values()].map((p) => ({
    views: Number(p.view_count ?? 0),
    likes: Number(p.like_count ?? 0),
    текст: String(p.title ?? p.video_description ?? ""),
  })).filter((р) => р.текст);
  if (ролики.length < 6) return null;

  const группы = new Map<string, number[]>();
  for (const р of ролики) {
    const t = темаТекста(р.текст);
    if (!группы.has(t)) группы.set(t, []);
    группы.get(t)!.push(р.views);
  }
  const строки = [...группы.entries()]
    .filter(([, v]) => v.length >= 3)
    .map(([тема, v]) => ({ тема, n: v.length, медиана: Math.round(медиана(v)) }))
    .sort((a, b) => b.медиана - a.медиана);
  return { всего: ролики.length, строки };
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

  const тикток = await тиктокПоТемам(admin, uid);
  if (тикток && тикток.строки.length >= 2) {
    const л = тикток.строки[0];
    const х = тикток.строки[тикток.строки.length - 1];
    if (л.медиана >= х.медиана * 1.8) {
      пара(
        `Тема «${л.тема}»: в ТикТоке медиана ${л.медиана} просмотров на ${л.n} роликах, лучшая тема канала.`,
        `Тема «${х.тема}»: в ТикТоке медиана ${х.медиана} на ${х.n} роликах, не брать.`,
        { источник: "tiktok", строки: тикток.строки, всего: тикток.всего },
      );
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
  if (поле === "час") return "Час выхода";
  return "Замер динамики";
}
