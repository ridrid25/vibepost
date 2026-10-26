export const FAST_REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    review: {
      type: "STRING",
      description:
        "разбор ролика для владелицы, 2-4 коротких пункта через перенос строки, " +
        "по-русски: что в кадре, есть ли речь и понятна ли она, что смущает. " +
        "ПОСЛЕДНЕЙ строкой ровно «Смысл: прошёл» или «Смысл: не прошёл — " +
        "<главная причина одной фразой>»",
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
  return `Целевая площадка: ${targetPlatformLabel}. Это ролик о личных финансах. ` +
    `Серия: знакомый зверь в бытовой ситуации про деньги — касса, банк, ` +
    `ипотека, работа; сухой взрослый чёрный юмор, без милоты. Ролик 10–14 ` +
    `секунд, вертикальный: иногда спереди стоят 3–4 секунды неожиданного начала, ` +
    `снятого отдельно, — это не брак, за длину и смену места не ругай.\n${ideaContext}\n\n` +
    `Посмотри ролик и дай короткий честный разбор: что в кадре, звучит ли ` +
    `речь и разборчива ли она, вертикальный ли кадр, попал ли в задумку, ` +
    `что смущает. Хвалить не надо, отмечай только существенное.\n\n` +
    // 26.10.2026, заказчица: «Добавь строку смысл прошёл/не прошёл, и тогда
    // числа не будут в норме». Смысл проверяется здесь, внутри завода, а не
    // отдельным заданием дежурному после замера.
    `СМЫСЛ — последней строкой разбора. «Смысл: прошёл», только если все ` +
    `четыре да: 1) шутка понятна без звука, по одним действиям; 2) первые ` +
    `секунды удивляют сразу, с первого кадра; 3) видна кульминация — самый ` +
    `сильный момент; 4) последний кадр понятен без пояснений и зовёт ` +
    `посмотреть ещё раз. Иначе «Смысл: не прошёл — <главная причина>».\n\n` +
    `РЕПЛИКА: дословно, как её слышно, со знаками препинания — по ней ` +
    `проверяют, не проглотил ли герой окончание.\n\n` +
    `МЕТКА: одно-два слова, кто в кадре; по ней ролик узнают до названия.\n\n` +
    `ПЯТЬ ЗАГОЛОВКОВ в кадр: надпись сверху первые три секунды, 2-5 слов, ` +
    `по-русски, без точки. Они должны цеплять и работать вместе с репликой, ` +
    `а не пересказывать её.`;
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
