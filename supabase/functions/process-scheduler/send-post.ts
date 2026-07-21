// send-post: общий модуль отправки одного сообщения в Telegram.
// Используется планировщиком (Этап 2) и цепочками (Этап 4).
// По format выбирает sendMessage / sendPhoto / sendPoll,
// добавляет инлайн-кнопки, тихую отправку и отключение превью ссылок.

export interface PostContent {
  format: string; // 'text' | 'photo' | 'poll' | 'video'
  text: string | null;
  photo_url: string | null;
  video_url: string | null;
  poll_question: string | null;
  poll_options: unknown; // ["Вариант 1", ...]
  poll_anonymous: boolean;
  inline_buttons: unknown; // [[{ text, url }], ...]
  is_silent: boolean;
  disable_link_preview: boolean;
}

export interface SendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
  retryable?: boolean; // сеть, 5xx или 429 — имеет смысл повторить
  retryAfter?: number; // секунды из ответа Telegram при 429
}

export async function sendPost(
  token: string,
  chatId: string,
  post: PostContent,
): Promise<SendResult> {
  let method: string;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    disable_notification: post.is_silent === true,
  };
  if (Array.isArray(post.inline_buttons) && post.inline_buttons.length > 0) {
    payload.reply_markup = { inline_keyboard: post.inline_buttons };
  }

  switch (post.format) {
    case "text":
      method = "sendMessage";
      payload.text = post.text ?? "";
      payload.link_preview_options = {
        is_disabled: post.disable_link_preview === true,
      };
      break;
    case "photo":
      method = "sendPhoto";
      payload.photo = post.photo_url;
      if (post.text) payload.caption = post.text;
      break;
    case "video":
      method = "sendVideo";
      payload.video = post.video_url;
      if (post.text) payload.caption = post.text;
      payload.supports_streaming = true;
      break;
    case "poll": {
      method = "sendPoll";
      payload.question = post.poll_question ?? "";
      const options = Array.isArray(post.poll_options) ? post.poll_options : [];
      // Telegram ждёт InputPollOption: { text }
      payload.options = options.map((o) =>
        typeof o === "string" ? { text: o } : o
      );
      payload.is_anonymous = post.poll_anonymous !== false;
      break;
    }
    default:
      return { ok: false, error: `Неизвестный формат: ${post.format}`, retryable: false };
  }

  let resp: Response;
  try {
    resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return {
      ok: false,
      error: `Сетевая ошибка: ${e instanceof Error ? e.message : String(e)}`,
      retryable: true,
    };
  }

  const tg = await resp.json().catch(() => null);
  if (tg?.ok) return { ok: true, messageId: tg.result?.message_id };

  const code: number = tg?.error_code ?? resp.status;
  const desc: string = tg?.description ?? "неизвестная ошибка Telegram";
  if (code === 429) {
    return { ok: false, error: desc, retryable: true, retryAfter: tg?.parameters?.retry_after };
  }
  if (code >= 500) return { ok: false, error: desc, retryable: true };
  // 4xx-ошибки логики (неверный chat_id, бот удалён из канала и т.п.) — не повторяем
  return { ok: false, error: `Telegram ${code}: ${desc}`, retryable: false };
}
