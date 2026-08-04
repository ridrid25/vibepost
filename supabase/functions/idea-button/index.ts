// idea-button: обработка нажатий на кнопки под карточками идей.
// Вызывается из telegram-webhook, который пересылает сюда callback_query.
//
// Кнопки:
//   idea:self:<id> — Татьяна делает ролик сама в приложении Gemini (бесплатно).
//                    Бот собирает полный JSON-промт по правилам CLAUDE.md
//                    проекта «Генерация роликов» и присылает блоком-кодом:
//                    на телефоне копируется одним касанием.
//   idea:pay:<id>  — генерируем через Veo (платно).
//   idea:redo:<id> — идея не нравится, придумать замену.
//   idea:no:<id>   — в корзину.
//   idea:more      — придумать ещё пять.
//
// Владелец опознаётся по profiles.error_notify_tg_id: чужим нажатиям не верим.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const REGION = "us-central1";
const MODEL = "gemini-2.5-flash";
// Telegram не пропускает сообщение длиннее 4096 знаков. Держим запас на теги.

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

// ── правила сборки промта (выжимка из CLAUDE.md проекта «Генерация роликов») ──


/** Один запрос к Vertex со своей схемой ответа. Возвращает компактный JSON. */
async function вертекс(
  admin: SupabaseClient,
  text: string,
  temperature: number,
  схема: unknown,
): Promise<string> {
  const { token, project } = await googleToken(admin);
  const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${REGION}/publishers/google/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        temperature,
        responseMimeType: "application/json",
        responseSchema: схема,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 200));
  return JSON.stringify(JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}"));
}

// Функции сборки и сжатия промта удалены 04.08.2026: промт пишет бригада
// на компьютере — сценарист, режиссёр, оператор, критик. Сервер промты
// больше не сочиняет, иначе они идут мимо критика и правил речи.

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const cq = await req.json().catch(() => null);
  const data: string = cq?.data ?? "";
  const fromId = String(cq?.from?.id ?? "");
  if (!/^(idea|cap|veo):/.test(data) || !fromId) {
    return json(200, { ok: true });
  }

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

  const позвать = (count: number) =>
    fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/suggest-ideas`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ count }),
    }).catch(() => null);

  const запустить = (fn: string) =>
    fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/${fn}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    }).catch(() => null);

  // ── согласие на платную генерацию ──────────────────────────────────────
  if (data.startsWith("veo:")) {
    const согласна = data === "veo:on";
    await admin.from("profiles")
      .update({ veo_confirmed_at: согласна ? new Date().toISOString() : null })
      .eq("id", profile.id);
    await tg("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: согласна ? "Запускаю" : "Не буду",
    });
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: согласна
        ? "✅ Согласие на генерацию получено. Запускаю, готовые ролики пришлю сюда."
        : "🚫 Хорошо, платную генерацию не запускаю. Идеи остались одобренными.",
    });
    if (согласна) await запустить("veo-start");
    return json(200, { ok: true });
  }

  // ── выбор подписи к присланному ролику ──────────────────────────────────
  if (data.startsWith("cap:")) {
    const [, что, videoId, номер] = data.split(":");
    const { data: ролик } = await admin
      .from("incoming_videos").select("id, name, caption_options")
      .eq("id", videoId).eq("user_id", profile.id).maybeSingle();
    if (!ролик) {
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Ролик не найден" });
      return json(200, { ok: true });
    }
    const варианты: string[] = ролик.caption_options ?? [];

    if (что === "pick") {
      const выбранная = варианты[Number(номер)];
      if (!выбранная) return json(200, { ok: true });
      await admin.from("incoming_videos")
        .update({ caption: выбранная, ready: true }).eq("id", ролик.id);
      await tg("editMessageText", {
        chat_id: cq.message?.chat?.id,
        message_id: cq.message?.message_id,
        text: `<b>Подпись выбрана</b>

${выбранная}

` +
          `Ролик «${ролик.name}» готов — во «Входящих» осталось поставить время.`,
        parse_mode: "HTML",
      });
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Готово" });
      return json(200, { ok: true });
    }

    if (что === "more") {
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Придумываю ещё…" });
      try {
        const текст = await вертекс(
          admin,
          `Придумай пять НОВЫХ подписей к посту для ролика «${ролик.name}» ` +
            `в Telegram-канал о личных финансах. Короткие, злые, без морали, до 120 знаков. ` +
            `Эти уже отвергли, не повторяйся: ${варианты.join(" / ")}`,
          1.1,
          { type: "OBJECT", properties: { captions: { type: "ARRAY", items: { type: "STRING" } } }, required: ["captions"] },
        );
        const новые: string[] = JSON.parse(текст).captions ?? [];
        await admin.from("incoming_videos")
          .update({ caption_options: новые }).eq("id", ролик.id);
        await tg("sendMessage", {
          chat_id: cq.message?.chat?.id,
          text: "<b>Ещё пять вариантов</b>\n\n" +
            новые.map((c, i) => `${i + 1}. ${c}`).join("\n\n"),
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              новые.slice(0, 3).map((_, i) => ({ text: String(i + 1), callback_data: `cap:pick:${ролик.id}:${i}` })),
              новые.slice(3).map((_, i) => ({ text: String(i + 4), callback_data: `cap:pick:${ролик.id}:${i + 3}` })),
              [{ text: "🔄 Другие пять", callback_data: `cap:more:${ролик.id}` }],
            ].filter((r) => r.length),
          },
        });
      } catch (e) {
        await tg("sendMessage", {
          chat_id: cq.message?.chat?.id,
          text: `Не вышло придумать ещё: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      return json(200, { ok: true });
    }
    return json(200, { ok: true });
  }

  const [, action, ideaId] = data.split(":");
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;

  // Правка реплики: Татьяна отвечает на карточку своим текстом. Идею находим
  // по сообщению, на которое она ответила, и пересобираем промт под новый текст.
  if (action === "edit") {
    const новая = String(cq.new_line ?? "").trim();
    const { data: правимая } = await admin
      .from("video_ideas").select("id, slug, hook, animal")
      .eq("user_id", profile.id).eq("tg_message_id", messageId).maybeSingle();
    if (!правимая || !новая) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Чтобы поправить текст, ответьте именно на карточку идеи и напишите новую реплику.",
      });
      return json(200, { ok: true });
    }
    // Правка реплики — тоже повод переписать промт, а промт пишет бригада.
    // Раньше сервер пересобирал его сам через Gemini: мимо критика, мимо
    // правил речи из JOURNAL.md и без всякой записи для Claude.
    await admin.from("video_ideas")
      .update({ line: новая, prompt: null }).eq("id", правимая.id);
    await admin.from("claude_tasks").insert({
      user_id: правимая.user_id,
      text: `Реплику правили. Переписать промт. Герой: ${правимая.animal}. ` +
        `Хук: ${правимая.hook}. Новая реплика: «${новая}». Slug: ${правимая.slug}. ` +
        `Порядок: scenarist → director → cinematographer → critic, перед этим ` +
        `JOURNAL.md и PROCESS.md. Промт прислать одним блоком.`,
    });
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Принял новый текст:\n\n<i>${новая}</i>\n\n` +
        `Промт под него напишет бригада и пришлёт одним блоком.`,
      parse_mode: "HTML",
    });
    return json(200, { ok: true });
  }

  if (action === "more") {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Придумываю…" });
    await позвать(5);
    return json(200, { ok: true });
  }

  const { data: idea } = await admin
    .from("video_ideas").select("id, slug, hook, line, animal, prompt")
    .eq("id", ideaId).eq("user_id", profile.id).maybeSingle();
  if (!idea) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Идея не найдена" });
    return json(200, { ok: true });
  }

  const решения: Record<string, { status: string; route?: string; итог: string }> = {
    self: { status: "approved", route: "self", итог: "🖐 Собираю промт…" },
    pay: { status: "approved", route: "paid", итог: "💸 Отправлено на генерацию" },
    redo: { status: "rejected", итог: "🔄 Заменю" },
    no: { status: "rejected", итог: "🗑 Убрано" },
  };
  const решение = решения[action];
  if (!решение) return json(200, { ok: true });

  await admin.from("video_ideas")
    .update({
      status: решение.status,
      route: решение.route ?? null,
      decided_at: new Date().toISOString(),
    })
    .eq("id", idea.id);

  if (chatId && messageId) {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `🎬 <b>${idea.hook}</b>\n\n${idea.line}\n\n<i>${idea.animal}</i>\n\n${решение.итог}`,
      parse_mode: "HTML",
    });
  }
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: решение.итог });

  // Промт по идее пишет бригада на компьютере, а не бот. Раньше он собирал
  // его сам через Gemini: получалось длинно, резалось на две склейки, и мимо
  // критика — то есть мимо правил речи из JOURNAL.md. Теперь бот только
  // записывает выбранную идею заданием.
  if (action === "self") {
    await admin.from("claude_tasks").insert({
      user_id: idea.user_id,
      text: `Написать промт ролика по идее. Герой: ${idea.animal}. ` +
        `Хук: ${idea.hook}. Реплика: «${idea.line}». Slug: ${idea.slug}. ` +
        `Порядок обязателен: scenarist → director → cinematographer → critic, ` +
        `перед этим JOURNAL.md и PROCESS.md. Промт прислать одним блоком.`,
    });
    await tg("sendMessage", {
      chat_id: chatId,
      text: `<b>${idea.hook}</b>\n\n<b>Что говорит герой:</b>\n${idea.line}\n\n` +
        `Идею принял. Промт напишет бригада — сценарист, режиссёр, оператор ` +
        `и критик — и пришлю его сюда одним блоком, без склеек.\n\n` +
        `Если Claude сейчас не запущен, промт придёт после ближайшего ` +
        `запуска: задание уже записано и не потеряется.`,
      parse_mode: "HTML",
    });
    return json(200, { ok: true });
  }

  // Платная генерация берёт промт из video_ideas.prompt. Раз промт теперь
  // пишет бригада, без него запускать Veo нечем — иначе списались бы деньги
  // за пустой запрос. Ждём промт, потом её подтверждение.
  if (action === "pay") {
    if (idea.prompt) {
      await запустить("veo-start");
    } else {
      await admin.from("claude_tasks").insert({
        user_id: idea.user_id,
        text: `Написать промт для ПЛАТНОЙ генерации. Герой: ${idea.animal}. ` +
          `Хук: ${idea.hook}. Реплика: «${idea.line}». Slug: ${idea.slug}. ` +
          `Порядок: scenarist → director → cinematographer → critic, перед этим ` +
          `JOURNAL.md и PROCESS.md. Промт записать в video_ideas.prompt и ` +
          `прислать Татьяне смету — без её подтверждения генерацию не запускать.`,
      });
      await tg("sendMessage", {
        chat_id: chatId,
        text: `<b>${idea.hook}</b>\n\nПромт для платной генерации напишет бригада. ` +
          `Пришлю его вместе со сметой — генерация запустится только после ` +
          `вашего подтверждения.`,
        parse_mode: "HTML",
      });
    }
  }
  if (action === "redo") await позвать(1);

  return json(200, { ok: true });
});
