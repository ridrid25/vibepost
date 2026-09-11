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
  fetchYoutubeTrendCandidates,
  formatTrendContext,
  normalizeTargetPlatform,
  platformLabel,
  trustedIdeaMetadata,
} from "../_shared/youtube-trend.mjs";
import { buildYoutubeIdeaBrain } from "../_shared/youtube-idea-brain.mjs";
import {
  compactYoutubeHistory,
  validateYoutubeNovelIdeas,
} from "../_shared/youtube-idea-novelty.mjs";
import { callerIsServiceRole } from "../_shared/tiktok.ts";
import {
  buildTikTokFeedbackContext,
  feedbackBatchKey,
  formatTikTokFeedbackPromptContext,
  validateTikTokCandidates,
} from "../_shared/tiktok-feedback-context.mjs";
import {
  buildTikTokMarketIdeaContext,
  formatTikTokMarketIdeaPromptContext,
  validateTikTokMarketCandidates,
} from "../_shared/tiktok-market-idea.mjs";
import { resolveStoredLessonDecision } from "../_shared/lesson-effective-weight.mjs";
import {
  annotateYoutubeCandidates,
  buildYoutubeFeedbackContext,
  youtubeFeedbackBatchKey,
} from "../_shared/youtube-own-learning.mjs";

const REGION = "us-central1";
const MODEL = "gemini-2.5-flash";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    return [value.code, value.message, value.details, value.hint]
      .filter((item) => typeof item === "string" && item)
      .join(": ").slice(0, 300) || "unknown structured error";
  }
  return String(error).slice(0, 300);
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
вертикаль 9:16, ровно 10 секунд, интервью со зверем — микрофон у мордочки,
деадпан-взгляд прямо в камеру, ироничный чёрный юмор про деньги, панч в конце.
Место действия любое и лучше неожиданное: среда обитания зверя (пустыня, дно,
лес, нора) или, наоборот, совсем не подходящая ему обстановка. Улица — лишь
один из вариантов, не норма.
Аудитория — русскоязычные взрослые, которых волнуют инфляция, зарплата, кредиты,
налоги, ипотека, накопления, подписки, маркетплейсы, отпуск, пенсия.
Правила реплики и хука (заказчица, 07.09): реплика — утверждение и удар,
два коротких предложения, взрослый сухой юмор. Запрещены слова-страховки
«кажется», «похоже», «вроде», «где-то» и схема «первые два… третий…» —
она уже штамповалась пять раз подряд. Хук в кадре — не обязательно вопрос:
оба лучших ролика канала были утверждениями («НА ДНЕ УЮТНЕЕ, ЧЕМ В ДОЛГАХ»,
«ИНФЛЯЦИЯ ИЛИ СОСЕДИ»); формулы «…РЕАЛЕН?», «…ВОЗМОЖЕН?», «…УДАЧЕН?» запрещены.
ПЕРВАЯ СЕКУНДА (11.09): на крючок есть одна секунда, а не три. На нулевом кадре
зверь уже в действии и уже крупно — входа в кадр, разбега и проездов до героя
нет. В идее сразу указывай, ЧТО зритель видит на первом кадре: странность,
которую хочется досмотреть. «Зверь стоит и начинает говорить» — не годится.`;

const TIKTOK_SCHEMA = {
  type: "OBJECT",
  properties: {
    ideas: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          slug: { type: "STRING", description: "короткое имя латиницей через дефис, напр. bobr-ipoteka" },
          animal: { type: "STRING", description: "зверь по-русски, одно слово" },
          hook: { type: "STRING", description: "хук КАПСОМ по-русски, до 40 символов: утверждение, выбор «А ИЛИ Б» или вопрос; НЕ формула «…РЕАЛЕН?/ВОЗМОЖЕН?/УДАЧЕН?»" },
          line: { type: "STRING", description: "реплика зверя по-русски: утверждение и удар, без «кажется/похоже/вроде/где-то» и без схемы «первые два… третий». СТРОГО 20-25 слогов — это всё, что влезает в ролик на 10 секунд, остальное время нужно действию. Считай гласные. Длиннее — ролик придётся резать, и заказчица потеряет свои слова" },
          prompt: { type: "STRING", description: "промпт для видеомодели по-английски в стиле серии" },
          why_this_idea: { type: "STRING", description: "кратко: какое evidence использовано и чем идея не повторяет недавние" },
        },
        required: ["slug", "animal", "hook", "line", "prompt", "why_this_idea"],
      },
    },
  },
  required: ["ideas"],
};

const TIKTOK_MARKET_SCHEMA = {
  ...TIKTOK_SCHEMA,
  properties: {
    ideas: {
      ...TIKTOK_SCHEMA.properties.ideas,
      items: {
        ...TIKTOK_SCHEMA.properties.ideas.items,
        properties: {
          ...TIKTOK_SCHEMA.properties.ideas.items.properties,
          market_mechanic_key: { type: "STRING", enum: ["M1", "M2", "M3", "M4", "M5", "NONE"] },
          novelty_status: { type: "STRING", enum: ["NEW_CONCEPT", "CONTROLLED_MUTATION", "MARKET_INSPIRED_TEST"] },
        },
        required: [...TIKTOK_SCHEMA.properties.ideas.items.required, "market_mechanic_key", "novelty_status"],
      },
    },
  },
};

const YOUTUBE_IDEA_SCHEMA = {
  type: "OBJECT",
  properties: {
    ideas: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          reference_id: { type: "STRING" },
          causal_pattern_class: { type: "STRING" },
          slug: { type: "STRING", description: "unique lowercase latin slug with hyphens" },
          animal: { type: "STRING", description: "one original animal or character type in Russian" },
          hook: { type: "STRING", description: "clear Russian uppercase question, ideally under 40 characters" },
          line: { type: "STRING", description: "short original Russian deadpan line: a statement plus a punch, never hedged with кажется/похоже/вроде, never the 'first two fine, third fails' template" },
          prompt: { type: "STRING", description: "concise English visual scenario preserving the required causal beats" },
        },
        required: [
          "reference_id", "causal_pattern_class", "slug", "animal", "hook", "line", "prompt",
        ],
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
  const source = targetPlatform === TARGET_PLATFORMS.YOUTUBE_SHORTS && idea.why_this_idea
    ? `\nвзято: ${html(idea.why_this_idea)}` : "";
  return `🎬 <b>${html(idea.hook)}</b>\n\n${html(idea.line)}\n\n<i>${html(idea.animal)}</i>` +
    `\n\nЦелевая площадка: ${platform}${trend}${source}`;
}

async function configuredOwner(admin: SupabaseClient): Promise<string | null> {
  const { data, error } = await admin.rpc("get_secret", {
    p_name: "vibepost_content_brigade_owner",
  });
  return !error && typeof data === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data)
    ? data : null;
}

async function loadPlatformIdeaHistory(
  admin: SupabaseClient,
  userId: string,
  targetPlatform: string,
) {
  const pageSize = 500;
  const rows: Array<Record<string, any>> = [];
  for (let from = 0;; from += pageSize) {
    const { data, error } = await admin
      .from("video_ideas")
      .select("slug,animal,hook,line,prompt,reference_source_id,target_platform,created_at")
      .eq("user_id", userId)
      .eq("target_platform", targetPlatform)
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) return rows;
  }
}

async function generateYoutubeNovelIdeas(
  admin: SupabaseClient,
  experimentSet: Array<Record<string, any>>,
  history: Array<Record<string, any>>,
  brainGuidance: Record<string, unknown>,
  requiredHero: string | null,
) {
  const { token: gToken, project } = await googleToken(admin);
  const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${REGION}/publishers/google/models/${MODEL}:generateContent`;
  const forbidden = compactYoutubeHistory(history);
  const referenceContract = experimentSet.map((candidate) => ({
    reference_id: candidate.idea_contract_id ?? candidate.reference_source_id,
    causal_pattern_class: candidate.reference_driven === false
      ? "CONTROL"
      : candidate.causal_pattern?.pattern_class,
    source_kind: candidate.source_kind,
    source_label: candidate.source_label,
  }));
  const trendContext = experimentSet.map(formatTrendContext).join("\n\n---\n\n");
  let lastValidationError = "not_started";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${gToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text: `${СТИЛЬ}\n\n` +
              `Create exactly ${experimentSet.length} NEW YouTube Shorts ideas, one for each ` +
              `idea contract below. This is attempt ${attempt} of 2.\n\n` +
              `TRUSTED IDEA CONTRACTS (return these IDs and causal_pattern_class values verbatim):\n` +
              `${JSON.stringify(referenceContract)}\n\n${trendContext}\n\n` +
              `FACTORY BRAIN INPUT (facts stay facts; do not invent missing values):\n` +
              `${JSON.stringify(brainGuidance)}\n\n` +
              `STRICT NOVELTY CONTRACT:\n` +
              `- Every reference-driven adaptation MUST change character, physical prop, location, ` +
              `money topic, dialogue, visual image and concrete plot.\n` +
              `- It MUST preserve the trusted causal beat order, viewer prediction, violation class, ` +
              `escalation mechanism and payoff class.\n` +
              `- Do not merely swap the animal in an old story. Do not reuse or lightly paraphrase ` +
              `any forbidden idea below.\n` +
              `- At most ONE reference-driven idea per batch; the rest are CONTROL. The reference ` +
              `gives only the skeleton of the joke — never its wording.
` +
              `- CONTROL stays the current Street Economy house format and must not acquire a ` +
              `reference-derived causal mechanism.\n` +
              `- Use each CONTROL slot's factual source as its topic or tested production lesson. ` +
              `Do not turn timing/hashtag observations into fictional YouTube algorithm rules.\n` +
              (requiredHero
                ? `- LEADING HERO IS LOCKED: animal must be exactly "${requiredHero}" in ALL ideas. ` +
                  `Only topic, place and prop may vary.\n`
                : "") +
              `- Each concept must be physically readable in about 10 seconds, vertical 9:16, ` +
              `with one main character, one main prop/mechanism, an immediate visual hook, minimal ` +
              `scene changes and short Russian dialogue.\n` +
              `- prompt must be concise English; hook and line must be original Russian.\n\n` +
              `ALREADY DELIVERED — FORBIDDEN TO REPEAT OR PARAPHRASE:\n` +
              `${JSON.stringify(forbidden)}\n\n` +
              (attempt > 1
                ? `The previous answer was rejected by deterministic validation: ${lastValidationError}. ` +
                  `Replace the colliding/invalid concept completely.\n`
                : ""),
          }],
        }],
        generationConfig: {
          temperature: 1.2,
          responseMimeType: "application/json",
          responseSchema: YOUTUBE_IDEA_SCHEMA,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 300));
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const generated = JSON.parse(text).ideas ?? [];
    try {
      return validateYoutubeNovelIdeas(generated, experimentSet, history, {
        requiredHero,
      });
    } catch (error) {
      lastValidationError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`no_novel_youtube_ideas:${lastValidationError}`);
}

async function loadTikTokFeedbackInputs(admin: SupabaseClient, userId: string) {
  const pageSize = 500;
  const collectPages = async (
    fetchPage: (from: number, to: number) => Promise<{ data: Array<Record<string, any>> | null; error: any }>,
  ) => {
    const rows: Array<Record<string, any>> = [];
    for (let from = 0;; from += pageSize) {
      const { data, error } = await fetchPage(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...(data ?? []));
      if ((data ?? []).length < pageSize) return rows;
    }
  };
  const inChunks = async (
    ids: string[],
    fetchChunk: (ids: string[], from: number, to: number) =>
      Promise<{ data: Array<Record<string, any>> | null; error: any }>,
  ) => {
    const rows: Array<Record<string, any>> = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      rows.push(...await collectPages((from, to) => fetchChunk(chunk, from, to)));
    }
    return rows;
  };
  const positiveLessons = await collectPages(async (from, to) => await admin
    .from("content_lessons").select("*").eq("user_id", userId)
    .in("category", ["CONFIRMED_LESSON", "WINNING_PATTERN"])
    .in("status", ["SUPPORTED", "CONFIRMED"]).range(from, to));
  const avoidedLessons = await collectPages(async (from, to) => await admin
    .from("content_lessons").select("*").eq("user_id", userId)
    .eq("category", "FAILED_PATTERN").eq("status", "REJECTED").range(from, to));
  const lessons = [...positiveLessons, ...avoidedLessons];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const experiments = await collectPages(async (from, to) => await admin
    .from("experiments").select("*").eq("user_id", userId)
    .order("created_at").order("id").range(from, to));
  const experimentIds = experiments.map((row) => row.id);
  const analyses = await inChunks(experimentIds, async (ids, from, to) => await admin
    .from("content_analysis_results").select("*").eq("user_id", userId)
    .in("experiment_id", ids).order("created_at", { ascending: false }).range(from, to));
  const mutations = await collectPages(async (from, to) => await admin
    .from("creative_mutations")
    .select("id,parent_creative_id,child_creative_id,changed_variable,mutation_kind,source_hypothesis_id,prior_evidence_experiment_id")
    .eq("user_id", userId).order("created_at").order("id").range(from, to));
  const hypotheses = await collectPages(async (from, to) => await admin
    .from("content_hypotheses").select("*").eq("user_id", userId)
    .eq("status", "REJECTED").order("updated_at", { ascending: false }).range(from, to));
  const { data: framework, error: frameworkError } = await admin
    .from("prompt_framework_versions").select("*,prompt_framework_rules(*)")
    .eq("user_id", userId).eq("is_current", true).maybeSingle();
  if (frameworkError) throw frameworkError;
  const ideaFields = "id,target_platform,status,route,decided_at,created_at,animal,hook,changed_variable,idea_pattern,feedback_batch_key";
  const { data: approvedIdeas, error: approvedError } = await admin.from("video_ideas")
    .select(ideaFields).eq("user_id", userId).eq("target_platform", "tiktok")
    .not("decided_at", "is", null).in("route", ["self", "paid"])
    .in("status", ["approved", "generating", "done"])
    .order("decided_at", { ascending: false }).order("id").limit(10);
  const { data: rejectedIdeas, error: rejectedError } = await admin.from("video_ideas")
    .select(ideaFields).eq("user_id", userId).eq("target_platform", "tiktok")
    .not("decided_at", "is", null).is("route", null).eq("status", "rejected")
    .order("decided_at", { ascending: false }).order("id").limit(10);
  if (approvedError || rejectedError) throw approvedError ?? rejectedError;
  const recentIdeas = await collectPages(async (from, to) => await admin.from("video_ideas")
    .select(ideaFields).eq("user_id", userId).eq("target_platform", "tiktok")
    .or("decided_at.not.is.null,feedback_batch_key.not.is.null")
    .order("created_at", { ascending: false }).range(from, to));
  const ideasById = new Map([...(approvedIdeas ?? []), ...(rejectedIdeas ?? []), ...recentIdeas]
    .map((row) => [row.id, row]));
  const evidenceVideoIds = [...new Set(lessons.flatMap((lesson) =>
    (Array.isArray(lesson.videos_used) ? lesson.videos_used : []))
    .filter((id) => typeof id === "string" && uuid.test(id)))];
  const snapshots = await inChunks(evidenceVideoIds, async (ids, from, to) => await admin
    .from("video_metric_snapshots").select("*").eq("user_id", userId)
    .in("video_id", ids).order("collected_at", { ascending: false }).range(from, to));
  const studio = await inChunks(evidenceVideoIds, async (ids, from, to) => await admin
    .from("studio_metrics").select("*").eq("user_id", userId)
    .in("video_id", ids).range(from, to));
  return {
    lessons, experiments, analyses, mutations, hypotheses, framework: framework ?? null,
    ideas: [...ideasById.values()], snapshots, studio_metrics: studio,
  };
}

async function loadTikTokMarketInputs(admin: SupabaseClient, userId: string) {
  // Deliberately do not select canonical_url, external_reference_id, creator
  // identity, FACT captions, source_locator or media. Only accepted structural
  // HUMAN_REVIEW DNA may cross the idea-generation boundary.
  const selectReferences = "id,owner_disposition,updated_at";
  const collectPages = async (fetchPage: (from: number, to: number) => Promise<any>) => {
    const rows: Array<Record<string, any>> = [];
    for (let from = 0;; from += 500) {
      const { data, error } = await fetchPage(from, from + 499);
      if (error) throw error;
      rows.push(...(data ?? []));
      if ((data ?? []).length < 500) return rows;
    }
  };
  const [positive, avoidance] = await Promise.all([
    collectPages((from, to) => admin.from("market_references").select(selectReferences)
      .eq("user_id", userId).eq("platform", "tiktok")
      .eq("status", "RESOLVED")
      .in("owner_disposition", ["TAKE", "INTERESTING_MECHANIC"])
      .order("updated_at", { ascending: false }).order("id").range(from, to)),
    collectPages((from, to) => admin.from("market_references").select(selectReferences)
      .eq("user_id", userId).eq("platform", "tiktok")
      .eq("status", "RESOLVED")
      .eq("owner_disposition", "NOT_MY_STYLE")
      .order("updated_at", { ascending: false }).order("id").range(from, to)),
  ]);
  const references = [...positive, ...avoidance];
  const referenceIds = references.map((row) => row.id);
  if (!referenceIds.length) return { references: [], evidence: [] };
  const evidence: Array<Record<string, any>> = [];
  for (let offset = 0; offset < referenceIds.length; offset += 100) {
    const chunk = referenceIds.slice(offset, offset + 100);
    evidence.push(...await collectPages((from, to) => admin.from("market_reference_evidence")
      .select("id,market_reference_id,evidence_kind,analysis_identity,evidence_version,created_at,confidence,payload")
      .eq("user_id", userId).eq("evidence_kind", "DNA_INFERENCE")
      .in("market_reference_id", chunk)
      .order("evidence_version", { ascending: false }).order("created_at", { ascending: false }).order("id")
      .range(from, to)));
  }
  return { references, evidence };
}

async function loadYoutubeFeedbackInputs(admin: SupabaseClient, userId: string) {
  const pageSize = 500;
  const collectPages = async (fetchPage: (from: number, to: number) => Promise<any>) => {
    const rows: Array<Record<string, any>> = [];
    for (let from = 0;; from += pageSize) {
      const { data, error } = await fetchPage(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...(data ?? []));
      if ((data ?? []).length < pageSize) return rows;
    }
  };
  const inChunks = async (ids: string[], fetchChunk: (chunk: string[], from: number, to: number) => Promise<any>) => {
    const rows: Array<Record<string, any>> = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      rows.push(...await collectPages((from, to) => fetchChunk(chunk, from, to)));
    }
    return rows;
  };
  const lessons = await collectPages((from, to) => admin.from("content_lessons").select("*")
    .eq("user_id", userId).eq("source_platform", "youtube_shorts").range(from, to));
  const bindings = await collectPages((from, to) => admin.from("content_lesson_youtube_publications")
    .select("*").eq("user_id", userId).range(from, to));
  const experiments = await collectPages((from, to) => admin.from("experiments")
    .select("*").eq("user_id", userId).order("created_at").order("id").range(from, to));
  const experimentIds = experiments.map((row) => row.id);
  const analyses = await inChunks(experimentIds, (chunk, from, to) => admin
    .from("content_analysis_results").select("*").eq("user_id", userId)
    .in("experiment_id", chunk)
    .order("created_at", { ascending: false }).range(from, to));
  const publicationIds = [...new Set(experiments.filter((row) => row.platform === "youtube_shorts").flatMap((row) =>
    [row.control_youtube_short_id, row.variant_youtube_short_id]).filter(Boolean))];
  const publications = await inChunks(publicationIds, (chunk, from, to) => admin
    .from("published_shorts").select("*").eq("user_id", userId).in("id", chunk).range(from, to));
  const snapshots = await inChunks(publicationIds, (chunk, from, to) => admin
    .from("published_shorts_stats").select("*").eq("user_id", userId)
    .in("short_id", chunk).order("polled_at", { ascending: false }).range(from, to));
  const mappings = await inChunks(publicationIds, (chunk, from, to) => admin
    .from("creative_identity_map").select("id,creative_id,video_idea_id,youtube_short_row_id")
    .eq("user_id", userId).eq("platform", "youtube_shorts")
    .in("youtube_short_row_id", chunk).range(from, to));
  let mutations: Array<Record<string, any>> = [];
  try {
    mutations = await collectPages((from, to) => admin.from("creative_mutations")
      .select("id,parent_creative_id,child_creative_id,changed_variable,mutation_kind,source_hypothesis_id,prior_evidence_experiment_id")
      .eq("user_id", userId).order("created_at").order("id").range(from, to));
  } catch (error) {
    // Creative mutation lineage is an optional later layer. Its absence must
    // not disable the daily analytics -> YouTube idea path.
    if (!(error && typeof error === "object" &&
        (error as Record<string, unknown>).code === "PGRST205")) throw error;
  }
  const [framework, approved, rejected, hypotheses] = await Promise.all([
    admin.from("prompt_framework_versions").select("*,prompt_framework_rules(*)")
      .eq("user_id", userId).eq("is_current", true).maybeSingle(),
    admin.from("video_ideas").select("id,target_platform,status,route,decided_at")
      .eq("user_id", userId).eq("target_platform", "youtube_shorts")
      .not("decided_at", "is", null).in("route", ["self", "paid"])
      .in("status", ["approved", "generating", "done"])
      .order("decided_at", { ascending: false }).order("id").limit(10),
    admin.from("video_ideas").select("id,target_platform,status,route,decided_at")
      .eq("user_id", userId).eq("target_platform", "youtube_shorts")
      .not("decided_at", "is", null).is("route", null).eq("status", "rejected")
      .order("decided_at", { ascending: false }).order("id").limit(10),
    admin.from("content_hypotheses").select("id,status,changed_variable,constants,feedback_context,updated_at")
      .eq("user_id", userId).eq("status", "REJECTED")
      .order("updated_at", { ascending: false }).order("id").limit(20),
  ]);
  for (const result of [framework, approved, rejected, hypotheses]) if (result.error) throw result.error;
  return {
    lessons, experiments, analyses, mutations, lesson_bindings: bindings,
    publications, snapshots, mappings, hypotheses: hypotheses.data ?? [],
    framework: framework.data ?? null,
    owner_ideas: [...(approved.data ?? []), ...(rejected.data ?? [])],
  };
}

async function loadYoutubeBrainInputs(admin: SupabaseClient, userId: string) {
  const [positive, avoided, analytics, tags] = await Promise.all([
    admin.from("content_lessons")
      .select("id,lesson,category,status,confidence,applicable_topics,source_platform,source,updated_at")
      .eq("user_id", userId)
      .in("category", ["WINNING_PATTERN", "CONFIRMED_LESSON"])
      .in("status", ["SUPPORTED", "CONFIRMED"])
      .order("updated_at", { ascending: false }).limit(30),
    admin.from("content_lessons")
      .select("id,lesson,category,status,confidence,applicable_topics,source_platform,source,updated_at")
      .eq("user_id", userId)
      .eq("category", "FAILED_PATTERN").eq("status", "REJECTED")
      .order("updated_at", { ascending: false }).limit(30),
    admin.from("analitika_dnya")
      .select("id,za_den,otchet,metrics,evidence,created_at")
      .eq("user_id", userId)
      .order("za_den", { ascending: false })
      .order("created_at", { ascending: false }).limit(3),
    admin.from("tiktok_tegi")
      .select("teg,rolikov,na_rolik,prosmotrov,sobrano_at")
      .order("sobrano_at", { ascending: false }).limit(100),
  ]);
  for (const result of [positive, avoided, analytics, tags]) {
    if (result.error) throw result.error;
  }
  const sortedTags = [...(tags.data ?? [])].sort((left, right) =>
    Number(right.na_rolik ?? -1) - Number(left.na_rolik ?? -1));
  return {
    positive_lessons: positive.data ?? [],
    avoided_lessons: avoided.data ?? [],
    analytics: analytics.data ?? [],
    tags: sortedTags,
  };
}

async function syncYoutubeMarketReferences(
  admin: SupabaseClient,
  userId: string,
  candidates: Array<Record<string, any>>,
) {
  const { data: existing, error: existingError } = await admin.from("market_references")
    .select("id,payload").eq("user_id", userId).eq("platform", "youtube_shorts");
  if (existingError) throw existingError;
  const byReference = new Map((existing ?? []).map((row) => [row.payload?.reference_id, row]));
  for (const candidate of candidates) {
    const payload = {
      source_type: "FIXED_V0_1_REFERENCE_LIBRARY",
      reference_id: candidate.reference_source_id,
      FACT: {
        url: candidate.reference_source_url,
        title: candidate.reference_title,
        published_at: candidate.reference_published_at,
        views: candidate.reference_views,
        vph: candidate.reference_vph,
        snapshot_at: candidate.reference_snapshot_at,
      },
      INFERENCE: {
        causal_pattern: candidate.causal_pattern,
        payoff_class: candidate.payoff_class,
        fidelity_constraints: candidate.critical_fidelity_constraints,
      },
      UNKNOWN: candidate.unknown_fields ?? [],
    };
    const current = byReference.get(candidate.reference_source_id);
    const query = current
      ? admin.from("market_references").update({
        status: "RESOLVED", owner_disposition: "INTERESTING_MECHANIC", payload,
        updated_at: new Date().toISOString(),
      }).eq("id", current.id).eq("user_id", userId)
      : admin.from("market_references").insert({
        user_id: userId, platform: "youtube_shorts", status: "RESOLVED",
        owner_disposition: "INTERESTING_MECHANIC", payload,
      });
    const { error } = await query;
    if (error) throw error;
  }
}

async function loadStoredDecision(admin: SupabaseClient, userId: string, platform: string, batchKey: string) {
  const batchField = platform === TARGET_PLATFORMS.TIKTOK
    ? "feedback_batch_key" : "youtube_feedback_batch_key";
  const { data: ideas, error: ideasError } = await admin.from("video_ideas")
    .select("id,target_platform,hypothesis_id,evidence_mode,feedback_batch_key,youtube_feedback_batch_key,feedback_context_hash,youtube_feedback_context_hash,selected_lesson_ids,avoided_lesson_ids")
    .eq("user_id", userId).eq(batchField, batchKey).order("id");
  if (ideasError) throw ideasError;
  if (!ideas?.length) return null;
  const hypothesisIds = [...new Set(ideas.map((row) => row.hypothesis_id).filter(Boolean))];
  let hypotheses: Array<Record<string, any>> = [];
  if (hypothesisIds.length) {
    const { data, error } = await admin.from("content_hypotheses")
      .select("id,feedback_context").eq("user_id", userId).in("id", hypothesisIds);
    if (error) throw error;
    hypotheses = data ?? [];
  }
  return {
    ideas,
    snapshot: resolveStoredLessonDecision({ ideas, hypotheses, platform, batch_key: batchKey }),
  };
}

async function handleSuggestIdeas(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!(await callerIsServiceRole(req, serviceKey))) {
    return json(403, { error: "forbidden" });
  }
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    serviceKey,
  );

  // Мозг проверяем ДО того, как придумывать: если вчерашнего разбора нет,
  // идеи пойдут вслепую — ровно то, из-за чего месяц выходило однообразие.
  // Требование заказчицы 10.09.2026: каждый день перед роликами проверять,
  // сделана ли аналитика, и звать её, если нет.
  try {
    const порог = new Date(Date.now() - 30 * 3600_000).toISOString();
    const { count: разборов } = await admin.from("analitika_dnya")
      .select("id", { count: "exact", head: true }).gte("created_at", порог);
    const { count: уроков } = await admin.from("content_lessons")
      .select("id", { count: "exact", head: true }).eq("source", "аналитика дня");
    if (!разборов || !уроков) {
      const brainOwnerId = await configuredOwner(admin);
      const { data: кому } = await admin.from("profiles")
        .select("error_notify_tg_id").eq("id", brainOwnerId ?? "00000000-0000-0000-0000-000000000000")
        .maybeSingle();
      const токен = Deno.env.get("TELEGRAM_TEST_BOT_TOKEN");
      if (кому?.error_notify_tg_id && токен) {
        await fetch(`https://api.telegram.org/bot${токен}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: кому.error_notify_tg_id,
            text: "Мозг завода молчит: " +
              (!разборов ? "разбора за вчера нет" : "выводов в памяти нет") +
              ". Идеи на сегодня придуманы вслепую — скажите мне, я разберусь.",
          }),
        }).catch(() => {});
      }
      console.error("brain check failed", { разборов, уроков });
    }
  } catch (e) {
    console.error("brain check error", { message: String(e).slice(0, 200) });
  }

  const body = await req.json().catch(() => ({}));
  const count = Math.min(Math.max(Number(body.count) || 5, 1), 5);
  const previewOnly = body.preview_only === true;
  if (body.request_id !== undefined &&
      (typeof body.request_id !== "string" ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(body.request_id))) {
    return json(400, { error: "invalid_request_id" });
  }
  if (body.topic !== undefined &&
      (typeof body.topic !== "string" || !body.topic.trim() || body.topic.length > 100)) {
    return json(400, { error: "invalid_topic" });
  }
  const requestId = typeof body.request_id === "string"
    ? body.request_id
    : `scheduled:${new Date().toISOString().slice(0, 10)}`;
  // POST-04: learning memory and idea generation must resolve the same configured owner.
  const ownerId = await configuredOwner(admin);
  if (!ownerId) return json(500, { error: "owner_not_configured" });
  const { data: profile } = await admin
    .from("profiles")
    .select("id, error_notify_tg_id, error_notify_bot_id, target_platform, vedushchiy_geroy")
    .eq("id", ownerId)
    .maybeSingle();
  if (!profile?.error_notify_tg_id || !profile.error_notify_bot_id) {
    return json(400, { error: "В настройках не указан Telegram ID и бот-отправитель" });
  }

  const targetPlatform = normalizeTargetPlatform(profile.target_platform);
  // The repository also contains a newer learning layer whose migrations may
  // be deployed later. Keep this function compatible with the current
  // production schema instead of making YouTube novelty depend on that layer.
  const { error: feedbackSchemaError } = await admin
    .from("video_ideas")
    .select("feedback_batch_key,youtube_feedback_batch_key")
    .limit(1);
  const feedbackSchemaReady = !feedbackSchemaError;
  // Deploying the shared provenance columns must not silently switch TikTok
  // to the experimental feedback generator. Its existing production branch
  // stays byte-for-byte active unless a separate rollout explicitly enables it.
  const tiktokFeedbackEnabled = false;
  let feedbackContext: Awaited<ReturnType<typeof buildTikTokFeedbackContext>> | null = null;
  let marketIdeaContext: Awaited<ReturnType<typeof buildTikTokMarketIdeaContext>> | null = null;
  let batchKey: string | null = null;
  let youtubeFeedbackContext: Awaited<ReturnType<typeof buildYoutubeFeedbackContext>> | null = null;
  let youtubeBatchKeyValue: string | null = null;
  if (feedbackSchemaReady && tiktokFeedbackEnabled && targetPlatform === TARGET_PLATFORMS.TIKTOK) {
    batchKey = await feedbackBatchKey(profile.id, requestId);
    if (!previewOnly) {
      const replay = await loadStoredDecision(admin, profile.id, targetPlatform, batchKey);
      if (replay) return json(200, {
        ok: true, replayed: true, created: 0, existing: replay.ideas.length,
        feedback_outcome: "REPLAY", stored_decision: replay.snapshot,
      });
    }
  } else if (feedbackSchemaReady && targetPlatform === TARGET_PLATFORMS.YOUTUBE_SHORTS) {
    youtubeBatchKeyValue = await youtubeFeedbackBatchKey(profile.id, requestId);
    if (!previewOnly) {
      const replay = await loadStoredDecision(admin, profile.id, targetPlatform, youtubeBatchKeyValue);
      if (replay) return json(200, {
        ok: true, replayed: true, created: 0, existing: replay.ideas.length,
        feedback_outcome: "REPLAY", stored_decision: replay.snapshot,
      });
    }
  }
  const evaluationAt = new Date().toISOString();
  if (feedbackSchemaReady && tiktokFeedbackEnabled && targetPlatform === TARGET_PLATFORMS.TIKTOK) {
    const feedbackInputs = await loadTikTokFeedbackInputs(admin, profile.id);
    feedbackContext = await buildTikTokFeedbackContext({
      ...feedbackInputs,
      topic: typeof body.topic === "string" ? body.topic.trim() : null,
      evaluation_at: evaluationAt,
    });
    const marketInputs = await loadTikTokMarketInputs(admin, profile.id);
    marketIdeaContext = await buildTikTokMarketIdeaContext(feedbackContext, marketInputs);
  }

  const { data: bot } = await admin
    .from("bots").select("token_secret_id").eq("id", profile.error_notify_bot_id).maybeSingle();
  const { data: token } = await admin
    .rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });
  if (!token) return json(400, { error: "Не удалось получить токен бота" });

  // The full persisted history is the source of truth for no-repeat checks.
  let былые: Array<Record<string, any>> = [];
  try {
    былые = await loadPlatformIdeaHistory(admin, profile.id, targetPlatform);
  } catch {
    return json(500, { error: "Не удалось проверить историю уже показанных идей" });
  }
  const занятые = [...new Set((былые ?? []).map((r) => r.animal).filter(Boolean))];
  const youtubeHistory = targetPlatform === TARGET_PLATFORMS.YOUTUBE_SHORTS ? (былые ?? []) : [];

  let ideas: Array<Record<string, any>> = [];
  let experimentSet: Array<Record<string, unknown>> = [];
  let youtubeBrainGuidance: Record<string, unknown> = {};
  let ideaSource = "existing-gemini";
  let youtubeInputPhase = "not_started";
  try {
    if (targetPlatform === TARGET_PLATFORMS.YOUTUBE_SHORTS) {
      youtubeInputPhase = "youtube_reference_metadata";
      const candidates = await fetchYoutubeTrendCandidates({
        apiKey: Deno.env.get("YOUTUBE_API_KEY"),
      });
      if (!previewOnly) {
        youtubeInputPhase = "market_reference_sync";
        await syncYoutubeMarketReferences(admin, profile.id, candidates);
      }
      youtubeInputPhase = "factory_brain_inputs";
      const brainInputs = await loadYoutubeBrainInputs(admin, profile.id);
      const brain = buildYoutubeIdeaBrain({
        references: candidates,
        history: youtubeHistory,
        ...brainInputs,
        count,
        hero: profile.vedushchiy_geroy,
      });
      experimentSet = brain.contracts;
      youtubeBrainGuidance = brain.guidance;
      if (feedbackSchemaReady) {
        youtubeInputPhase = "youtube_feedback_inputs";
        const youtubeInputs = await loadYoutubeFeedbackInputs(admin, profile.id);
        youtubeInputPhase = "youtube_feedback_context";
        youtubeFeedbackContext = await buildYoutubeFeedbackContext({
          ...youtubeInputs, market_references: experimentSet, evaluation_at: evaluationAt,
        });
      }
    }
  } catch (e) {
    return json(500, { error: `Trend input недоступен (${youtubeInputPhase}): ${safeError(e)}` });
  }

  if (targetPlatform === TARGET_PLATFORMS.YOUTUBE_SHORTS) {
    try {
      ideas = await generateYoutubeNovelIdeas(
        admin,
        experimentSet,
        youtubeHistory,
        youtubeBrainGuidance,
        typeof profile.vedushchiy_geroy === "string" ? profile.vedushchiy_geroy.trim() : null,
      );
    } catch (e) {
      // Never fall back to the already delivered fixed five. An explicit error
      // is safer than silently sending the same cards for the sixteenth time.
      return json(409, {
        error: `Новые YouTube-идеи не созданы; повторы не отправлены: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
    if (youtubeFeedbackContext) ideas = await annotateYoutubeCandidates(ideas, youtubeFeedbackContext);
    ideaSource = "novel-reference-adaptation-v0.1";
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
                `без морали и без объяснений шутки.\n\n` +
                (feedbackContext ? formatTikTokFeedbackPromptContext(feedbackContext) : "") +
                (marketIdeaContext?.active ? `\n${formatTikTokMarketIdeaPromptContext(marketIdeaContext)}` : ""),
            }],
          }],
          generationConfig: {
            temperature: 1.1,
            responseMimeType: "application/json",
            responseSchema: marketIdeaContext?.active ? TIKTOK_MARKET_SCHEMA : TIKTOK_SCHEMA,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 300));
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      ideas = JSON.parse(text).ideas ?? [];
      if (marketIdeaContext?.active) {
        ideas = validateTikTokMarketCandidates(ideas, marketIdeaContext);
      } else if (feedbackContext) ideas = validateTikTokCandidates(ideas, feedbackContext);
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
      ...(targetPlatform === TARGET_PLATFORMS.TIKTOK && feedbackSchemaReady && tiktokFeedbackEnabled
        ? {
          why_this_idea: idea.why_this_idea ?? null,
          idea_pattern: idea.idea_pattern ?? null,
          ...(marketIdeaContext?.active ? {
            market_mechanic_key: idea.market_mechanic_key,
            novelty_status: idea.novelty_status,
            market_reference_ids: idea.market_reference_ids,
            market_dna_ids: idea.market_dna_ids,
            own_lesson_ids: idea.own_lesson_ids,
            avoided_lesson_ids: idea.avoided_lesson_ids,
            own_experiment_ids: idea.own_experiment_ids,
            owner_preference_ids: idea.owner_preference_ids,
            evidence_roots: idea.evidence_roots,
            evidence_conflicts: idea.evidence_conflicts,
            idea_confidence: idea.idea_confidence,
            evidence_mode: idea.evidence_mode,
            market_context_hash: idea.market_context_hash,
          } : {}),
        }
        : {}),
      ...(targetPlatform === TARGET_PLATFORMS.YOUTUBE_SHORTS
        ? {
          ...trustedIdeaMetadata(candidate),
          ...(feedbackSchemaReady ? {
            market_reference_ids: idea.market_reference_ids ?? [idea.source_key ?? idea.reference_id],
            selected_lesson_ids: idea.selected_lesson_ids ?? [],
            avoided_lesson_ids: idea.avoided_lesson_ids ?? [],
            own_experiment_ids: idea.own_experiment_ids ?? [],
            changed_variable: idea.evidence_mode === "OWN_PERFORMANCE_BOUND"
              ? idea.changed_variable ?? null : null,
            experiment_constants: idea.evidence_mode === "OWN_PERFORMANCE_BOUND"
              ? idea.experiment_constants ?? null : null,
            why_this_idea: idea.source_label ?? idea.why_this_idea ?? null,
            idea_pattern: `${idea.reference_id ?? "CONTROL"}|${idea.slug}`,
            evidence_roots: idea.evidence_roots ?? [],
            evidence_conflicts: idea.evidence_conflicts ?? [],
            idea_confidence: idea.idea_confidence ?? "LOW",
            evidence_mode: idea.evidence_mode ?? "MARKET_REFERENCE_ONLY",
          } : {}),
        }
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
        animal: row.animal,
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
        ...(targetPlatform === TARGET_PLATFORMS.TIKTOK ? {
          why_this_idea: row.why_this_idea ?? null,
          feedback_outcome: feedbackContext?.outcome ?? null,
          hypothesis_key: feedbackContext?.hypothesis_key ?? null,
          market_mechanic_key: row.market_mechanic_key ?? null,
          novelty_status: row.novelty_status ?? null,
        } : {}),
        card_text: cardText(row, targetPlatform),
      })),
    });
  }

  let saved: Array<Record<string, any>> = [];
  if (targetPlatform === TARGET_PLATFORMS.TIKTOK && marketIdeaContext?.active &&
      marketIdeaContext.hypothesis_candidate && marketIdeaContext.hypothesis_key && batchKey && feedbackContext) {
    const selectedLessons = feedbackContext.OWN_PERFORMANCE.selected_lessons.map((lesson) => lesson.lesson_id);
    const avoidedLessons = feedbackContext.OWN_PERFORMANCE.avoided_lessons.map((lesson) => lesson.lesson_id);
    const stableFeedbackContext = {
      integration_version: marketIdeaContext.integration_version,
      platform: "tiktok",
      OWN_PERFORMANCE: {
        source_type: "OWN_PERFORMANCE",
        lesson_effective_policy_version: feedbackContext.OWN_PERFORMANCE.lesson_effective_policy_version,
        evaluation_at: feedbackContext.OWN_PERFORMANCE.evaluation_at,
        lesson_effective_states: feedbackContext.OWN_PERFORMANCE.lesson_effective_states,
        controlled_retests: feedbackContext.OWN_PERFORMANCE.controlled_retests,
        selected_lessons: feedbackContext.OWN_PERFORMANCE.selected_lessons,
        avoided_lessons: feedbackContext.OWN_PERFORMANCE.avoided_lessons,
        primary: feedbackContext.OWN_PERFORMANCE.primary,
        prompt_framework: feedbackContext.OWN_PERFORMANCE.prompt_framework,
      },
      OWNER_PREFERENCE: marketIdeaContext.OWNER_PREFERENCE,
      MARKET_REFERENCE: marketIdeaContext.MARKET_REFERENCE,
      conflicts: marketIdeaContext.conflicts.map(({ field: _field, market_key: _key, ...conflict }) => conflict),
    };
    const { data, error } = await admin.rpc("persist_tiktok_market_feedback_batch", {
      p_user_id: profile.id,
      p_batch_key: batchKey,
      p_context_hash: marketIdeaContext.context_hash,
      p_hypothesis_key: marketIdeaContext.hypothesis_key,
      p_hypothesis: { ...marketIdeaContext.hypothesis_candidate, feedback_context: stableFeedbackContext },
      p_selected_lesson_ids: selectedLessons,
      p_avoided_lesson_ids: avoidedLessons,
      p_api_metric_snapshot_ids: feedbackContext.OWN_PERFORMANCE.metric_provenance.api_snapshot_ids,
      p_studio_metric_ids: feedbackContext.OWN_PERFORMANCE.metric_provenance.studio_metric_ids,
      p_prompt_framework_id: feedbackContext.OWN_PERFORMANCE.prompt_framework!.id,
      p_prompt_framework_version: feedbackContext.OWN_PERFORMANCE.prompt_framework!.version_label,
      p_market_context: stableFeedbackContext,
      p_candidates: rows.map((row) => ({
        slug: row.slug, animal: row.animal, hook: row.hook, line: row.line,
        prompt: row.prompt, why_this_idea: row.why_this_idea, idea_pattern: row.idea_pattern,
        market_mechanic_key: row.market_mechanic_key, novelty_status: row.novelty_status,
        market_reference_ids: row.market_reference_ids, market_dna_ids: row.market_dna_ids,
        own_lesson_ids: row.own_lesson_ids, avoided_lesson_ids: row.avoided_lesson_ids,
        own_experiment_ids: row.own_experiment_ids, owner_preference_ids: row.owner_preference_ids,
        evidence_roots: row.evidence_roots, evidence_conflicts: row.evidence_conflicts,
        idea_confidence: row.idea_confidence, evidence_mode: row.evidence_mode,
        market_context_hash: row.market_context_hash,
      })),
    });
    if (error) throw error;
    saved = Array.isArray(data) ? data : [];
  } else if (targetPlatform === TARGET_PLATFORMS.TIKTOK &&
      feedbackContext?.outcome === "HYPOTHESIS" && feedbackContext.hypothesis_candidate &&
      feedbackContext.hypothesis_key && batchKey) {
    const selectedLessons = feedbackContext.OWN_PERFORMANCE.selected_lessons
      .map((lesson) => lesson.lesson_id);
    const avoidedLessons = feedbackContext.OWN_PERFORMANCE.avoided_lessons
      .map((lesson) => lesson.lesson_id);
    const stableFeedbackContext = {
      context_version: feedbackContext.context_version,
      platform: feedbackContext.platform,
      OWN_PERFORMANCE: {
        source_type: "OWN_PERFORMANCE",
        lesson_effective_policy_version: feedbackContext.OWN_PERFORMANCE.lesson_effective_policy_version,
        evaluation_at: feedbackContext.OWN_PERFORMANCE.evaluation_at,
        lesson_effective_states: feedbackContext.OWN_PERFORMANCE.lesson_effective_states,
        controlled_retests: feedbackContext.OWN_PERFORMANCE.controlled_retests,
        selected_lessons: feedbackContext.OWN_PERFORMANCE.selected_lessons,
        avoided_lessons: feedbackContext.OWN_PERFORMANCE.avoided_lessons,
        primary: feedbackContext.OWN_PERFORMANCE.primary,
        prompt_framework: feedbackContext.OWN_PERFORMANCE.prompt_framework,
      },
    };
    const { data, error } = await admin.rpc("persist_tiktok_feedback_batch", {
      p_user_id: profile.id,
      p_batch_key: batchKey,
      p_context_hash: feedbackContext.context_hash,
      p_hypothesis_key: feedbackContext.hypothesis_key,
      p_hypothesis_statement: feedbackContext.hypothesis_candidate.statement,
      p_changed_variable: feedbackContext.hypothesis_candidate.changed_variable,
      p_expected_effect: feedbackContext.hypothesis_candidate.expected_effect,
      p_rationale: feedbackContext.hypothesis_candidate.rationale,
      p_hypothesis_evidence: feedbackContext.hypothesis_candidate.evidence,
      p_constants: feedbackContext.hypothesis_candidate.constants,
      p_feedback_context: stableFeedbackContext,
      p_selected_lesson_ids: selectedLessons,
      p_avoided_lesson_ids: avoidedLessons,
      p_api_metric_snapshot_ids: feedbackContext.OWN_PERFORMANCE.metric_provenance.api_snapshot_ids,
      p_studio_metric_ids: feedbackContext.OWN_PERFORMANCE.metric_provenance.studio_metric_ids,
      p_prompt_framework_id: feedbackContext.OWN_PERFORMANCE.prompt_framework.id,
      p_prompt_framework_version: feedbackContext.OWN_PERFORMANCE.prompt_framework.version_label,
      p_candidates: rows.map((row) => ({
        slug: row.slug, animal: row.animal, hook: row.hook, line: row.line,
        prompt: row.prompt, why_this_idea: row.why_this_idea,
        idea_pattern: row.idea_pattern,
      })),
    });
    if (error) throw error;
    saved = Array.isArray(data) ? data : [];
  } else if (targetPlatform === TARGET_PLATFORMS.YOUTUBE_SHORTS && youtubeFeedbackContext &&
      youtubeBatchKeyValue) {
    const ownBound = rows.some((row) => row.evidence_mode === "OWN_PERFORMANCE_BOUND") &&
      youtubeFeedbackContext.hypothesis_candidate;
    const { data, error } = await admin.rpc("persist_youtube_feedback_batch", {
      p_user_id: profile.id,
      p_batch_key: youtubeBatchKeyValue,
      p_context_hash: youtubeFeedbackContext.context_hash,
      p_hypothesis_key: ownBound ? youtubeFeedbackContext.hypothesis_key : null,
      p_hypothesis: ownBound ? {
        ...youtubeFeedbackContext.hypothesis_candidate,
        rationale: "Existing YouTube own-performance evidence selected deterministically.",
        feedback_context: {
          context_version: youtubeFeedbackContext.context_version,
          platform: youtubeFeedbackContext.platform,
          OWN_PERFORMANCE: youtubeFeedbackContext.OWN_PERFORMANCE,
          MARKET_REFERENCE: youtubeFeedbackContext.MARKET_REFERENCE,
        },
      } : null,
      p_selected_lesson_ids: youtubeFeedbackContext.OWN_PERFORMANCE.selected_lessons
        .map((row) => row.lesson_id),
      p_avoided_lesson_ids: youtubeFeedbackContext.OWN_PERFORMANCE.avoided_lessons
        .map((row) => row.lesson_id),
      p_prompt_framework_id: youtubeFeedbackContext.OWN_PERFORMANCE.prompt_framework?.id,
      p_prompt_framework_version: youtubeFeedbackContext.OWN_PERFORMANCE.prompt_framework?.version_label,
      p_candidates: rows,
    });
    if (error) throw error;
    saved = Array.isArray(data) ? data : [];
  } else {
    const { data, error } = await admin.from("video_ideas").insert(rows)
      .select("id, animal, hook, line, target_platform, trend_signal");
    if (error) throw error;
    saved = data ?? [];
  }

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

  return json(200, {
    ok: true,
    создано: saved.length,
    feedback_outcome: feedbackContext?.outcome ?? null,
  });
}

Deno.serve(async (req) => {
  try {
    return await handleSuggestIdeas(req);
  } catch (error) {
    const detail = safeError(error) || "unknown_error";
    console.error("suggest-ideas unhandled", { detail });
    return json(500, { error: `suggest-ideas failed: ${detail}` });
  }
});
