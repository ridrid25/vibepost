// video-from-bot: приём роликов, присланных боту в личку, с разбором.
//
// Это «телефонный» путь: сгенерировали ролик в приложении → Поделиться → бот.
// Бот не просто складывает файл, а:
//   1. кладёт его в хранилище и заводит запись во «Входящих»;
//   2. показывает ролик Gemini и просит разобрать: вертикальный ли, есть ли
//      речь, попал ли в задумку, что не так;
//   3. предлагает пять вариантов подписи к посту кнопками.
// Пока подпись не выбрана, ролик помечен ready=false — он виден во «Входящих»,
// но мы понимаем, что его ещё не согласовали.
//
// Вжечь титры в видео здесь нельзя: для этого нужен ffmpeg, а на сервере его
// нет. Хук рисует сама видеомодель при генерации.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const REGION = "us-central1";
const MODEL = "gemini-2.5-flash";
// Telegram отдаёт ботам файлы не больше 20 МБ.
const ПРЕДЕЛ = 20 * 1024 * 1024;

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

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const шаг = 0x8000; // по кускам, иначе стек не выдержит длинный apply
  for (let i = 0; i < bytes.length; i += шаг) {
    bin += String.fromCharCode(...bytes.subarray(i, i + шаг));
  }
  return btoa(bin);
}

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

const СХЕМА_РАЗБОРА = {
  type: "OBJECT",
  properties: {
    review: {
      type: "STRING",
      description: "разбор ролика для владелицы, 2-4 коротких пункта через перенос строки, " +
        "по-русски: что в кадре, есть ли речь и понятна ли она, что смущает",
    },
    ok: { type: "BOOLEAN", description: "годится ли ролик в канал без переделки" },
    captions: {
      type: "ARRAY",
      description: "пять разных вариантов подписи к посту по-русски, до 120 знаков каждый",
      items: { type: "STRING" },
    },
  },
  required: ["review", "ok", "captions"],
};

/** Показывает ролик Gemini и просит разбор плюс пять подписей. */
async function разобрать(
  admin: SupabaseClient,
  bytes: Uint8Array,
  задумка: string,
): Promise<{ review: string; ok: boolean; captions: string[] }> {
  const { token, project } = await googleToken(admin);
  const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${REGION}/publishers/google/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: "video/mp4", data: toBase64(bytes) } },
          {
            // Место действия не проверяем: «улица» была случайным словом в
            // описании серии, и разбор из-за него ругал ролики за пустыню и
            // морское дно. Интервью может быть где угодно.
            text: `Это ролик для Telegram-канала о личных финансах. Серия ` +
              `«интервью со зверем»: микрофон у морды, зверь отвечает на вопрос ` +
              `про деньги, деадпан, ироничный чёрный юмор. Место действия любое — ` +
              `его среда обитания или, наоборот, совсем не подходящая ему обстановка. ` +
              `За место не ругай.\n${задумка}\n\n` +
              `Посмотри ролик и дай короткий честный разбор: что в кадре, звучит ли ` +
              `речь и разборчива ли она, вертикальный ли кадр, попал ли в задумку, ` +
              `что смущает. Хвалить не надо, отмечай только существенное.\n\n` +
              `Затем предложи пять РАЗНЫХ подписей к посту: короткие, злые, без морали ` +
              `и без пояснения шутки. Разные по приёму — вопрос, констатация, ` +
              `цифра, реплика героя, обращение к читателю.`,
          },
        ],
      }],
      generationConfig: {
        temperature: 1.0,
        responseMimeType: "application/json",
        responseSchema: СХЕМА_РАЗБОРА,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 200));
  return JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const msg = await req.json().catch(() => null);
  const fromId = String(msg?.from?.id ?? "");
  const video = msg?.video ??
    (String(msg?.document?.mime_type ?? "").startsWith("video/") ? msg.document : null);
  if (!fromId || !video?.file_id) return json(200, { ok: true });

  const { data: profile } = await admin
    .from("profiles").select("id, error_notify_bot_id")
    .eq("error_notify_tg_id", fromId).maybeSingle();
  if (!profile?.error_notify_bot_id) return json(200, { ok: true });

  const { data: bot } = await admin
    .from("bots").select("token_secret_id").eq("id", profile.error_notify_bot_id).maybeSingle();
  const { data: token } = await admin
    .rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });
  if (!token) return json(200, { ok: true });

  const tg = (method: string, payload: unknown) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
  const ответить = (text: string) =>
    tg("sendMessage", { chat_id: msg.chat.id, text, parse_mode: "HTML" });

  if ((video.file_size ?? 0) > ПРЕДЕЛ) {
    await ответить("Ролик тяжелее 20 МБ — Telegram не отдаёт такие ботам.");
    return json(200, { ok: true });
  }

  // Подпись к видео может быть slug идеи — тогда подтягиваем задумку
  const подпись = String(msg.caption ?? "").trim();
  let name = подпись || video.file_name || "Ролик из Telegram";
  let задумка = "";
  if (подпись) {
    const { data: idea } = await admin
      .from("video_ideas").select("hook, line, animal")
      .eq("user_id", profile.id).eq("slug", подпись).maybeSingle();
    if (idea) {
      name = `${idea.animal} — ${idea.hook}`;
      задумка = `Задумка была такая. Герой: ${idea.animal}. Хук: ${idea.hook}. ` +
        `Реплика: «${idea.line}».`;
    }
  }

  try {
    await ответить("Принял, смотрю ролик…");

    const info = await (await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${video.file_id}`,
    )).json();
    const path = info?.result?.file_path;
    if (!path) throw new Error("Telegram не отдал файл");
    const bytes = new Uint8Array(
      await (await fetch(`https://api.telegram.org/file/bot${token}/${path}`)).arrayBuffer(),
    );

    const ext = (path.split(".").pop() ?? "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
    const key = `${profile.id}/incoming/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await admin.storage.from("post-photos")
      .upload(key, bytes, { contentType: "video/mp4", upsert: false });
    if (upErr) throw new Error(upErr.message);
    const videoUrl = admin.storage.from("post-photos").getPublicUrl(key).data.publicUrl;

    let разбор: { review: string; ok: boolean; captions: string[] };
    try {
      разбор = await разобрать(admin, bytes, задумка);
    } catch (e) {
      разбор = {
        review: `Разобрать ролик не вышло: ${e instanceof Error ? e.message : String(e)}`,
        ok: true,
        captions: [],
      };
    }

    const { data: row } = await admin.from("incoming_videos").insert({
      user_id: profile.id,
      name: name.slice(0, 200),
      source: "прислано боту",
      video_url: videoUrl,
      status: "new",
      review: разбор.review,
      caption_options: разбор.captions,
      ready: false,
    }).select("id").single();

    // Разбор отдельным сообщением: формат проверяем по данным Telegram
    let текст = `<b>Разбор ролика</b>\n\n${разбор.review}`;
    if (video.width && video.height && video.width > video.height) {
      текст += `\n\n⚠️ Кадр горизонтальный. В приложении Gemini формат <b>9:16</b> — ` +
        `отдельная настройка, словами в промте она не задаётся.`;
    }
    await ответить(текст);

    if (разбор.captions.length) {
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        text: "<b>Выберите подпись к посту</b>\n\n" +
          разбор.captions.map((c, i) => `${i + 1}. ${c}`).join("\n\n") +
          "\n\nНе нравится ни одна — нажмите «🔄 Другие пять» или просто " +
          "ответьте на это сообщение своим текстом.",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            разбор.captions.slice(0, 3).map((_, i) => ({
              text: String(i + 1), callback_data: `cap:pick:${row!.id}:${i}`,
            })),
            разбор.captions.slice(3).map((_, i) => ({
              text: String(i + 4), callback_data: `cap:pick:${row!.id}:${i + 3}`,
            })),
            [{ text: "🔄 Другие пять", callback_data: `cap:more:${row!.id}` }],
          ],
        },
      });
    } else {
      await ответить("Ролик во «Входящих». Подпись напишите сами — " +
        "ответьте на это сообщение своим текстом.");
    }
  } catch (e) {
    await ответить(`Не получилось принять ролик: ${e instanceof Error ? e.message : String(e)}`);
  }

  return json(200, { ok: true });
});
