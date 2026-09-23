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
import { normalizeTargetPlatform, platformLabel } from "../_shared/youtube-trend.mjs";
import {
  buildCausalReviewPrompt,
  buildFastReviewPrompt,
  CAUSAL_REVIEW_SCHEMA,
  executeCausalEnrichment,
  FAST_REVIEW_SCHEMA,
  hasCausalPattern,
} from "./review-contract.mjs";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

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

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function logTiming(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
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

type FastReview = {
  review: string;
  ok: boolean;
  speech: string;
  tag: string;
  hooks: string[];
};

type CausalReview = "YES" | "NO" | "UNCERTAIN";

/** Показывает ролик Gemini и просит разбор и дословную реплику. */
async function разобрать(
  admin: SupabaseClient,
  bytes: Uint8Array,
  задумка: string,
  targetPlatform: string,
): Promise<FastReview> {
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
            text: buildFastReviewPrompt({
              targetPlatformLabel: platformLabel(targetPlatform),
              ideaContext: задумка,
            }),
          },
        ],
      }],
      generationConfig: {
        temperature: 0.5,
        responseMimeType: "application/json",
        responseSchema: FAST_REVIEW_SCHEMA,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 200));
  return JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
}

/** Проверяет только causal pattern; полный owner-review повторно не делает. */
async function проверитьCausalPattern(
  admin: SupabaseClient,
  bytes: Uint8Array,
  targetPlatform: string,
  causalPattern: Record<string, unknown>,
): Promise<unknown> {
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
            text: buildCausalReviewPrompt({
              targetPlatformLabel: platformLabel(targetPlatform),
              causalPattern,
            }),
          },
        ],
      }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: CAUSAL_REVIEW_SCHEMA,
      },
    }),
  });
  if (!res.ok) throw new Error(`causal Gemini HTTP ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
}

Deno.serve(async (req) => {
  const requestStartedAt = performance.now();
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
    .from("profiles").select("id, error_notify_bot_id, target_platform, active_video_idea_id")
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

  // Подпись к видео может быть slug идеи. Без подписи используем последнюю
  // идею, явно выбранную через «Сделаю сама»: owner metadata переносить не должен.
  const подпись = String(msg.caption ?? "").trim();
  let name = подпись || video.file_name || "Ролик из Telegram";
  let задумка = "";
  const ideaSelect = "id,slug,hook,line,animal,prompt,target_platform,causal_pattern";
  let idea: Record<string, unknown> | null = null;
  if (подпись) {
    const result = await admin.from("video_ideas").select(ideaSelect)
      .eq("user_id", profile.id).eq("slug", подпись).maybeSingle();
    idea = result.data;
  }
  // «Последнюю выбранную идею» здесь больше не берём — она залипала. Идею
  // находим ниже, по зверю, которого разбор увидел в присланном файле.
  if (idea) {
    name = `${idea.animal} — ${idea.hook}`;
    задумка = `Задумка была такая. Герой: ${idea.animal}. Хук: ${idea.hook}. ` +
      `Реплика: «${idea.line}».`;
  }
  const targetPlatform = normalizeTargetPlatform(idea?.target_platform ?? profile.target_platform);
  const rawCausalPattern = idea?.causal_pattern;
  const causalPattern = hasCausalPattern(rawCausalPattern)
    ? rawCausalPattern as Record<string, unknown>
    : null;

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

    let разбор: FastReview;
    const fastReviewStartedAt = performance.now();
    try {
      разбор = await разобрать(admin, bytes, задумка, targetPlatform);
    } catch (e) {
      разбор = {
        review: `Разобрать ролик не вышло: ${e instanceof Error ? e.message : String(e)}`,
        ok: true, speech: "", tag: "", hooks: [],
      };
    }
    const fastReviewMs = elapsedMs(fastReviewStartedAt);

    // Имя карточки — по тому, кто в кадре, а не по идее, выбранной когда-то
    // раньше. 07-10.09.2026 «активная идея» залипала на неделю: заказчица один
    // раз нажала «Сделаю сама» на горлице, и следующие двадцать четыре ролика
    // (рыба, голубь, скумбрия, як, лори, буйвол) легли во «Входящие» под
    // именем «Горлица — КОПИТЬ ИЛИ ЖИТЬ СЕГОДНЯ?». Она открывала карточку с
    // одним названием и видела совсем другой ролик.
    //
    // Кто в кадре, знает разбор Gemini: он смотрит сам файл. Если его зверь не
    // сходится со зверем идеи, идею к ролику не привязываем вовсе — иначе
    // задания на переделку потянут чужой эталон и чужой промт.
    const зверьВКадре = (разбор.tag ?? "").trim();

    // Завод узнаёт героя сам. Заказчица берёт кнопкой «Сделаю сама» сразу
    // несколько идей — волка, обезьяну, моль — и присылает ролики пачкой, без
    // подписей. Раньше все они получали имя ПОСЛЕДНЕЙ выбранной идеи, и десятки
    // роликов слипались в одного зверя. Теперь смотрим, кого разбор увидел в
    // кадре, и берём ту её идею, где этот зверь и есть: тема и реплика
    // подтягиваются свои.
    if (!idea && зверьВКадре) {
      // Только те листки, по которым ролика ещё не было. Отработанные гасит
      // кнопка «Готово» во Входящих (otrabotana_at). 23.09.2026 заказчица:
      // «зачем он смотрит на шестьдесят? Он у меня до пенсии будет сеть
      // искать?» — и была права: в списке висели идеи от 8 августа, и 24 из
      // 60 уже со снятым роликом. Короткий свежий список — это ровно то, что
      // она держит в уме, когда присылает файл.
      const { data: взятые } = await admin.from("video_ideas").select(ideaSelect)
        .eq("user_id", profile.id).eq("status", "approved").eq("route", "self")
        .is("otrabotana_at", null)
        .order("decided_at", { ascending: false }).limit(25);
      const вКадре = зверьВКадре.toLowerCase();
      const слова = вКадре.split(/[\s,.:;—-]+/).filter((с) => с.length > 2);
      idea = (взятые ?? []).find((и) => {
        const зверь = String(и.animal ?? "").toLowerCase();
        return зверь.length > 2 && (вКадре.includes(зверь) || слова.some((с) => зверь.includes(с)));
      }) ?? null;
      if (idea) {
        name = `${idea.animal} — ${idea.hook}`;
        задумка = `Задумка была такая. Герой: ${idea.animal}. Хук: ${idea.hook}. ` +
          `Реплика: «${idea.line}».`;
      }
    }

    if (idea && зверьВКадре) {
      const идейный = String(idea.animal ?? "").toLowerCase();
      const вКадре = зверьВКадре.toLowerCase();
      const первоеСлово = вКадре.split(/[\s,.:;—-]+/)[0] ?? "";
      const сошлось = идейный.length > 2 &&
        (вКадре.includes(идейный) || идейный.includes(первоеСлово));
      if (!сошлось) {
        // Тему сохраняем: то, что стоит после тире, печатается заголовком
        // прямо в кадре, и по нему заказчица понимает, про что ролик. Меняем
        // только зверя. 10.09.2026 я срезал тему целиком, и она справедливо
        // сказала: «зачем мне говорящая рыба, я должна понимать, на какую
        // тему снимаю».
        name = `${зверьВКадре} — ${String(idea.hook ?? "").trim()}`.replace(/\s—\s$/, "");
        задумка = "";
        idea = null;
      }
    }

    // Каждый присланный файл — своя карточка. Схлопывание «одна идея — одна
    // карточка» (02.09) отменено 07.09: бот вешает на файл без подписи
    // активную идею, и пять разных роликов 06.09 (волк, две обезьяны, два
    // хамелеона) легли в две карточки, затирая друг друга. Лишняя карточка
    // лучше потерянного ролика.
    let incomingVideoId: string | null = null;
    {
      const { data: inserted, error: insertError } = await admin.from("incoming_videos").insert({
        user_id: profile.id,
        idea_id: idea?.id ?? null,
        name: name.slice(0, 200),
        prompt: idea?.prompt ?? null,
        source: `${platformLabel(targetPlatform)} · прислано боту`,
        target_platform: targetPlatform,
        causal_pattern: causalPattern,
        causal_pattern_review: causalPattern ? null : "UNCERTAIN",
        video_url: videoUrl,
        raw_video_url: videoUrl,
        status: "new",
        review: разбор.review,
        tag: разбор.tag?.slice(0, 40) || null,
        hook_options: (разбор.hooks ?? []).slice(0, 5).map((h) => h.slice(0, 60)),
        caption_options: [],
        ready: false,
      }).select("id").maybeSingle();
      if (insertError || !inserted?.id) {
        throw new Error(`incoming video insert failed: ${insertError?.code ?? "missing id"}`);
      }
      incomingVideoId = inserted.id;
    }

    // Идея отработала — снимаем её с «активных». Иначе она висит неделями и
    // подписывает своим именем всё, что приходит следом: так двадцать четыре
    // ролика подряд стали «Горлицей».
    if (idea?.id && profile.active_video_idea_id === idea.id) {
      await admin.from("profiles")
        .update({ active_video_idea_id: null }).eq("id", profile.id);
    }

    // Разбор отдельным сообщением: формат проверяем по данным Telegram
    // Реплику выносим отдельной строкой: по ней сразу видно, проглотил ли
    // герой окончание — из-за этого переделывали скорпиона четыре раза.
    let текст = `<b>Разбор ролика</b>\n\n${разбор.review}`;
    if (разбор.speech) текст += `\n\n<b>Слышно так:</b> «${разбор.speech}»`;
    if (video.width && video.height && video.width > video.height) {
      текст += `\n\n⚠️ Кадр горизонтальный. В приложении Gemini формат <b>9:16</b> — ` +
        `отдельная настройка, словами в промте она не задаётся.`;
    }
    const telegramStartedAt = performance.now();
    const ownerResponse = await ответить(текст);
    const telegramSendMs = elapsedMs(telegramStartedAt);
    logTiming("video_from_bot_owner_review", {
      FAST_REVIEW_MS: fastReviewMs,
      TELEGRAM_SEND_MS: telegramSendMs,
      PRIMARY_LATENCY_MS: elapsedMs(requestStartedAt),
      TELEGRAM_OWNER_OK: ownerResponse?.ok === true,
    });

    if (causalPattern && incomingVideoId) {
      const causalStartedAt = performance.now();
      const causalTask = executeCausalEnrichment({
        analyze: () => проверитьCausalPattern(admin, bytes, targetPlatform, causalPattern),
        persist: async (value: CausalReview) => {
          const { data, error } = await admin.from("incoming_videos")
            .update({ causal_pattern_review: value })
            .eq("id", incomingVideoId)
            .eq("video_url", videoUrl)
            .select("id");
          if (error) throw new Error("causal review persistence failed");
          return (data?.length ?? 0) === 1;
        },
        onFailure: (error: unknown) => {
          console.error(JSON.stringify({
            event: "video_from_bot_causal_failure",
            error_type: error instanceof Error ? error.name : "UnknownError",
          }));
        },
      }).then((outcome: { outcome: string }) => {
        logTiming("video_from_bot_causal_complete", {
          CAUSAL_REVIEW_MS: elapsedMs(causalStartedAt),
          TOTAL_FUNCTION_MS: elapsedMs(requestStartedAt),
          CAUSAL_OUTCOME: outcome.outcome,
        });
      });
      EdgeRuntime.waitUntil(causalTask);
    } else {
      logTiming("video_from_bot_complete", {
        CAUSAL_REVIEW_MS: 0,
        TOTAL_FUNCTION_MS: elapsedMs(requestStartedAt),
        CAUSAL_OUTCOME: causalPattern ? "SKIPPED_NO_TARGET" : "NOT_REQUIRED",
      });
    }

    // Просьбы прислать название здесь больше нет. Решение «годится / не
    // годится» Татьяна принимает кнопками под замером — их шлёт приёмник
    // через минуту, и в них зашит id ролика. Два сообщения подряд с разными
    // указаниями («пришлите название» и «нажмите кнопку») противоречили друг
    // другу и сбивали её.

    // Пять вариантов подписи к посту отсюда убраны. Подписи под видео мы не
    // ставим вовсе, а в ленте бота они читались как «опять предлагает
    // названия» и мешали единственному вопросу: годится ролик или нет.
  } catch (e) {
    await ответить(`Не получилось принять ролик: ${e instanceof Error ? e.message : String(e)}`);
    logTiming("video_from_bot_failed", {
      TOTAL_FUNCTION_MS: elapsedMs(requestStartedAt),
      error_type: e instanceof Error ? e.name : "UnknownError",
    });
  }

  return json(200, { ok: true });
});
