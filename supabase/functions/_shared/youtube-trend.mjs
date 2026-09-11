/**
 * Bounded YouTube Trend & Reference Intelligence V0.1 bridge.
 *
 * The reference set is the four real references already accepted by the
 * V0.1 Controller. YouTube Data API supplies only live FACT metadata. The
 * causal patterns below are labelled INFERENCE because they came from the
 * reviewed Reference DNA, not from YouTube metadata. Channel baseline and
 * outlier stay UNKNOWN: V0.1 has no defensible baseline collector.
 */

export const UNKNOWN = "UNKNOWN";

export const TARGET_PLATFORMS = Object.freeze({
  TIKTOK: "tiktok",
  YOUTUBE_SHORTS: "youtube_shorts",
});

export const YOUTUBE_REFERENCE_LIBRARY = Object.freeze([
  Object.freeze({
    reference_id: "7Uv_WahFvPQ",
    reference_url: "https://www.youtube.com/shorts/7Uv_WahFvPQ",
    causal_pattern: Object.freeze({
      pattern_class: "SAME_PROP_SUDDEN_PHYSICAL_DESTRUCTION",
      setup_rule: "one physical prop is introduced and remains causally continuous",
      repeat_or_confirmation: "the same prop is handled or protected repeatedly without damage",
      viewer_prediction: "the same prop will remain safe",
      violation: "that same prop is suddenly physically destroyed",
      violation_class: "SUDDEN_DESTRUCTION_OF_ESTABLISHED_SAFE_PROP",
      escalation_mechanism: "repeated successful protection strengthens the safety prediction",
      payoff: "visible destruction of the same established prop",
      payoff_class: "SUDDEN_PHYSICAL_DESTRUCTION",
    }),
    payoff_class: "SUDDEN_PHYSICAL_DESTRUCTION",
    critical_fidelity_constraints: Object.freeze([
      "use one causally continuous prop",
      "confirm the prop remains safe before the violation",
      "destroy that same prop suddenly and visibly",
    ]),
  }),
  Object.freeze({
    reference_id: "DbAgRpwBuiE",
    reference_url: "https://www.youtube.com/shorts/DbAgRpwBuiE",
    causal_pattern: Object.freeze({
      pattern_class: "DEADPAN_RESPONSE_TO_OPPOSITE_PROPERTY",
      setup_rule: "two objects are visually equivalent",
      repeat_or_confirmation: "the first object confirms the expected physical property",
      viewer_prediction: "the second equivalent object has the same property",
      violation: "the second object has the opposite physical property under the same test",
      violation_class: "OPPOSITE_PROPERTY_IN_EQUIVALENT_OBJECT",
      escalation_mechanism: "the repeated test makes the contradiction unambiguous",
      payoff: "one isolated deadpan reaction to the opposite property",
      payoff_class: "DEADPAN_OPPOSITE_PROPERTY_RESPONSE",
    }),
    payoff_class: "DEADPAN_OPPOSITE_PROPERTY_RESPONSE",
    critical_fidelity_constraints: Object.freeze([
      "show two visually equivalent objects",
      "test the first object before the second with the same action",
      "give the second the opposite physical property",
      "finish with a deadpan response",
    ]),
  }),
  Object.freeze({
    reference_id: "ODGYa08RyNo",
    reference_url: "https://www.youtube.com/shorts/ODGYa08RyNo",
    causal_pattern: Object.freeze({
      pattern_class: "VARIATION_BECOMES_ESCALATION_AND_PAYOFF",
      setup_rule: "the same readable action is repeated several times",
      repeat_or_confirmation: "early repetitions teach one stable pattern",
      viewer_prediction: "the next repetition will resolve in the same way",
      violation: "one repetition contains one meaningful visible variation",
      violation_class: "SINGLE_VARIATION_INSIDE_LEARNED_REPETITION",
      escalation_mechanism: "the variation directly expands the repeated action",
      payoff: "the variation itself becomes the escalation and payoff",
      payoff_class: "VARIATION_CAUSES_ESCALATING_PAYOFF",
    }),
    payoff_class: "VARIATION_CAUSES_ESCALATING_PAYOFF",
    critical_fidelity_constraints: Object.freeze([
      "repeat the same action enough to teach the pattern",
      "change exactly one meaningful element in a later repetition",
      "make that variation directly cause the escalation and payoff",
    ]),
  }),
  Object.freeze({
    reference_id: "thBbEHIR_4c",
    reference_url: "https://www.youtube.com/shorts/thBbEHIR_4c",
    causal_pattern: Object.freeze({
      pattern_class: "CHARACTER_SEARCHES_AND_RESPONDS_TO_EXTERNAL_EFFECT",
      setup_rule: "one ordinary object promises an impossible property",
      repeat_or_confirmation: "the character activates or opens that same object",
      viewer_prediction: "the ordinary object will behave ordinarily or fail",
      violation: "an impossible external effect begins outside the object",
      violation_class: "IMPOSSIBLE_EXTERNAL_EFFECT_FROM_ORDINARY_OBJECT",
      escalation_mechanism: "the external effect moves or expands beyond its source",
      payoff: "the character searches for and physically responds to the external effect",
      payoff_class: "SEARCH_AND_RESPONSE_TO_EXTERNAL_EFFECT",
    }),
    payoff_class: "SEARCH_AND_RESPONSE_TO_EXTERNAL_EFFECT",
    critical_fidelity_constraints: Object.freeze([
      "introduce one ordinary object with an impossible promise",
      "activate or open that same object before the effect",
      "start one clearly external impossible effect",
      "make the character search for and respond to that effect",
    ]),
  }),
]);

// Controller-approved V0.1 concepts from
// VIDEO FACTORY/docs/trend-addon/05-first-market-test-ready.md. They are a
// deterministic continuity path when the existing text model is temporarily
// quota-exhausted. Live YouTube FACT metadata is still required and is joined
// separately; this is not a replacement crawler, model or trend source.
const YOUTUBE_APPROVED_CONCEPTS = Object.freeze({
  "7Uv_WahFvPQ": Object.freeze({
    slug: "v01-kupon-zashchita",
    animal: "бобр",
    hook: "КУПОН УЖЕ СПАСЁН?",
    line: "Скидка под защитой. Защита оказалась одноразовой.",
    prompt: "One coupon is secured repeatedly, teaching that the same prop is safe; an oversized checkout stamp suddenly destroys that exact coupon; the beaver sorts the scraps without changing expression.",
  }),
  "DbAgRpwBuiE": Object.freeze({
    slug: "v01-monety-svoystvo",
    animal: "фламинго",
    hook: "МОНЕТЫ ТОЧНО ОДИНАКОВЫЕ?",
    line: "Монеты одинаковые. Характер у второй мягче.",
    prompt: "Two visually identical fare tokens receive the same drop test: the first behaves as rigid metal, the second flattens like rubber; the flamingo records the contradiction without surprise.",
  }),
  "ODGYa08RyNo": Object.freeze({
    slug: "v01-yashchiki-lenta",
    animal: "вомбат",
    hook: "ТРЕТИЙ ЯЩИК ТОЖЕ ЗАКРОЕТСЯ?",
    line: "Расходы держу под контролем. Контроль затянулся лентой.",
    prompt: "The same belly-bump closes two identical kiosk drawers; the third repetition contains one visible packing-ribbon variation, and that variation directly ties the kiosk, parcel and wombat into one bow.",
  }),
  "thBbEHIR_4c": Object.freeze({
    slug: "v01-kalkulyator-zvon",
    animal: "крот",
    hook: "КАЛЬКУЛЯТОР НАШЁЛ ДОХОД?",
    line: "Калькулятор обещал найти доходность. Осталось найти, откуда звенит.",
    prompt: "An ordinary calculator promises an impossible return; pressing equals starts a cash-register ding moving outside it between market stalls, and the mole searches for and responds to the travelling effect.",
  }),
  CONTROL: Object.freeze({
    slug: "v01-control-lenivets",
    animal: "ленивец",
    hook: "ЦЕНЫ ОБОГНАЛИ ЛЕНИВЦА?",
    line: "Цены растут быстрее меня. Впервые завидую инфляции.",
    prompt: "Current Street Economy control: a sloth answers an offscreen money interview while a mechanical price indicator rises behind him; no reference-derived causal mechanism.",
  }),
});

export function buildYoutubeApprovedFallback(experimentSet) {
  return experimentSet.map((candidate) => {
    const referenceId = String(candidate?.reference_source_id ?? "");
    const concept = YOUTUBE_APPROVED_CONCEPTS[referenceId];
    if (!concept) throw new Error(`No Controller-approved V0.1 concept for ${referenceId}`);
    return { ...concept, reference_id: referenceId };
  });
}

export function normalizeTargetPlatform(value) {
  return value === TARGET_PLATFORMS.YOUTUBE_SHORTS
    ? TARGET_PLATFORMS.YOUTUBE_SHORTS
    : TARGET_PLATFORMS.TIKTOK;
}

export function platformLabel(value) {
  return normalizeTargetPlatform(value) === TARGET_PLATFORMS.YOUTUBE_SHORTS
    ? "YouTube Shorts"
    : "TikTok";
}

function parseIsoDuration(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function nonNegativeNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function rounded(value, places = 2) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function youtubeFacts(item, reference, observedAt = new Date()) {
  const publishedAt = item?.snippet?.publishedAt ?? null;
  const publishedMs = publishedAt ? new Date(publishedAt).getTime() : NaN;
  const observedMs = new Date(observedAt).getTime();
  const ageHours = Number.isFinite(publishedMs) && Number.isFinite(observedMs) && publishedMs <= observedMs
    ? rounded((observedMs - publishedMs) / 3_600_000)
    : null;
  const views = nonNegativeNumber(item?.statistics?.viewCount);
  const likes = nonNegativeNumber(item?.statistics?.likeCount);
  const comments = nonNegativeNumber(item?.statistics?.commentCount);
  const vph = views !== null && ageHours !== null && ageHours > 0
    ? rounded(views / ageHours)
    : null;
  const engagement = views && likes !== null && comments !== null
    ? rounded((likes + comments) / views, 4)
    : null;

  return {
    reference_source_id: reference.reference_id,
    reference_source_url: reference.reference_url,
    reference_title: item?.snippet?.title ?? UNKNOWN,
    reference_channel: item?.snippet?.channelTitle ?? UNKNOWN,
    reference_published_at: publishedAt,
    reference_views: views,
    reference_likes: likes,
    reference_comments: comments,
    reference_vph: vph,
    reference_engagement: engagement,
    reference_duration_seconds: parseIsoDuration(item?.contentDetails?.duration),
    reference_snapshot_at: new Date(observedAt).toISOString(),
    reference_channel_baseline_views: null,
    reference_outlier_ratio: null,
    causal_pattern: reference.causal_pattern,
    payoff_class: reference.payoff_class,
    critical_fidelity_constraints: [...reference.critical_fidelity_constraints],
    fact_fields: [
      "reference_source_id",
      "reference_source_url",
      "reference_title",
      "reference_channel",
      "reference_published_at",
      "reference_views",
      "reference_likes",
      "reference_comments",
      "reference_vph",
      "reference_engagement",
      "reference_duration_seconds",
      "reference_snapshot_at",
    ],
    inference_fields: ["causal_pattern", "payoff_class", "critical_fidelity_constraints"],
    unknown_fields: ["reference_channel_baseline_views", "reference_outlier_ratio"],
  };
}

export function rankYoutubeCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const aAge = a.reference_published_at
      ? (Date.now() - new Date(a.reference_published_at).getTime()) / 3_600_000
      : Number.POSITIVE_INFINITY;
    const bAge = b.reference_published_at
      ? (Date.now() - new Date(b.reference_published_at).getTime()) / 3_600_000
      : Number.POSITIVE_INFINITY;
    const aRecent = aAge <= 168 ? 1 : 0;
    const bRecent = bAge <= 168 ? 1 : 0;
    if (aRecent !== bRecent) return bRecent - aRecent;
    return (b.reference_vph ?? -1) - (a.reference_vph ?? -1);
  });
}

/**
 * @param {{apiKey?: string, fetchImpl?: typeof globalThis.fetch, now?: Date}} options
 */
export async function fetchYoutubeTrendCandidates(options = {}) {
  const { apiKey, fetchImpl = globalThis.fetch, now = new Date() } = options;
  if (!apiKey) {
    const error = new Error("YOUTUBE_API_KEY is not configured for suggest-ideas");
    error.code = "YOUTUBE_CREDENTIAL_REQUIRED";
    throw error;
  }
  const endpoint = new URL("https://www.googleapis.com/youtube/v3/videos");
  endpoint.searchParams.set("part", "snippet,contentDetails,statistics");
  endpoint.searchParams.set("id", YOUTUBE_REFERENCE_LIBRARY.map((reference) => reference.reference_id).join(","));
  endpoint.searchParams.set("key", apiKey);

  const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const error = new Error(`YouTube Data API videos.list failed with HTTP ${response.status}`);
    error.code = "YOUTUBE_API_FAILED";
    throw error;
  }
  const payload = await response.json();
  const byId = new Map((payload.items ?? []).map((item) => [item.id, item]));
  const candidates = YOUTUBE_REFERENCE_LIBRARY
    .map((reference) => {
      const item = byId.get(reference.reference_id);
      return item ? youtubeFacts(item, reference, now) : null;
    })
    .filter(Boolean);
  if (candidates.length < YOUTUBE_REFERENCE_LIBRARY.length) {
    const error = new Error("One or more accepted V0.1 YouTube references are unavailable");
    error.code = "YOUTUBE_REFERENCE_UNAVAILABLE";
    throw error;
  }
  return rankYoutubeCandidates(candidates);
}

export function selectYoutubeExperimentSet(candidates, count = 5) {
  const safeCount = Math.min(Math.max(Number(count) || 5, 1), 5);
  if (safeCount === 5) return [...candidates.slice(0, 4), { reference_source_id: "CONTROL" }];
  return candidates.slice(0, safeCount);
}

export function formatTrendContext(candidate) {
  if (candidate.reference_driven === false ||
      String(candidate.reference_source_id ?? "").startsWith("CONTROL")) {
    return [
      `REFERENCE_ID: ${candidate.idea_contract_id ?? candidate.reference_source_id ?? "CONTROL"}`,
      "FACT: no external reference is used",
      `FACTUAL IDEA SOURCE: ${JSON.stringify(candidate.source_context ?? {})}`,
      `OWNER-VISIBLE SOURCE LABEL: ${candidate.source_label ?? "текущий формат"}`,
      "INFERENCE: none",
      "UNKNOWN: facts not present in the source context remain unknown",
      "CONSTRAINT: preserve the current Street Economy house format without a reference-derived causal mechanism",
    ].join("\n");
  }
  const fact = {
    reference_id: candidate.reference_source_id,
    url: candidate.reference_source_url,
    title: candidate.reference_title,
    published_at: candidate.reference_published_at,
    views: candidate.reference_views,
    vph: candidate.reference_vph,
    likes: candidate.reference_likes,
    comments: candidate.reference_comments,
    engagement: candidate.reference_engagement,
    duration_seconds: candidate.reference_duration_seconds,
    snapshot_at: candidate.reference_snapshot_at,
  };
  const inference = {
    causal_pattern: candidate.causal_pattern,
    payoff_class: candidate.payoff_class,
    critical_fidelity_constraints: candidate.critical_fidelity_constraints,
  };
  return [
    `REFERENCE_ID: ${candidate.reference_source_id}`,
    `FACT: ${JSON.stringify(fact)}`,
    `INFERENCE (Controller-validated Reference DNA): ${JSON.stringify(inference)}`,
    "UNKNOWN: channel baseline views; outlier ratio",
    "DO NOT COPY: source character, dialogue, plot, shots, branding, visual identity, or creator identity",
  ].join("\n");
}

export function trustedIdeaMetadata(candidate) {
  if (!candidate || candidate.reference_driven === false ||
      String(candidate.reference_source_id ?? "").startsWith("CONTROL")) {
    return {
      trend_signal: null,
      reference_source_id: null,
      reference_source_url: null,
      reference_title: null,
      reference_published_at: null,
      reference_views: null,
      reference_vph: null,
      reference_snapshot_at: null,
      reference_channel_baseline_views: null,
      reference_outlier_ratio: null,
      causal_pattern: null,
      payoff_class: null,
      fidelity_constraints: null,
    };
  }
  return {
    trend_signal: "reference-driven",
    reference_source_id: candidate.reference_source_id,
    reference_source_url: candidate.reference_source_url,
    reference_title: candidate.reference_title === UNKNOWN ? null : candidate.reference_title,
    reference_published_at: candidate.reference_published_at,
    reference_views: candidate.reference_views,
    reference_vph: candidate.reference_vph,
    reference_snapshot_at: candidate.reference_snapshot_at,
    reference_channel_baseline_views: candidate.reference_channel_baseline_views,
    reference_outlier_ratio: candidate.reference_outlier_ratio,
    causal_pattern: candidate.causal_pattern,
    payoff_class: candidate.payoff_class,
    fidelity_constraints: candidate.critical_fidelity_constraints,
  };
}
