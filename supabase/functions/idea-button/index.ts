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
import { platformLabel } from "../_shared/youtube-trend.mjs";

const REGION = "us-central1";
const MODEL = "gemini-2.5-flash";
// Telegram не пропускает сообщение длиннее 4096 знаков. Держим запас на теги.

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const html = (value: unknown) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

function ideaCard(idea: Record<string, unknown>, suffix = "") {
  const trend = idea.trend_signal === "reference-driven"
    ? "\nТренд-сигнал: reference-driven"
    : "";
  return `🎬 <b>${html(idea.hook)}</b>\n\n${html(idea.line)}\n\n<i>${html(idea.animal)}</i>` +
    `\n\nЦелевая площадка: ${platformLabel(String(idea.target_platform ?? "tiktok"))}` +
    `${trend}${suffix ? `\n\n${suffix}` : ""}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** evidence_roots приходит из базы как jsonb: тип нужен, иначе deno check ругается. */
type Корни = {
  MARKET_REFERENCE?: { mechanics?: unknown[] };
  OWNER_PREFERENCE?: { market_avoidance?: unknown[] };
} | null | undefined;

function trustedTaskContext(
  idea: Record<string, unknown>,
  ownerPreference: unknown = null,
  learningEvidence: unknown = null,
) {
  const platform = String(idea.target_platform ?? "tiktok");
  if (platform !== "youtube_shorts") {
    const ownPerformance = {
      source_type: "OWN_PERFORMANCE",
      hypothesis_id: idea.hypothesis_id ?? null,
      selected_lesson_ids: idea.selected_lesson_ids ?? [],
      avoided_lesson_ids: idea.avoided_lesson_ids ?? [],
      changed_variable: idea.changed_variable ?? null,
      constants: idea.experiment_constants ?? {},
      prompt_framework_id: idea.prompt_framework_id ?? null,
      prompt_framework_version: idea.prompt_framework_version ?? null,
      feedback_context_hash: idea.feedback_context_hash ?? null,
      evidence: learningEvidence ?? { selected_lessons: [], avoided_patterns: [] },
    };
    const marketReference = idea.market_context_hash ? {
      source_type: "MARKET_REFERENCE",
      mechanics: (idea.evidence_roots as Корни)?.MARKET_REFERENCE?.mechanics ?? [],
      changed_variable: idea.changed_variable ?? null,
      confidence: idea.idea_confidence ?? "LOW",
      limitations: ((idea.evidence_conflicts ?? []) as Array<Record<string, unknown>>).map((entry) => ({
        conflict_type: entry.conflict_type, resolution: entry.resolution,
        confidence: entry.confidence, limitations: entry.limitations,
      })),
    } : { source_type: "MARKET_REFERENCE", mechanics: [] };
    const marketAvoidance = (idea.evidence_roots as Корни)?.OWNER_PREFERENCE?.market_avoidance ?? [];
    return `target_platform=tiktok; сохранить существующий current production house format. ` +
      `TRUSTED OWN_PERFORMANCE: ${JSON.stringify(ownPerformance)}. ` +
      `OWNER_PREFERENCE (не performance evidence): ${JSON.stringify(ownerPreference ?? {
        source_type: "OWNER_PREFERENCE", approved: [], rejected: [],
      })}; market_avoidance=${JSON.stringify(marketAvoidance)}. ` +
      `SANITIZED MARKET_REFERENCE (не own result): ${JSON.stringify(marketReference)}. ` +
      `Source URL, creator identity, caption/transcript и exact shots не использовать. ` +
      `Rejected lesson IDs — только avoidance. Изменять ровно ` +
      `${String(idea.changed_variable ?? "NO_STRONG_HYPOTHESIS")}; constants не менять.`;
  }
  const metadata = {
    target_platform: "youtube_shorts",
    reference_id: idea.reference_source_id ?? null,
    causal_pattern: idea.causal_pattern ?? null,
    payoff_class: idea.payoff_class ?? null,
    critical_fidelity_constraints: idea.fidelity_constraints ?? null,
  };
  const ownPerformance = {
    source_type: "OWN_PERFORMANCE",
    creative_id: "resolved only by canonical creative_identity_map at prompt persistence",
    hypothesis_id: idea.hypothesis_id ?? null,
    experiment_ids: idea.own_experiment_ids ?? [],
    selected_lesson_ids: idea.selected_lesson_ids ?? [],
    avoided_lesson_ids: idea.avoided_lesson_ids ?? [],
    changed_variable: idea.changed_variable ?? null,
    constants: idea.experiment_constants ?? {},
    evidence: learningEvidence ?? { selected_lessons: [], avoided_patterns: [] },
  };
  return `TRUSTED MARKET_REFERENCE: ${JSON.stringify(metadata)}. ` +
    `TRUSTED OWN_PERFORMANCE: ${JSON.stringify(ownPerformance)}. ` +
    `OWNER_PREFERENCE (не performance evidence): ${JSON.stringify(ownerPreference ?? {
      source_type: "OWNER_PREFERENCE", approved: [], rejected: [],
    })}. Evidence conflicts: ${JSON.stringify(idea.evidence_conflicts ?? [])}. ` +
    `Для reference-driven идеи causal_pattern, beat order, viewer prediction, ` +
    `violation class, escalation и payoff class сохранить. Source character, ` +
    `dialogue, plot, shots, branding и creator identity не копировать. Финальный ` +
    `prompt: vertical 9:16, около 10 секунд, ранний visual hook, один главный ` +
    `герой и prop/mechanism, ясный visual payoff, короткая русская реплика.`;
}

async function ownerPreferenceContext(
  admin: SupabaseClient, userId: string, excludeIdeaId: string, targetPlatform: string,
) {
  const { data: approved, error: approvedError } = await admin.from("video_ideas")
    .select("id,status,route,decided_at,animal,hook")
    .eq("user_id", userId).eq("target_platform", targetPlatform)
    .not("decided_at", "is", null).neq("id", excludeIdeaId)
    .in("route", ["self", "paid"]).in("status", ["approved", "generating", "done"])
    .order("decided_at", { ascending: false }).order("id").limit(10);
  const { data: rejected, error: rejectedError } = await admin.from("video_ideas")
    .select("id,status,route,decided_at,animal,hook")
    .eq("user_id", userId).eq("target_platform", targetPlatform)
    .not("decided_at", "is", null).neq("id", excludeIdeaId)
    .is("route", null).eq("status", "rejected")
    .order("decided_at", { ascending: false }).order("id").limit(10);
  if (approvedError || rejectedError) throw approvedError ?? rejectedError;
  const shape = (row: Record<string, unknown>) => ({
    idea_id: row.id, animal: row.animal ?? null, hook: row.hook ?? null,
    route: row.route ?? null, decided_at: row.decided_at,
  });
  return {
    source_type: "OWNER_PREFERENCE",
    approved: (approved ?? []).map(shape),
    rejected: (rejected ?? []).map(shape),
  };
}

async function feedbackEvidenceContext(admin: SupabaseClient, userId: string, idea: Record<string, any>) {
  const selectedIds = Array.isArray(idea.selected_lesson_ids) ? idea.selected_lesson_ids : [];
  const avoidedIds = Array.isArray(idea.avoided_lesson_ids) ? idea.avoided_lesson_ids : [];
  const ids = [...new Set([...selectedIds, ...avoidedIds])];
  if (!ids.length) return { selected_lessons: [], avoided_patterns: [] };
  const { data, error } = await admin.from("content_lessons")
    .select("id,lesson,category,status,confidence")
    .eq("user_id", userId).in("id", ids);
  if (error) throw error;
  const byId = new Map((data ?? []).map((row) => [row.id, row]));
  const shape = (id: string) => byId.get(id) ?? { id, missing: true };
  return {
    selected_lessons: selectedIds.map(shape),
    avoided_patterns: avoidedIds.map(shape),
  };
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
  const chatId = cq?.message?.chat?.id;
  const messageId = cq?.message?.message_id;
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

  const позвать = (count: number, requestId: string) =>
    fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/suggest-ideas`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ count, request_id: `telegram:${requestId}` }),
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
        .update({
          caption: выбранная,
          ready: true,
          owner_accepted_at: new Date().toISOString(),
        }).eq("id", ролик.id);
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

  // Правка реплики: Татьяна отвечает на карточку своим текстом. Идею находим
  // по сообщению, на которое она ответила, и пересобираем промт под новый текст.
  if (action === "edit") {
    const новая = String(cq.new_line ?? "").trim();
    const { data: правимая } = await admin
      .from("video_ideas").select(
        "id,user_id,status,slug,hook,animal,target_platform,trend_signal,reference_source_id,causal_pattern,payoff_class,fidelity_constraints",
      )
      .eq("user_id", profile.id).eq("tg_message_id", messageId).maybeSingle();
    if (!правимая || !новая) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Чтобы поправить текст, ответьте именно на карточку идеи и напишите новую реплику.",
      });
      return json(200, { ok: true });
    }
    if (правимая.status !== "new") {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Эта идея уже выбрана. Старую карточку не переписываю: выберите новую идею.",
      });
      return json(200, { ok: true });
    }
    // POST-04: draft edit is kept, but prompt work starts only after the
    // explicit self/pay owner decision. This prevents an orphan pre-approval task.
    const { data: edited, error: editError } = await admin.from("video_ideas")
      .update({ line: новая, prompt: null }).eq("id", правимая.id).eq("status", "new")
      .select("id").maybeSingle();
    if (editError) throw editError;
    if (!edited) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Эта идея уже была выбрана параллельно. Правку не применяю.",
      });
      return json(200, { ok: true });
    }
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Принял новый текст:\n\n<i>${новая}</i>\n\n` +
        `После выбора «Сделаю сама» или «Сгенерируй» бригада напишет промт ` +
        `под этот текст и пришлёт одним блоком.`,
      parse_mode: "HTML",
    });
    return json(200, { ok: true });
  }

  if (action === "more") {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Придумываю…" });
    await позвать(5, cq.id);
    return json(200, { ok: true });
  }

  const { data: idea } = await admin
    .from("video_ideas").select("id,user_id,status,route,decided_at,slug,hook,line,animal,prompt,target_platform,trend_signal,reference_source_id,causal_pattern,payoff_class,fidelity_constraints,hypothesis_id,selected_lesson_ids,avoided_lesson_ids,changed_variable,experiment_constants,prompt_framework_id,prompt_framework_version,feedback_context_hash,youtube_feedback_context_hash,own_experiment_ids,market_reference_ids,market_dna_ids,owner_preference_ids,evidence_roots,evidence_conflicts,idea_confidence,evidence_mode,market_context_hash,market_mechanic_key,novelty_status")
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
  if (["self", "pay"].includes(action) && idea.target_platform === "youtube_shorts") {
    const { data: mapping, error: mappingError } = await admin.from("creative_identity_map")
      .select("id,creative_id").eq("user_id", idea.user_id)
      .eq("platform", "youtube_shorts").eq("video_idea_id", idea.id).maybeSingle();
    if (mappingError || !mapping) {
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id, text: "Сначала нужен Creative Handoff",
      });
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Промт не создаю: у идеи ещё нет принятой связи с Text Factory revision. " +
          "Сначала выполните существующий Creative Handoff; identity не угадывается.",
      });
      return json(200, { ok: true, blocked: "youtube_creative_mapping_required" });
    }
  }
  const ownerPreference = ["tiktok", "youtube_shorts"].includes(idea.target_platform)
    ? await ownerPreferenceContext(admin, idea.user_id, idea.id, idea.target_platform)
    : null;
  const learningEvidence = ["tiktok", "youtube_shorts"].includes(idea.target_platform)
    ? await feedbackEvidenceContext(admin, idea.user_id, idea)
    : null;

  await admin.from("video_ideas")
    .update({
      status: решение.status,
      route: решение.route ?? null,
      decided_at: new Date().toISOString(),
    })
    .eq("id", idea.id);

  if (action === "self") {
    await admin.from("profiles").update({ active_video_idea_id: idea.id }).eq("id", profile.id);
  }

  if (chatId && messageId) {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: ideaCard(idea, решение.итог),
      parse_mode: "HTML",
    });
  }
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: решение.итог });

  // Промт по идее пишет бригада на компьютере, а не бот. Раньше он собирал
  // его сам через Gemini: получалось длинно, резалось на две склейки, и мимо
  // критика — то есть мимо правил речи из JOURNAL.md. Теперь бот только
  // записывает выбранную идею заданием.
  if (action === "self") {
    // Обычная вставка, без prompt_task_kind: колонки для неё в облаке нет
    // (миграция от 31.08 не накатана), а upsert по несуществующей колонке
    // рушит запись задания целиком — заказчица жмёт кнопку, а промт не пишет
    // никто. Дубль тут не страшнее потерянной идеи.
    const { error: сбой } = await admin.from("claude_tasks").insert({
      user_id: idea.user_id,
      idea_id: idea.id,
      // Первым — короткий заголовок. В приложении и на телефоне видно только
      // начало строки: заказчица должна с одного взгляда понять, о каком
      // ролике речь, а не читать служебное «написать промт ролика по идее».
      text: `${idea.animal} — ${idea.hook}. ` +
        `Реплика: «${idea.line}». Slug: ${idea.slug}. ` +
        `Людей в кадре НЕТ — ни рук, ни спин, ни прохожих: Gemini отказывает ` +
        `«затрагивает лица третьих сторон» и ролик не снимается. Только звери ` +
        `и предметы. ` +
        `${trustedTaskContext(idea, ownerPreference, learningEvidence)} ` +
        `Порядок обязателен: scenarist → director → cinematographer → critic, ` +
        `перед этим JOURNAL.md и PROCESS.md. Промт прислать одним блоком и ` +
        `записать в video_ideas.prompt.`,
    });
    // Отказ базы нельзя выдавать за успех: 7 августа идея пропала молча, а
    // Татьяне ушло «Идею принял». Она ждала промт, которого никто не писал.
    if (сбой) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `Идею записать НЕ УДАЛОСЬ: ${сбой.message}\n\n` +
          `Нажмите кнопку ещё раз. Если повторится — это поломка, а не ваша ` +
          `ошибка, напишите мне.`,
      });
      return json(200, { ok: true });
    }
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
      if (["tiktok", "youtube_shorts"].includes(idea.target_platform)) {
        const { error: provenanceError } = await admin.rpc("persist_tiktok_prompt_provenance_v2", {
          p_mode: "OWNER_SELECTED_EXISTING",
          p_video_idea_id: idea.id,
          p_claude_task_id: null,
          p_prompt: idea.prompt,
          p_prompt_hash: await sha256Hex(idea.prompt),
        });
        if (provenanceError) {
          await tg("sendMessage", {
            chat_id: chatId,
            text: "Генерацию не запускаю: provenance промта не сохранился. Попробуйте ещё раз.",
          });
          return json(200, { ok: true });
        }
      }
      await запустить("veo-start");
    } else {
      const { error: taskError } = await admin.from("claude_tasks").upsert({
        user_id: idea.user_id,
        idea_id: idea.id,
        prompt_task_kind: "SELECTED_PROMPT",
        text: `Написать промт для ПЛАТНОЙ генерации. Герой: ${idea.animal}. ` +
          `Хук: ${idea.hook}. Реплика: «${idea.line}». Slug: ${idea.slug}. ` +
          `${trustedTaskContext(idea, ownerPreference, learningEvidence)} ` +
          `Порядок: scenarist → director → cinematographer → critic, перед этим ` +
          `JOURNAL.md и PROCESS.md. Промт записать в video_ideas.prompt и ` +
          `прислать Татьяне смету — без её подтверждения генерацию не запускать.`,
      }, { onConflict: "user_id,idea_id,prompt_task_kind", ignoreDuplicates: true });
      if (taskError) throw taskError;
      await tg("sendMessage", {
        chat_id: chatId,
        text: `<b>${idea.hook}</b>\n\nПромт для платной генерации напишет бригада. ` +
          `Пришлю его вместе со сметой — генерация запустится только после ` +
          `вашего подтверждения.`,
        parse_mode: "HTML",
      });
    }
  }
  if (action === "redo") await позвать(1, cq.id);

  return json(200, { ok: true });
});
