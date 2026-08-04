// hook-options: «🔄 Другие пять» — новые варианты заголовка в кадр.
//
// Заголовок придумывает Claude, Татьяна выбирает кнопкой. Если ни один из
// пяти не подошёл, она жмёт «Другие пять» — сюда. Ролик заново не смотрим:
// для заголовка хватает разбора и реплики, а перегонять видео в Gemini ещё
// раз долго и дорого.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const REGION = "us-central1";
const MODEL = "gemini-2.5-flash";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── доступ к Google по служебному аккаунту ────────────────────────────────
let cachedToken: { value: string; expiresAt: number } | null = null;

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

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return { token: cachedToken.value, project: sa.project_id };
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
    "pkcs8", pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(header + "." + claims)),
  );
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: header + "." + claims + "." + b64url(sig),
    }),
  });
  const tok = await res.json();
  if (!tok.access_token) throw new Error("Google не выдал токен");
  cachedToken = { value: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 };
  return { token: tok.access_token, project: sa.project_id };
}


const СХЕМА = {
  type: "OBJECT",
  properties: {
    hooks: {
      type: "ARRAY",
      description: "ровно пять НОВЫХ вариантов заголовка, по-русски, 2-5 слов, без точки",
      items: { type: "STRING" },
    },
  },
  required: ["hooks"],
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { video_id, chat_id } = await req.json().catch(() => ({}));
  if (!video_id) return json(200, { ok: true });

  const { data: v } = await admin.from("incoming_videos")
    .select("id, tag, review, hook_options, user_id").eq("id", video_id).maybeSingle();
  if (!v) return json(200, { ok: true });

  const { data: p } = await admin.from("profiles")
    .select("error_notify_tg_id, error_notify_bot_id").eq("id", v.user_id).maybeSingle();
  const { data: bot } = await admin.from("bots")
    .select("token_secret_id").eq("id", p?.error_notify_bot_id).maybeSingle();
  const { data: token } = await admin
    .rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });
  const кому = chat_id ?? p?.error_notify_tg_id;

  const было: string[] = v.hook_options ?? [];
  const { token: gt, project } = await googleToken(admin);
  const res = await fetch(
    `https://${REGION}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${REGION}/publishers/google/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${gt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text: `Ролик для Telegram-канала о личных финансах, серия «интервью ` +
              `со зверем»: деадпан, ироничный чёрный юмор.

` +
              `В кадре: ${v.tag}
Разбор ролика:
${v.review}

` +
              `Придумай ПЯТЬ заголовков в кадр — надпись сверху первые три ` +
              `секунды. Коротко, 2-5 слов, по-русски, без точки. Заголовок ` +
              `цепляет и работает вместе с репликой героя, а не пересказывает её.

` +
              `Эти варианты уже показывали, повторять их нельзя:
` +
              было.map((h) => `— ${h}`).join("\n"),
          }],
        }],
        generationConfig: {
          temperature: 1.2,
          responseMimeType: "application/json",
          responseSchema: СХЕМА,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
  );
  const data = await res.json();
  const новые: string[] = (JSON.parse(
    data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}",
  ).hooks ?? []).slice(0, 5).map((h: string) => h.slice(0, 60));

  if (!новые.length) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: кому, text: "Новые варианты не придумались. Пришлите свой текстом." }),
    }).catch(() => {});
    return json(200, { ok: true });
  }

  await admin.from("incoming_videos").update({ hook_options: новые }).eq("id", v.id);
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: кому,
      text: `Ролик «${v.tag}». Другие пять заголовков:

` +
        новые.map((h, i) => `${i + 1}. ${h.toUpperCase()}`).join("\n") +
        `

Не нравится ни один — пришлите свой текстом.`,
      reply_markup: {
        inline_keyboard: [
          новые.slice(0, 3).map((_, i) => ({
            text: String(i + 1), callback_data: `hk:${v.id}:${i}`,
          })),
          новые.slice(3).map((_, i) => ({
            text: String(i + 4), callback_data: `hk:${v.id}:${i + 3}`,
          })),
          [{ text: "🔄 Другие пять", callback_data: `hk:${v.id}:more` }],
        ],
      },
    }),
  }).catch(() => {});

  return json(200, { ok: true });
});
