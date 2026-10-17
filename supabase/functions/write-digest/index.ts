// write-digest: из собранных новостей делает сухой дайджест и присылает его
// в бота на утверждение. В канал сам не публикует — только по кнопке.
//
// Пишет Gemini через Vertex AI: он уже оплачен и подключён. Anthropic на этом
// аккаунте без баланса — переключить обратно можно одной строкой (см. МОДЕЛЬ
// и вызов ниже), вся остальная цепочка от модели не зависит.
//
// На вход идут не все собранные посты, а до 25 свежих, каждый обрезан: разница
// между копейками и рублями за пост.
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

const ПРАВИЛА = `Ты составляешь новостной дайджест для телеграм-канала о личных финансах.

Только сухие факты. Никаких шуток, иронии, оценок и эмоций.

Формат ответа — строго такой:
Коротко за день

• первая новость
• вторая новость
• третья новость
• четвёртая новость
• пятая новость
• шестая новость

Требования (решение заказчицы 17.10.2026):
- ровно шесть пунктов — каждая новость выходит отдельным постом, слотов в день шесть;
  меньше шести — только если подходящих новостей действительно нет;
- каждый пункт начинается со знака «•», не со звёздочки и не с цифры;
- одно предложение на пункт, до 140 знаков;
- бери новости, которые касаются денег: ставки, вклады, кредиты, курсы, цены,
  налоги, льготы, выплаты, пенсии, тарифы, зарплаты, санкции, рынки, банки,
  крупные компании, указы и законы о деньгах и собственности;
- иностранные и политические новости брать можно и нужно, если у них есть
  денежная сторона (цены, ставки, налоги, санкции, курсы, рынки);
- пропускай то, что к деньгам не относится: криминал без денежной стороны,
  светскую хронику, военные сводки, заявления политиков без последствий для денег;
- не повторяй одну и ту же новость двумя пунктами;
- пиши своими словами, не копируй формулировки источника;
- никаких «шок», «срочно», «вы не поверите», эмодзи внутри пунктов;
- никаких советов покупать, продавать или вкладывать;
- если подходящих новостей меньше трёх — верни ровно слово: МАЛО

Не добавляй ничего, кроме заголовка и пунктов.`;

Deno.serve(async () => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: cfg } = await admin
    .from("news_config")
    .select("user_id, bot_id, chat_id, enabled")
    .eq("enabled", true).maybeSingle();
  if (!cfg) return json(200, { ok: true, нечего: true });

  const сутки = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  const { data: новости } = await admin
    .from("news_items")
    .select("id, text, published_at")
    .eq("user_id", cfg.user_id)
    .is("used_at", null)
    .gte("published_at", сутки)
    .order("published_at", { ascending: false })
    .limit(60); // 17.10: при 25 выходило три новости из шести слотов
  if (!новости?.length) return json(200, { ok: true, новостей: 0 });

  const сырьё = новости
    .map((n, i) => `${i + 1}. ${n.text.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");

  let текст = "";
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
          contents: [{ role: "user", parts: [{ text: `Новости за сутки:\n\n${сырьё}` }] }],
          // thinkingBudget: 0 — иначе Gemini 2.5 Flash тратит лимит на
          // внутренние рассуждения и обрывает ответ на первом же пункте.
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1500,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
    );
    const ответ = await res.json();
    if (!res.ok) {
      return json(200, { ok: false, причина: ответ?.error?.message ?? `HTTP ${res.status}` });
    }
    текст = (ответ?.candidates?.[0]?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? "").join("").trim()
      // 17.10 модель написала пункты через «* » — приводим к «• »
      .replace(/^[ \t]*[*\-–—][ \t]+/gm, "• ");
  } catch (e) {
    return json(200, { ok: false, причина: String((e as Error).message).slice(0, 200) });
  }

  // Новости считаем разобранными в любом случае — иначе завтра снова полезут.
  await admin.from("news_items")
    .update({ used_at: new Date().toISOString() })
    .in("id", новости.map((n) => n.id));

  if (!текст || текст === "МАЛО") return json(200, { ok: true, мало: true });

  const { data: черновик } = await admin.from("news_digests").insert({
    user_id: cfg.user_id,
    text: текст,
  }).select("id").single();

  const { data: bot } = await admin
    .from("bots").select("token_secret_id").eq("id", cfg.bot_id).maybeSingle();
  const { data: token } = await admin
    .rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });
  const { data: profile } = await admin
    .from("profiles").select("error_notify_tg_id").eq("id", cfg.user_id).maybeSingle();
  if (!token || !profile?.error_notify_tg_id) {
    return json(200, { ok: false, причина: "некуда прислать на утверждение" });
  }

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: profile.error_notify_tg_id,
      text: текст,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ В канал", callback_data: `dg:ok:${черновик!.id}` },
          { text: "🗑 Мимо", callback_data: `dg:no:${черновик!.id}` },
        ]],
      },
    }),
  });

  return json(200, { ok: true, новостей: новости.length, черновик: черновик!.id });
});
