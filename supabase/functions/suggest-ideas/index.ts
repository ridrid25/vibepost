// suggest-ideas: Gemini придумывает идеи роликов и присылает их владелице
// карточками в существующий Telegram flow. TikTok сохраняет прежний house
// mode. YouTube Shorts получает bounded live Trend V0.1 context до карточек.
//
// Доступ к Google — через служебный аккаунт (JSON в Vault, имя google_sa_json):
// подписываем JWT → меняем на токен → зовём Vertex AI. Ключей API не нужно.
// Текстовая модель дешёвая, на кошелёк почти не влияет; видео здесь не
// генерируется вообще — только тексты.
//
// Вызов: POST { count?: number } — по умолчанию 5.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  TARGET_PLATFORMS,
  buildYoutubeApprovedFallback,
  fetchYoutubeTrendCandidates,
  normalizeTargetPlatform,
  platformLabel,
  selectYoutubeExperimentSet,
  trustedIdeaMetadata,
} from "../_shared/youtube-trend.mjs";

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

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
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
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)),
  );
  const assertion = `${header}.${claims}.${b64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const tok = await res.json();
  if (!tok.access_token) throw new Error(`Google не выдал токен: ${JSON.stringify(tok).slice(0, 200)}`);

  cachedToken = { value: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 };
  return { token: tok.access_token, project: sa.project_id };
}

// ── стиль серии: зашит в одном месте, чтобы ролики не разъезжались ────────
const СТИЛЬ = `Серия коротких вертикальных роликов про деньги для
Telegram-канала о личных финансах. Формат каждого: мультяшный 3D в духе Pixar,
вертикаль 9:16, около 8 секунд, интервью со зверем — микрофон у мордочки,
деадпан-взгляд прямо в камеру, ироничный чёрный юмор про деньги, панч в конце.
Место действия любое и лучше неожиданное: среда обитания зверя (пустыня, дно,
лес, нора) или, наоборот, совсем не подходящая ему обстановка. Улица — лишь
один из вариантов, не норма.
Аудитория — русскоязычные взрослые, которых волнуют инфляция, зарплата, кредиты,
налоги, ипотека, накопления, подписки, маркетплейсы, отпуск, пенсия.`;

const СХЕМА = {
  type: "OBJECT",
  properties: {
    ideas: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          slug: { type: "STRING", description: "короткое имя латиницей через дефис, напр. bobr-ipoteka" },
          animal: { type: "STRING", description: "зверь по-русски, одно слово" },
          hook: { type: "STRING", description: "хук-вопрос КАПСОМ по-русски, до 40 символов" },
          line: { type: "STRING", description: "реплика зверя по-русски, панч в конце. СТРОГО 20-25 слогов — это всё, что влезает в ролик на 10 секунд, остальное время нужно действию. Считай гласные. Длиннее — ролик придётся резать, и заказчица потеряет свои слова" },
          prompt: { type: "STRING", description: "промпт для видеомодели по-английски в стиле серии" },
        },
        required: ["slug", "animal", "hook", "line", "prompt"],
      },
    },
  },
  required: ["ideas"],
};

const html = (value: unknown) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

function cardText(idea: Record<string, unknown>, targetPlatform: string): string {
  const platform = platformLabel(targetPlatform);
  const trend = idea.trend_signal === "reference-driven"
    ? "\nТренд-сигнал: reference-driven"
    : "";
  return `🎬 <b>${html(idea.hook)}</b>\n\n${html(idea.line)}\n\n<i>${html(idea.animal)}</i>` +
    `\n\nЦелевая площадка: ${platform}${trend}`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const body = await req.json().catch(() => ({}));
  const count = Math.min(Math.max(Number(body.count) || 5, 1), 5);
  const previewOnly = body.preview_only === true;

  // Владелец = тот, у кого настроены уведомления в Telegram
  const { data: profile } = await admin
    .from("profiles")
    .select("id, error_notify_tg_id, error_notify_bot_id, target_platform")
    .not("error_notify_tg_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (!profile?.error_notify_tg_id || !profile.error_notify_bot_id) {
    return json(400, { error: "В настройках не указан Telegram ID и бот-отправитель" });
  }

  const { data: bot } = await admin
    .from("bots").select("token_secret_id").eq("id", profile.error_notify_bot_id).maybeSingle();
  const { data: token } = await admin
    .rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });
  if (!token) return json(400, { error: "Не удалось получить токен бота" });

  const targetPlatform = normalizeTargetPlatform(profile.target_platform);

  // Чтобы звери не повторялись — показываем модели, кто уже был
  const { data: былые } = await admin
    .from("video_ideas").select("animal").eq("user_id", profile.id).limit(200);
  const занятые = [...new Set((былые ?? []).map((r) => r.animal).filter(Boolean))];

  let ideas: Array<Record<string, string>> = [];
  let experimentSet: Array<Record<string, unknown>> = [];
  let ideaSource = "existing-gemini";
  try {
    if (targetPlatform === TARGET_PLATFORMS.YOUTUBE_SHORTS) {
      const candidates = await fetchYoutubeTrendCandidates({
        apiKey: Deno.env.get("YOUTUBE_API_KEY"),
      });
      experimentSet = selectYoutubeExperimentSet(candidates, count);
    }
  } catch (e) {
    return json(500, { error: `Trend input недоступен: ${e instanceof Error ? e.message : String(e)}` });
  }

  if (targetPlatform === TARGET_PLATFORMS.YOUTUBE_SHORTS) {
    // First field trial uses only the four already Controller-approved V0.1
    // adaptations plus CONTROL. A live model may rewrite their causal beats,
    // so it is deliberately not placed between trusted DNA and Telegram cards.
    ideas = buildYoutubeApprovedFallback(experimentSet);
    ideaSource = "controller-approved-v0.1";
  } else {
    try {
      const { token: gToken, project } = await googleToken(admin);
      const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${project}` +
        `/locations/${REGION}/publishers/google/models/${MODEL}:generateContent`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${gToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [{
              text: `${СТИЛЬ}\n\nПридумай ${count} новых идей.\n` +
                (занятые.length ? `Этих зверей уже использовали, не повторяйся: ${занятые.join(", ")}.\n` : "") +
                `Темы не дублируй между собой. Реплика должна быть смешной и злой, ` +
                `без морали и без объяснений шутки.`,
            }],
          }],
          generationConfig: {
            temperature: 1.1,
            responseMimeType: "application/json",
            responseSchema: СХЕМА,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 300));
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      ideas = JSON.parse(text).ideas ?? [];
    } catch (e) {
      return json(500, { error: `Gemini не ответил: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  if (ideas.length === 0) {
    return json(500, { error: "Генератор идей вернул пустой список" });
  }

  const rows: Array<Record<string, any>> = ideas.map((idea) => {
    const candidate = targetPlatform === TARGET_PLATFORMS.YOUTUBE_SHORTS
      ? experimentSet.find((entry) => entry.reference_source_id === idea.reference_id)
      : null;
    return {
      user_id: profile.id,
      slug: idea.slug,
      animal: idea.animal,
      hook: idea.hook,
      line: idea.line,
      prompt: idea.prompt,
      target_platform: targetPlatform,
      ...(targetPlatform === TARGET_PLATFORMS.YOUTUBE_SHORTS
        ? trustedIdeaMetadata(candidate)
        : {}),
    };
  });

  if (previewOnly) {
    return json(200, {
      ok: true,
      preview: true,
      idea_source: ideaSource,
      target_platform: targetPlatform,
      ideas: rows.map((row) => ({
        slug: row.slug,
        hook: row.hook,
        line: row.line,
        target_platform: row.target_platform,
        trend_signal: row.trend_signal ?? null,
        reference_source_id: row.reference_source_id ?? null,
        reference_published_at: row.reference_published_at ?? null,
        reference_views: row.reference_views ?? null,
        reference_vph: row.reference_vph ?? null,
        reference_channel_baseline_views: row.reference_channel_baseline_views ?? null,
        reference_outlier_ratio: row.reference_outlier_ratio ?? null,
        causal_pattern: row.causal_pattern ?? null,
        payoff_class: row.payoff_class ?? null,
        card_text: cardText(row, targetPlatform),
      })),
    });
  }

  const { data: saved } = await admin
    .from("video_ideas")
    .insert(rows)
    .select("id, animal, hook, line, target_platform, trend_signal");

  // Карточки в бота: под каждой три кнопки
  for (const idea of saved ?? []) {
    const текст = cardText(idea, targetPlatform);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: profile.error_notify_tg_id,
        text: текст,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            // Первый ряд — развилка «кто делает ролик»
            [
              { text: "🖐 Сделаю сама", callback_data: `idea:self:${idea.id}` },
              { text: "💸 Сгенерируй", callback_data: `idea:pay:${idea.id}` },
            ],
            [
              { text: "🔄 Другое", callback_data: `idea:redo:${idea.id}` },
              { text: "🗑 Мимо", callback_data: `idea:no:${idea.id}` },
            ],
          ],
        },
      }),
    });
    const sent = await r.json().catch(() => null);
    if (sent?.result?.message_id) {
      await admin.from("video_ideas")
        .update({ tg_message_id: sent.result.message_id }).eq("id", idea.id);
    }
  }

  // Хвостовое сообщение с кнопкой «ещё»
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: profile.error_notify_tg_id,
      text: `Это все ${saved?.length ?? 0} на сегодня. Мало — жмите кнопку, придумаю ещё.`,
      reply_markup: {
        inline_keyboard: [[{ text: "➕ Ещё пять", callback_data: "idea:more" }]],
      },
    }),
  }).catch(() => {});

  return json(200, { ok: true, создано: saved?.length ?? 0 });
});
