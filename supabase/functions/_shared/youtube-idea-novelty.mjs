/**
 * Deterministic guards for YouTube idea novelty.
 *
 * The text model may propose adaptations, but it may not decide whether an
 * already delivered idea is acceptable. That decision is made here from the
 * persisted video_ideas history before any Telegram card is sent.
 */

export function normalizeIdeaText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedFields(idea) {
  return {
    slug: normalizeIdeaText(idea?.slug),
    hook: normalizeIdeaText(idea?.hook),
    line: normalizeIdeaText(idea?.line),
    prompt: normalizeIdeaText(idea?.prompt),
  };
}

export function youtubeIdeaCollision(candidate, history = []) {
  const current = normalizedFields(candidate);
  if (!current.slug || !current.hook || !current.line) return "missing_identity_field";

  for (const previous of history) {
    const old = normalizedFields(previous);
    if (old.slug && old.slug === current.slug) return "slug";
    if (old.hook && old.hook === current.hook) return "hook";
    if (old.line && old.line === current.line) return "line";
    if (old.prompt && old.prompt === current.prompt) return "prompt";
  }
  return null;
}

export function compactYoutubeHistory(history = [], limit = 120) {
  const unique = [];
  const seen = new Set();
  for (const idea of history) {
    const fields = normalizedFields(idea);
    const key = `${fields.slug}|${fields.hook}|${fields.line}`;
    if (!fields.hook || seen.has(key)) continue;
    seen.add(key);
    unique.push({
      reference_id: idea?.reference_source_id ?? "CONTROL_OR_UNKNOWN",
      slug: idea?.slug ?? "",
      animal: idea?.animal ?? "",
      hook: idea?.hook ?? "",
      line: idea?.line ?? "",
      concept_prompt: String(idea?.prompt ?? "").slice(0, 600),
    });
    if (unique.length >= limit) break;
  }
  return unique;
}

function assertText(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`youtube_idea_invalid_${name}`);
  }
}

/**
 * Validates model output and restores the trusted reference order. Reference
 * metadata and causal_pattern are never accepted from the model.
 */
export function validateYoutubeNovelIdeas(rawIdeas, experimentSet, history = [], options = {}) {
  if (!Array.isArray(rawIdeas) || rawIdeas.length !== experimentSet.length) {
    throw new Error("youtube_idea_count_mismatch");
  }

  const expected = experimentSet.map((item) =>
    String(item?.idea_contract_id ?? item?.reference_source_id ?? ""));
  const byReference = new Map();
  for (const idea of rawIdeas) {
    assertText(idea?.reference_id, "reference_id", 64);
    if (byReference.has(idea.reference_id)) throw new Error("youtube_idea_duplicate_reference");
    byReference.set(idea.reference_id, idea);
  }
  if (byReference.size !== expected.length || expected.some((id) => !byReference.has(id))) {
    throw new Error("youtube_idea_reference_mismatch");
  }

  const accepted = [];
  const compared = [...history];
  for (const referenceId of expected) {
    const idea = byReference.get(referenceId);
    const contract = experimentSet.find((item) =>
      String(item?.idea_contract_id ?? item?.reference_source_id ?? "") === referenceId);
    assertText(idea.slug, "slug", 80);
    assertText(idea.animal, "animal", 80);
    assertText(idea.hook, "hook", 100);
    assertText(idea.line, "line", 400);
    assertText(idea.prompt, "prompt", 4000);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(idea.slug)) {
      throw new Error("youtube_idea_invalid_slug_format");
    }

    const expectedPattern = contract?.reference_driven === false || referenceId.startsWith("CONTROL")
      ? "CONTROL"
      : String(contract?.causal_pattern?.pattern_class ?? "");
    if (idea.causal_pattern_class !== expectedPattern) {
      throw new Error(`youtube_idea_causal_pattern_mismatch:${referenceId}`);
    }
    if (options.requiredHero &&
        normalizeIdeaText(idea.animal) !== normalizeIdeaText(options.requiredHero)) {
      throw new Error(`youtube_idea_leading_hero_mismatch:${referenceId}`);
    }

    const collision = youtubeIdeaCollision(idea, compared);
    if (collision) throw new Error(`youtube_idea_duplicate_${collision}:${referenceId}`);
    const acceptedIdea = {
      ...idea,
      source_kind: contract?.source_kind ?? null,
      source_key: contract?.source_key ?? referenceId,
      source_label: contract?.source_label ?? "текущий формат",
    };
    accepted.push(acceptedIdea);
    compared.push(acceptedIdea);
  }
  return accepted;
}
