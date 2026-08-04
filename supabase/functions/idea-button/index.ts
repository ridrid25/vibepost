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
const ПРЕДЕЛ_СООБЩЕНИЯ = 3950;

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
const ПРАВИЛА = `Собери промт для генерации вертикального шортса в Gemini/Veo.
Только JSON, никакой прозы: проза теряется в середине, JSON выравнивает вес битов.

ЖЁСТКИЕ ТРЕБОВАНИЯ:
1. Таймлайн посегментный, каждый бит 0.6-1.2 секунды, суммарно ровно 10 секунд.
   Один сегмент = одно физическое событие. Длинную фразу режь на 2-3 бита.
2. Ни один сегмент не остаётся без поля action, даже если там пауза.
3. Пластика героя: 4-6 характерных движений реального животного (не мультгероя).
   Один жест повтори дважды за ролик, второй раз — в неподходящий момент.
   Жест должен ломать равновесие героя, а не сопровождать реплику.
4. Антидействие: герой делает то, что ему совершенно не свойственно, абсолютно
   серьёзно. Natura показана до слома; один признак исходной природы остаётся
   внутри слома (тело продолжает выдавать натуру).
5. Реквизит: вводится действием (вырвать, вытащить), ведётся через весь ролик
   без исчезновений, возвращается в финале с обратным смыслом. Ровно один
   экземпляр каждого предмета.
6. Второстепенный персонаж в той зоне, где герой статичен, обязательно с
   физическим контактом. Реакция героя задержана на бит.
7. Световые события отдельным полем light_events с таймкодами. В базовом
   lighting — контровой свет с двух сторон разного цвета.
8. Драматургия: 0.0-0.7 хук физическим событием без реплики; 0.7-5.0 развитие,
   каждая реплика подпёрта гэгом; 5.0-7.0 перелом; 7.0-8.0 пауза с мелким
   действием; 8.0-10.0 добивка с деталью, ради которой пересматривают.
9. Речь: реплики по-русски в поле line, всё остальное по-английски. Каждый
   action с репликой начинается со слов "spoken fast".
10. Отрицания превращай в утверждения: не "предмета нет", а "лапы пустые".
11. Негатив обязателен и полный, включая: slow speech, drawn-out delivery,
    subtitles, captions, watermark, text overlay, burned-in graphics,
    English speech, foreign accent, static camera, locked-off shots,
    floating objects, duplicate props, object duplication, extra limbs,
    multiple characters, character changing appearance mid-shot.
12. Текст в кадре запрещён, если он не физический реквизит по сюжету.

ВАЖНО ПРО РАЗМЕР: весь JSON должен уместиться в 3000 символов. Пиши описания
плотно, без воды, без повторов между полями.`;

const СХЕМА_ПРОМТА = {
  type: "OBJECT",
  properties: {
    duration_seconds: { type: "NUMBER" },
    aspect_ratio: { type: "STRING" },
    style: { type: "STRING" },
    shot: {
      type: "OBJECT",
      properties: { continuity: { type: "STRING" }, framing: { type: "STRING" } },
      required: ["continuity", "framing"],
    },
    subject: {
      type: "OBJECT",
      properties: {
        character: { type: "STRING" },
        physicality: { type: "STRING" },
        characteristic_moves: { type: "STRING" },
        anti_action: { type: "STRING" },
        consistency: { type: "STRING" },
      },
      required: ["character", "physicality", "characteristic_moves", "anti_action", "consistency"],
    },
    props: { type: "STRING", description: "предметы и их путь через ролик, одной плотной строкой" },
    environment: { type: "STRING" },
    lighting: { type: "STRING" },
    audio: {
      type: "OBJECT",
      properties: {
        language: { type: "STRING" },
        delivery: { type: "STRING" },
        pacing: { type: "STRING" },
        lip_sync: { type: "STRING" },
        sfx: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["language", "delivery", "pacing", "lip_sync", "sfx"],
    },
    timeline: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          t: { type: "STRING", description: "например 1.6-2.6" },
          line: { type: "STRING", description: "реплика по-русски, пустая строка если её нет" },
          action: { type: "STRING" },
          camera: { type: "STRING" },
        },
        required: ["t", "line", "action", "camera"],
      },
    },
    secondary_action: { type: "STRING" },
    light_events: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { t: { type: "STRING" }, event: { type: "STRING" } },
        required: ["t", "event"],
      },
    },
    negative_prompt: { type: "STRING" },
  },
  required: [
    "duration_seconds", "aspect_ratio", "style", "shot", "subject", "props",
    "environment", "lighting", "audio", "timeline", "secondary_action",
    "light_events", "negative_prompt",
  ],
};

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

/** Собирает полный JSON-промт по идее. Возвращает компактную строку. */
async function собратьПромт(
  admin: SupabaseClient,
  idea: { animal: string; hook: string; line: string },
): Promise<string> {
  const { token, project } = await googleToken(admin);
  const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${REGION}/publishers/google/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [{
          text: `${ПРАВИЛА}\n\nГерой: ${idea.animal}. Хук: ${idea.hook}.\n` +
            `Реплика героя целиком: «${idea.line}»\n` +
            `Разрежь эту реплику на 2-4 бита по смыслу и разложи по таймлайну.\n` +
            `Формат 9:16, 10 секунд, интервью со зверем: микрофон у морды, ` +
            `деадпан, ироничный чёрный юмор про деньги. Место действия любое и ` +
            `лучше неожиданное — его среда обитания или совсем не подходящая ему ` +
            `обстановка, не обязательно улица.`,
        }],
      }],
      generationConfig: {
        temperature: 0.9,
        responseMimeType: "application/json",
        responseSchema: СХЕМА_ПРОМТА,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 200));
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  // Пересобираем компактно: отступы съедают лимит сообщения впустую
  return JSON.stringify(JSON.parse(text));
}

/**
 * Ужимает готовый промт, если он не влезает в одно сообщение Telegram.
 * Просить краткость в первом проходе бесполезно — модель всё равно
 * расписывается; отдельный проход «сократи вот это» работает надёжно.
 */
async function сжать(admin: SupabaseClient, промт: string, предел: number): Promise<string> {
  const { token, project } = await googleToken(admin);
  const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${REGION}/publishers/google/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [{
          text: `Сократи этот промт до ${предел} символов в компактном JSON.\n` +
            `НЕЛЬЗЯ: убирать поля, убирать сегменты таймлайна, менять тайминги, ` +
            `менять реплики в line, сокращать negative_prompt.\n` +
            `МОЖНО: убирать повторы между полями, вычёркивать украшающие ` +
            `прилагательные, оставлять в action только физическое действие.\n\n` +
            промт,
        }],
      }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: СХЕМА_ПРОМТА,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) return промт; // не вышло — отдаём как было, уйдёт двумя частями
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  try {
    const сжатый = JSON.stringify(JSON.parse(text));
    return сжатый.length < промт.length ? сжатый : промт;
  } catch {
    return промт;
  }
}

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
    await admin.from("video_ideas").update({ line: новая }).eq("id", правимая.id);
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Принял новый текст:

<i>${новая}</i>

Пересобираю промт…`,
      parse_mode: "HTML",
    });
    try {
      let промт = await собратьПромт(admin, { ...правимая, line: новая });
      if (промт.length > ПРЕДЕЛ_СООБЩЕНИЯ) промт = await сжать(admin, промт, 2600);
      await admin.from("video_ideas").update({ prompt: промт }).eq("id", правимая.id);
      await tg("sendMessage", {
        chat_id: chatId, text: `<pre>${промт}</pre>`, parse_mode: "HTML",
      });
    } catch (e) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `Текст сохранён, но промт собрать не вышло: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
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

  if (action === "self") {
    try {
      let промт = await собратьПромт(admin, idea);
      if (промт.length > ПРЕДЕЛ_СООБЩЕНИЯ) {
        промт = await сжать(admin, промт, 2600);
      }
      await admin.from("video_ideas").update({ prompt: промт }).eq("id", idea.id);

      // Реплики выписываем отдельно: выискивать их из JSON неудобно.
      let реплики = "";
      try {
        реплики = (JSON.parse(промт).timeline ?? [])
          .filter((s: { line?: string }) => s.line)
          .map((s: { line: string }) => s.line)
          .join(" ");
      } catch { /* промт всё равно отправим */ }

      await tg("sendMessage", {
        chat_id: chatId,
        text: `<b>${idea.hook}</b>\n\n` +
          (реплики ? `<b>Что говорит герой:</b>\n${реплики}\n\n` : "") +
          `Блок ниже — готовый промт. Нажмите на него, ` +
          `он скопируется целиком, и вставьте в Gemini.\n` +
          `Формат <b>9:16</b> выберите в самом приложении — словами он не задаётся.\n` +
          `Готовый ролик пришлите мне сюда же или назовите файл ` +
          `<code>${idea.slug}</code> и положите в папку «2 Готовые».`,
        parse_mode: "HTML",
      });

      // Влезает в одно сообщение — шлём одним блоком, иначе режем пополам
      // по границе между элементами, чтобы обе части оставались читаемыми.
      if (промт.length <= ПРЕДЕЛ_СООБЩЕНИЯ) {
        await tg("sendMessage", {
          chat_id: chatId, text: `<pre>${промт}</pre>`, parse_mode: "HTML",
        });
      } else {
        const середина = промт.lastIndexOf("},", Math.floor(промт.length / 2)) + 2;
        const части = [промт.slice(0, середина), промт.slice(середина)];
        for (let i = 0; i < части.length; i++) {
          await tg("sendMessage", {
            chat_id: chatId,
            text: `Часть ${i + 1} из ${части.length} — склейте подряд:\n<pre>${части[i]}</pre>`,
            parse_mode: "HTML",
          });
        }
      }
    } catch (e) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `Промт собрать не удалось: ${e instanceof Error ? e.message : String(e)}\n` +
          `Идея сохранена, попробуйте нажать «Сделаю сама» ещё раз.`,
      });
    }
  }

  if (action === "pay") await запустить("veo-start");
  if (action === "redo") await позвать(1);

  return json(200, { ok: true });
});
