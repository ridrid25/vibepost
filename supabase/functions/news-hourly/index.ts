// news-hourly: «каждый час свежая новость часа, с 8 до 18» (решение заказчицы 18.10.2026).
//
// pg_cron в :36 (07:36…17:36 МСК). Берёт свежие новости за последние 2 часа
// (мало — за 4), Gemini выбирает ОДНУ самую свежую денежную и пишет её в подаче
// «Топора»; заводится публикация на ближайший час (digest_hourly_create), Контент-
// завод делает обложку, диспетчер шлёт в канал в :00. Ей приходит превью с кнопкой
// «🛑 Не публиковать» — не нажала, новость выходит. Подходящей нет — час пропускается
// молча. Работает только при news_config.digest_mode = 'hourly'.
//
// Вызов только с сервисным ключом:
//   supabase.functions.invoke("news-hourly", { body: {} })
//   → { ok, слот, публикация } | { ok, пропуск: причина }
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const МОДЕЛЬ = "gemini-2.5-flash";
const РЕГИОН = "us-central1";

let токенВПамяти: { value: string; expiresAt: number } | null = null;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(body);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

const b64url = (data: string | Uint8Array) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function googleToken(admin: SupabaseClient): Promise<{ token: string; project: string }> {
  const { data: raw } = await admin.rpc("get_secret", { p_name: "google_sa_json" });
  if (!raw) throw new Error("В хранилище нет google_sa_json");
  const sa = JSON.parse(raw) as { client_email: string; private_key: string; project_id: string };

  if (токенВПамяти && токенВПамяти.expiresAt > Date.now() + 60_000) {
    return { token: токенВПамяти.value, project: sa.project_id };
  }

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)),
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${b64url(sig)}`,
    }),
  });
  const tok = await res.json();
  if (!tok.access_token) throw new Error(`Google не выдал токен: ${JSON.stringify(tok).slice(0, 200)}`);

  токенВПамяти = { value: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 };
  return { token: tok.access_token, project: sa.project_id };
}

const ПРАВИЛА = `Ты выбираешь ОДНУ новость часа для телеграм-канала о личных финансах.

Только сухие факты. Никаких шуток, иронии, оценок и эмоций.

Формат ответа — строго три строки, первая обязательна:
НОМЕР: 7
• **Суть новости одной фразой**, — источник.
Одно-два коротких предложения подробностей, ключевые **цифры и суммы** жирным.

(вместо 7 — номер выбранной новости из списка; слово «Подробности» не пиши)

Требования (решения заказчицы 17–18.10.2026):
- выбирай САМУЮ СВЕЖУЮ подходящую новость: у каждой стоит время публикации по
  Москве; из сопоставимых бери ту, что вышла позже;
- подходит то, что касается денег: ставки, вклады, кредиты, курсы, цены, налоги,
  льготы, выплаты, пенсии, тарифы, зарплаты, санкции, рынки, банки, крупные
  компании, указы и законы о деньгах и собственности;
- громкие новости политики, войны и заявления первых лиц (Трамп, Путин, Зеленский,
  Макрон и т. п.) — БРАТЬ: политика сильно влияет на экономику (решение заказчицы
  19.10.2026); в подробностях одной фразой укажи, на что это влияет в деньгах
  (нефть, курс, цены, санкции, рынки, бюджет), без домыслов — только то, что
  следует из новости;
- не подходит только то, что к деньгам и экономике не имеет отношения никак:
  бытовой криминал, светская хроника, спорт, погода;
- НЕ бери то, что уже вышло сегодня (список «Уже вышло» ниже), даже другими словами;
- вторая строка начинается со знака «•»; суть в **двойных звёздочках**, до 110
  знаков, затем «, — » и источник: кто сказал или сообщил (ведомство, человек,
  издание); нет говорящего — издание из пометки [источник: …];
- третья строка — подробности до 300 знаков, 2–3 ключевых факта в **двойных
  звёздочках**, без маркера и не начиная с тире;
- ссылки, призывы подписаться и эмодзи не пиши — их добавит система;
- пиши своими словами, не копируй формулировки источника;
- никаких «шок», «срочно», «вы не поверите»; никаких советов покупать или продавать;
- идеальной новости может не быть — тогда бери ЛУЧШУЮ из тех, где есть деньги
  (цены, суммы, ставки, налоги, рынки, компании, бюджет); час без новости хуже,
  чем неидеальная новость (решение заказчицы 19.10.2026);
- слово МАЛО — только если в списке нет вообще ни одной новости с денежной стороной.`;

function вHtml(т: string): string {
  return т.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*\*/g, "");
}

function callerIsService(req: Request, serviceKey: string): boolean {
  const m = (req.headers.get("Authorization") ?? "").match(/^Bearer (.+)$/);
  if (!m) return false;
  if (m[1] === serviceKey) return true;
  const parts = m[1].split(".");
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))).role === "service_role";
  } catch {
    return false;
  }
}

const поМоскве = (d: Date) =>
  d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" });

type Новость = { id: string; text: string; published_at: string; source_id: string | null };

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!callerIsService(req, serviceKey)) return json(401, { error: "только сервис" });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  // { "проба": true } — только показать, что выбрал бы: без публикации, сообщений и пометок
  const тело = await req.json().catch(() => ({}));
  const проба = тело?.проба === true;

  const { data: cfg } = await admin.from("news_config")
    .select("user_id, bot_id, enabled, digest_mode, send_hour, post_hour, auto_publish").eq("enabled", true).maybeSingle();
  if (!cfg || (cfg.digest_mode !== "hourly" && !проба)) return json(200, { ok: true, пропуск: "режим не hourly" });

  // Ближайший полный час. Рамки вещания — из настроек (19.10.2026, её решение):
  // send_hour = «С» (первая новость), post_hour = «До» (последняя), часы МСК.
  const с = Number(cfg.send_hour ?? 8), до = Number(cfg.post_hour ?? 18);
  // Вручную (только сервисный вызов) можно завести новость на конкретный час, в т.ч.
  // на уже наступивший — тогда она выйдет, как только придёт обложка.
  const слот = тело?.слот ? new Date(String(тело.слот))
    : new Date(Math.ceil((Date.now() + 60_000) / 3_600_000) * 3_600_000);
  const часМск = (слот.getUTCHours() + 3) % 24;
  if (!проба && (часМск < с || часМск > до)) return json(200, { ok: true, пропуск: `час ${часМск} вне ${с}–${до}` });

  const { data: уже } = await admin.from("news_digest_publications")
    .select("id").eq("user_id", cfg.user_id).eq("hourly", true)
    .eq("base_slot_at", слот.toISOString()).maybeSingle();
  if (уже && !проба) return json(200, { ok: true, пропуск: "на этот час уже есть" });

  // Свежие новости: за 2 часа, мало — за 4
  let новости: Новость[] = [];
  // 19.10: окно 6 часов (было 2/4) — в тихие часы есть выбор; свежесть решает модель по времени
  for (const часов of (проба && Number(тело?.часов) > 0 ? [Number(тело.часов)] : [6])) {
    const { data } = await admin.from("news_items")
      .select("id, text, published_at, source_id")
      .eq("user_id", cfg.user_id).is("used_at", null)
      .gte("published_at", new Date(Date.now() - часов * 3_600_000).toISOString())
      .order("published_at", { ascending: false }).limit(60);
    новости = (data ?? []) as Новость[];
    if (новости.length >= 5) break;
  }
  if (!новости.length) return json(200, { ok: true, пропуск: "свежих новостей нет" });

  const { data: источники } = await admin.from("news_sources").select("id, title, username")
    .in("id", [...new Set(новости.map((n) => n.source_id).filter(Boolean))]);
  const издание = new Map((источники ?? []).map((s) => [s.id, s.title || s.username]));

  // Что сегодня уже вышло или стоит — чтобы не повторяться
  const сутки = new Date(Date.now() - 20 * 3_600_000).toISOString();
  const { data: сегодня } = await admin.from("news_digest_publications")
    .select("news_digest_items(text)").eq("user_id", cfg.user_id).eq("hourly", true)
    .gte("base_slot_at", сутки);
  const ужеВышло = (сегодня ?? [])
    .map((p: Record<string, any>) => String(p.news_digest_items?.text ?? "").split("\n")[0].replace(/\*\*/g, ""))
    .filter(Boolean);

  const сырьё = новости.map((n, i) =>
    `${i + 1}. [${поМоскве(new Date(n.published_at))}] [источник: ${издание.get(n.source_id) ?? "неизвестно"}] ` +
    n.text.replace(/\s+/g, " ").slice(0, 500)).join("\n");

  const вход = (добавка: string) =>
    `Уже вышло сегодня:\n${ужеВышло.length ? ужеВышло.map((t) => "- " + t).join("\n") : "(ничего)"}` +
    `\n\nСвежие новости:\n\n${сырьё}${добавка}`;

  // 24.10, её правило «одно не работает — идём следующим вариантом»:
  // Gemini (Vertex) → бесплатный текстовый помощник Pollinations (без ключа).
  let звено = "gemini";
  const спросить = async (добавка: string): Promise<string> => {
    try {
      const ответ = await спроситьGemini(добавка);
      if (ответ) return ответ;
      throw new Error("пустой ответ");
    } catch (e) {
      звено = "pollinations";
      const res = await fetch("https://text.pollinations.ai/openai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai",
          messages: [{ role: "system", content: ПРАВИЛА }, { role: "user", content: вход(добавка) }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Gemini: ${(e as Error).message}; Pollinations: HTTP ${res.status}`);
      const т = await res.json();
      return String(т?.choices?.[0]?.message?.content ?? "").trim();
    }
  };

  const спроситьGemini = async (добавка: string): Promise<string> => {
    // проба с { "безGemini": true } — проверка запасного звена
    if (проба && тело?.безGemini === true) throw new Error("Gemini выключен для пробы");
    const { token, project } = await googleToken(admin);
    const res = await fetch(
      `https://${РЕГИОН}-aiplatform.googleapis.com/v1/projects/${project}` +
      `/locations/${РЕГИОН}/publishers/google/models/${МОДЕЛЬ}:generateContent`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: ПРАВИЛА }] },
          contents: [{
            role: "user",
            parts: [{
              text: вход(добавка),
            }],
          }],
          // thinkingBudget: 0 — иначе Gemini 2.5 Flash тратит лимит на рассуждения
          generationConfig: { temperature: 0.2, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
    );
    const т = await res.json();
    if (!res.ok) throw new Error(т?.error?.message ?? `HTTP ${res.status}`);
    return (т?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("").trim();
  };

  let ответ = "";
  try {
    ответ = await спросить("");
    // 19.10: в 11:36 при 40 новостях модель ответила МАЛО и час пропал. Повторяем
    // с прямым требованием выбрать лучшую — пропуск только при пустом списке.
    if ((!ответ || ответ === "МАЛО") && новости.length >= 3) {
      ответ = await спросить("\n\nОтвет МАЛО не принимается: выбери лучшую новость с денежной стороной из списка.");
    }
  } catch (e) {
    return json(200, { ok: false, причина: String((e as Error).message).slice(0, 200) });
  }
  if (!ответ || ответ === "МАЛО") return json(200, { ok: true, пропуск: "подходящей новости нет" });

  const номер = Number(ответ.match(/НОМЕР:\s*(\d+)/)?.[1] ?? 0);
  const строки = ответ.split("\n").map((s) => s.trim()).filter((s) => s && !/^НОМЕР:/.test(s));
  const заг = строки.find((s) => /^[•·*\-–—]\s*/.test(s));
  if (!заг) return json(200, { ok: false, причина: "модель не дала новость в формате", ответ: ответ.slice(0, 300) });
  const подробности = строки.slice(строки.indexOf(заг) + 1).join(" ").replace(/^Подробности:\s*/i, "");
  const текст = заг.replace(/^[•·*\-–—]\s*/, "") + (подробности ? "\n" + подробности : "");

  if (проба) {
    return json(200, { ok: true, проба: true, звено, новостей: новости.length, номер, выбрана: новости[номер - 1]?.published_at, текст });
  }

  // Выбранную новость помечаем разобранной — в следующий час её не предложат
  const выбрана = новости[номер - 1];
  if (выбрана) await admin.from("news_items").update({ used_at: new Date().toISOString() }).eq("id", выбрана.id);

  const { data: публикация, error } = await admin.rpc("digest_hourly_create", {
    p_user: cfg.user_id, p_text: текст, p_slot: слот.toISOString(),
  });
  if (error) return json(200, { ok: false, причина: error.message });
  if (!публикация) return json(200, { ok: true, пропуск: "на этот час уже есть" });

  // Превью ей с кнопкой остановки. Не нажала — новость выйдет сама.
  // Тихий режим (переключатель в настройках, колонка auto_publish, её решение 19.10):
  // превью не шлём вовсе, новость выходит без неё.
  if (cfg.auto_publish) return json(200, { ok: true, слот: слот.toISOString(), публикация, тихо: true });
  const { data: bot } = await admin.from("bots").select("token_secret_id").eq("id", cfg.bot_id).maybeSingle();
  const { data: tgToken } = await admin.rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });
  const { data: профиль } = await admin.from("profiles").select("error_notify_tg_id")
    .eq("id", cfg.user_id).maybeSingle();
  if (tgToken && профиль?.error_notify_tg_id) {
    const кнопки = { inline_keyboard: [[{ text: "🛑 Не публиковать", callback_data: `dg:stop:${публикация}` }]] };
    const послать = (тело: Record<string, unknown>) =>
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: профиль.error_notify_tg_id, reply_markup: кнопки, disable_notification: true, ...тело,
        }),
      }).then((r) => r.json()).catch(() => null);
    const шапка = `🕐 В ${поМоскве(слот)} выйдет в канал:\n\n`;
    const итог = await послать({ text: шапка + "⚡️ " + вHtml(текст).replace("\n", "\n\n"), parse_mode: "HTML" });
    if (!итог?.ok) await послать({ text: шапка + текст.replace(/\*\*/g, "") });
  }

  return json(200, { ok: true, слот: слот.toISOString(), публикация, звено, новостей: новости.length });
});
