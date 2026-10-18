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
  компании, указы и законы о деньгах и собственности; иностранные и политические
  новости — если у них есть денежная сторона;
- не подходит: криминал без денежной стороны, светская хроника, военные сводки,
  заявления без последствий для денег;
- НЕ бери то, что уже вышло сегодня (список «Уже вышло» ниже), даже другими словами;
- вторая строка начинается со знака «•»; суть в **двойных звёздочках**, до 110
  знаков, затем «, — » и источник: кто сказал или сообщил (ведомство, человек,
  издание); нет говорящего — издание из пометки [источник: …];
- третья строка — подробности до 300 знаков, 2–3 ключевых факта в **двойных
  звёздочках**, без маркера и не начиная с тире;
- ссылки, призывы подписаться и эмодзи не пиши — их добавит система;
- пиши своими словами, не копируй формулировки источника;
- никаких «шок», «срочно», «вы не поверите»; никаких советов покупать или продавать;
- если подходящей новости нет — верни ровно слово: МАЛО`;

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
    .select("user_id, bot_id, enabled, digest_mode").eq("enabled", true).maybeSingle();
  if (!cfg || (cfg.digest_mode !== "hourly" && !проба)) return json(200, { ok: true, пропуск: "режим не hourly" });

  // Ближайший полный час. Публикуем только 08:00…18:00 МСК.
  const слот = new Date(Math.ceil((Date.now() + 60_000) / 3_600_000) * 3_600_000);
  const часМск = (слот.getUTCHours() + 3) % 24;
  if (!проба && (часМск < 8 || часМск > 18)) return json(200, { ok: true, пропуск: `час ${часМск} вне 08–18` });

  const { data: уже } = await admin.from("news_digest_publications")
    .select("id").eq("user_id", cfg.user_id).eq("hourly", true)
    .eq("base_slot_at", слот.toISOString()).maybeSingle();
  if (уже && !проба) return json(200, { ok: true, пропуск: "на этот час уже есть" });

  // Свежие новости: за 2 часа, мало — за 4
  let новости: Новость[] = [];
  for (const часов of (проба && Number(тело?.часов) > 0 ? [Number(тело.часов)] : [2, 4])) {
    const { data } = await admin.from("news_items")
      .select("id, text, published_at, source_id")
      .eq("user_id", cfg.user_id).is("used_at", null)
      .gte("published_at", new Date(Date.now() - часов * 3_600_000).toISOString())
      .order("published_at", { ascending: false }).limit(40);
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

  let ответ = "";
  try {
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
              text: `Уже вышло сегодня:\n${ужеВышло.length ? ужеВышло.map((t) => "- " + t).join("\n") : "(ничего)"}` +
                `\n\nСвежие новости:\n\n${сырьё}`,
            }],
          }],
          // thinkingBudget: 0 — иначе Gemini 2.5 Flash тратит лимит на рассуждения
          generationConfig: { temperature: 0.2, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
    );
    const тело = await res.json();
    if (!res.ok) return json(200, { ok: false, причина: тело?.error?.message ?? `HTTP ${res.status}` });
    ответ = (тело?.candidates?.[0]?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? "").join("").trim();
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
    return json(200, { ok: true, проба: true, новостей: новости.length, номер, выбрана: новости[номер - 1]?.published_at, текст });
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

  return json(200, { ok: true, слот: слот.toISOString(), публикация, новостей: новости.length });
});
