/**
 * Bounded YouTube Shorts idea input builder.
 *
 * This module does not generate copy and does not publish anything. It turns
 * already persisted factory facts into five deterministic idea contracts:
 * no more than one external reference and the remaining slots from the daily
 * analytics, supported lessons and observed topic-demand counters.
 */

const MAX_TEXT = 2_400;

function clean(value, max = MAX_TEXT) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalized(value) {
  return clean(value, 200).normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

function sourceKey(kind, raw, index) {
  const safe = clean(raw, 48).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  return `${kind}:${safe || index + 1}`.slice(0, 64);
}

function lessonLabel(lesson) {
  const text = clean(lesson?.lesson, 90);
  return text ? `урок «${text}»` : "урок из памяти фабрики";
}

function analyticsTopicSources(rows = []) {
  const result = [];
  const seen = new Set();
  for (const row of rows) {
    const report = String(row?.otchet ?? "");
    for (const line of report.split(/\r?\n/)) {
      if (/не брать|отложить|перегрет|тонет/i.test(line)) continue;
      const match = line.match(/(?:Тема|Свободная ниша)\s*[«"]([^»"]+)[»"]/i);
      if (!match) continue;
      const topic = clean(match[1], 60);
      const key = normalized(topic);
      if (!topic || seen.has(key)) continue;
      seen.add(key);
      result.push({
        kind: "ANALYTICS",
        key: sourceKey("ANALYTICS", row?.id, result.length),
        label: /^\s*[—-]?\s*Свободная ниша/i.test(line)
          ? `свободная ниша «${topic}»`
          : `свежая сводка «${topic}»`,
        context: {
          fact_kind: "fresh_daily_analytics",
          report_date: row?.za_den ?? null,
          observed_line: clean(line, 500),
          topic,
        },
      });
    }
  }
  return result;
}

function lessonSources(rows = []) {
  return rows.map((row, index) => ({
    kind: "LESSON",
    key: sourceKey("LESSON", row?.id, index),
    label: lessonLabel(row),
    context: {
      fact_kind: "supported_factory_lesson",
      lesson_id: row?.id ?? null,
      lesson: clean(row?.lesson, 700),
      category: row?.category ?? null,
      status: row?.status ?? null,
      confidence: row?.confidence ?? null,
      source_platform: row?.source_platform ?? null,
    },
  }));
}

function tagSources(rows = []) {
  const generic = new Set([
    "юмор", "мемы", "приколы", "сатира", "ирония", "сарказм", "абсурд",
    "мультфильм", "короткометражка", "нейросеть", "вмиреживотных",
  ]);
  return rows.filter((row) => !generic.has(normalized(row?.teg))).map((row, index) => ({
    kind: "TAG_DEMAND",
    key: sourceKey("TAG", row?.teg, index),
    label: `спрос по теме «${clean(row?.teg, 60)}»`,
    context: {
      fact_kind: "topic_demand_counter",
      topic: clean(row?.teg, 60),
      videos_observed: row?.rolikov ?? null,
      views_observed: row?.prosmotrov ?? null,
      views_per_video: row?.na_rolik ?? null,
      observed_at: row?.sobrano_at ?? null,
      limitation: "TikTok tag counter is a topic-demand signal, not proof of YouTube ranking behavior",
    },
  }));
}

function dedupeSources(sources) {
  const result = [];
  const seen = new Set();
  for (const source of sources) {
    const topic = source?.context?.topic ?? source?.label;
    const key = normalized(topic);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}

function chooseReference(references, history) {
  if (!references.length) return null;
  const counts = new Map();
  for (const row of history ?? []) {
    const id = row?.reference_source_id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...references].sort((a, b) => {
    const countDelta = (counts.get(a.reference_source_id) ?? 0) -
      (counts.get(b.reference_source_id) ?? 0);
    if (countDelta) return countDelta;
    return Number(b.reference_vph ?? -1) - Number(a.reference_vph ?? -1);
  })[0];
}

export function buildYoutubeIdeaBrain({
  references = [], history = [], positive_lessons = [], avoided_lessons = [],
  analytics = [], tags = [], count = 5, hero = null,
} = {}) {
  const safeCount = Math.min(Math.max(Number(count) || 5, 1), 5);
  const chosenReference = chooseReference(references, history);
  const sourcePool = dedupeSources([
    ...analyticsTopicSources(analytics),
    ...lessonSources(positive_lessons),
    ...tagSources(tags),
  ]);
  const fallback = {
    kind: "CURRENT_FORMAT",
    key: "CURRENT_FORMAT:street-economy",
    label: "текущий формат Street Economy",
    context: {
      fact_kind: "current_production_control",
      instruction: "Choose a new money topic not present in the forbidden history",
    },
  };
  const contracts = [];
  if (chosenReference) {
    contracts.push({
      ...chosenReference,
      idea_contract_id: chosenReference.reference_source_id,
      source_kind: "REFERENCE",
      source_key: `REFERENCE:${chosenReference.reference_source_id}`,
      source_label: `чужой эталон ${chosenReference.reference_source_id}`,
      source_context: { fact_kind: "fixed_reference", reference_id: chosenReference.reference_source_id },
      reference_driven: true,
    });
  }
  while (contracts.length < safeCount) {
    const controlIndex = contracts.length + 1;
    const source = sourcePool[(controlIndex - (chosenReference ? 2 : 1)) % Math.max(sourcePool.length, 1)] ?? fallback;
    contracts.push({
      reference_source_id: `CONTROL_${controlIndex}`,
      idea_contract_id: `CONTROL_${controlIndex}`,
      source_kind: source.kind,
      source_key: source.key,
      source_label: source.label,
      source_context: source.context,
      reference_driven: false,
    });
  }
  return {
    contracts,
    hero: clean(hero, 80) || null,
    guidance: {
      positive_lessons: positive_lessons.map((row) => ({
        id: row?.id ?? null, lesson: clean(row?.lesson, 700), category: row?.category,
        status: row?.status, confidence: row?.confidence,
      })),
      avoided_lessons: avoided_lessons.map((row) => ({
        id: row?.id ?? null, lesson: clean(row?.lesson, 700), category: row?.category,
        status: row?.status, confidence: row?.confidence,
      })),
      fresh_analytics: analytics.slice(0, 3).map((row) => ({
        id: row?.id ?? null, report_date: row?.za_den ?? null, report: clean(row?.otchet),
        metrics: row?.metrics ?? null,
      })),
      topic_demand: tags.slice(0, 30).map((row) => ({
        topic: clean(row?.teg, 60), videos: row?.rolikov ?? null,
        views: row?.prosmotrov ?? null, views_per_video: row?.na_rolik ?? null,
        observed_at: row?.sobrano_at ?? null,
      })),
    },
  };
}

export function youtubeReferenceCount(contracts = []) {
  return contracts.filter((contract) => contract?.reference_driven === true).length;
}
