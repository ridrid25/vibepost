export const FAST_REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    review: {
      type: "STRING",
      description:
        "приёмка ролика для владелицы по десяти пунктам правил завода, каждый с новой строки, " +
        "по-русски: «да / нет — что видно», последней строкой — что переснять первым",
    },
    ok: {
      type: "BOOLEAN",
      description: "годится ли ролик в канал без переделки",
    },
    speech: {
      type: "STRING",
      description: "реплика героя дословно, как слышно, со знаками препинания",
    },
    tag: {
      type: "STRING",
      description:
        "одно-два слова по-русски: кто в кадре. Например «скорпион», " +
        "«скат», «жираф у ящика». Не предложение, без точки",
    },
    hooks: {
      type: "ARRAY",
      description:
        "ровно пять вариантов ЗАГОЛОВКА в кадр: по-русски, 2-5 слов, " +
        "без точки в конце. Это надпись сверху первые три секунды, она должна " +
        "цеплять и работать вместе с репликой героя, а не пересказывать её. " +
        "Разные по приёму: реплика героя, цифра, вопрос, обещание, угроза. " +
        "Заголовок — КОНФЛИКТ, а не тема: «Начальник съел мою премию», а не " +
        "«Гиена и зарплата». Ситуация зрителя от первого лица, без клички зверя",
      items: { type: "STRING" },
    },
  },
  required: ["review", "ok", "speech", "tag", "hooks"],
};

export const CAUSAL_REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    causal_pattern_preserved: {
      type: "STRING",
      enum: ["YES", "NO", "UNCERTAIN"],
      description:
        "whether the supplied abstract causal pattern is visibly preserved",
    },
  },
  required: ["causal_pattern_preserved"],
};

export function hasCausalPattern(value) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length,
  );
}

export function buildFastReviewPrompt({ targetPlatformLabel, ideaContext }) {
  // 25.10.2026, заказчица: разбор должен идти по правилам завода
  // (Генерация роликов/ПРИНЦИПЫ_ЗАВОДА.md), а не общим впечатлением.
  // Старое описание «интервью со зверем, микрофон у морды» устарело.
  return `Целевая площадка: ${targetPlatformLabel}. Серия коротких сатирических ` +
    `роликов о деньгах для зрителей 25–44 лет: знакомый зверь (кот, собака, ` +
    `хомяк, енот, капибара и т. п.) в бытовой ситуации — касса, работа, банк, ` +
    `коммуналка. Сухой взрослый чёрный юмор, без милоты и широких улыбок. ` +
    `Ролик 10 секунд, вертикальный 9:16.
${ideaContext}

` +
    `Посмотри ролик целиком со звуком и дай честную приёмку по правилам завода. ` +
    `Хвалить не надо. По каждому пункту — «да / нет — что видно»:
` +
    `1) первая секунда: камера уже летит к конфликту или кадр стоит;
` +
    `2) шутка понятна без звука, по одним действиям;
` +
    `3) движения камеры: сколько реально видно, какие; хотя бы одно неожиданное;
` +
    `4) крупные планы: не меньше трёх; герой крупный или мелкий;
` +
    `5) кульминация: видна ли, самый ли это сильный момент;
` +
    `6) крючок в последнюю секунду: есть ли причина посмотреть второй раз — ` +
    `что раскрылось и было ли это видно в первых секундах;
` +
    `7) речь: разборчива ли, говорит ли нужный персонаж, рот не закрыт предметом;
` +
    `8) предметы: не пропадают, не двоятся, в руках у своего владельца;
` +
    `9) свет и цвет: ярко, герой контрастен фону, нет темноты;
` +
    `10) нет крови, брендов, логотипов, надписей; кадр вертикальный.
` +
    `Последней строкой: что переснять в первую очередь.

` +
    `РЕПЛИКА: дословно, как её слышно, со знаками препинания — по ней ` +
    `проверяют, не проглотил ли герой окончание.

` +
    `МЕТКА: одно-два слова, кто в кадре; по ней ролик узнают до названия.

` +
    `ПЯТЬ ЗАГОЛОВКОВ в кадр: надпись сверху первые три секунды, 2-5 слов, ` +
    `по-русски, без точки. Заголовок — конфликт от первого лица, а не тема.`;
}

export function buildCausalReviewPrompt(
  { targetPlatformLabel, causalPattern },
) {
  if (!hasCausalPattern(causalPattern)) {
    throw new TypeError("causal pattern is required");
  }
  return `Площадка: ${targetPlatformLabel}. Проверь только одно: сохраняет ли ` +
    `показанный ролик этот абстрактный причинный паттерн:\n` +
    `${JSON.stringify(causalPattern)}\n\n` +
    `Верни YES, если причинная последовательность и развязка видимо сохранены; ` +
    `NO, если они явно нарушены; UNCERTAIN, если по ролику нельзя надёжно решить. ` +
    `Это advisory signal: не принимай решение за владельца. Не делай полный ` +
    `разбор, не оценивай речь, заголовки или общее качество.`;
}

export function parseCausalReviewPayload(payload) {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  const value = parsed?.causal_pattern_preserved;
  if (
    !CAUSAL_REVIEW_SCHEMA.properties.causal_pattern_preserved.enum.includes(
      value,
    )
  ) {
    throw new TypeError("malformed causal review response");
  }
  return value;
}

export async function executeCausalEnrichment({ analyze, persist, onFailure }) {
  try {
    const value = parseCausalReviewPayload(await analyze());
    const persisted = await persist(value);
    return { outcome: persisted ? "UPDATED" : "STALE", value };
  } catch (error) {
    await onFailure?.(error);
    return { outcome: "FAILED", value: null };
  }
}
