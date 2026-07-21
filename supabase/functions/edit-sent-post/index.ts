// edit-sent-post: правит уже отправленный пост прямо в канале.
// Вход: { post_id, text, inline_buttons?, disable_link_preview? }. Нужен JWT.
// text-пост  → editMessageText (текст + кнопки + превью).
// photo/video → editMessageCaption (подпись + кнопки).
// poll        → нельзя (ограничение Telegram).
// При успехе обновляет строку posts, чтобы приложение показывало новую версию.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Используйте POST" });

  try {
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json(401, { error: "Требуется вход в систему" });

    const body = await req.json().catch(() => ({}));
    const postId = typeof body.post_id === "string" ? body.post_id : "";
    const newText = typeof body.text === "string" ? body.text : "";
    const inlineButtons = Array.isArray(body.inline_buttons) ? body.inline_buttons : [];
    const disablePreview = body.disable_link_preview === true;
    if (!postId) return json(400, { error: "Нужен post_id" });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: post } = await admin
      .from("posts")
      .select("id, user_id, bot_id, chat_id, format, status, tg_message_id")
      .eq("id", postId)
      .maybeSingle();
    if (!post) return json(404, { error: "Пост не найден" });
    if (post.user_id !== user.id) return json(403, { error: "Это чужой пост" });
    if (post.status !== "sent" || !post.tg_message_id) {
      return json(400, { error: "Редактировать можно только отправленный пост" });
    }
    if (post.format === "poll") {
      return json(400, { error: "Опрос изменить нельзя — это ограничение Telegram. Можно только продублировать с новым вопросом." });
    }

    const { data: bot } = await admin
      .from("bots").select("token_secret_id, is_active").eq("id", post.bot_id).maybeSingle();
    if (!bot?.token_secret_id) return json(400, { error: "Бот не найден" });
    const { data: token } = await admin.rpc("get_bot_token", { p_secret_id: bot.token_secret_id });
    if (!token) return json(500, { error: "Не удалось получить токен бота" });

    const { data: chat } = await admin
      .from("chats").select("telegram_chat_id").eq("id", post.chat_id).maybeSingle();
    if (!chat) return json(400, { error: "Чат не найден" });

    const replyMarkup = { inline_keyboard: inlineButtons };
    let method: string;
    const payload: Record<string, unknown> = {
      chat_id: chat.telegram_chat_id,
      message_id: post.tg_message_id,
      reply_markup: replyMarkup,
    };

    if (post.format === "text") {
      method = "editMessageText";
      payload.text = newText;
      payload.link_preview_options = { is_disabled: disablePreview };
    } else {
      method = "editMessageCaption";
      payload.caption = newText;
    }

    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const tg = await resp.json().catch(() => null);

    // «message is not modified» — по сути успех: менять нечего
    const notModified = !tg?.ok &&
      typeof tg?.description === "string" &&
      tg.description.toLowerCase().includes("not modified");

    if (!tg?.ok && !notModified) {
      return json(400, { error: `Telegram: ${tg?.description ?? "не удалось изменить сообщение"}` });
    }

    await admin.from("posts").update({
      text: newText,
      inline_buttons: inlineButtons.length > 0 ? inlineButtons : null,
      disable_link_preview: disablePreview,
    }).eq("id", post.id);

    return json(200, { ok: true, not_modified: notModified });
  } catch (e) {
    return json(500, { error: `Внутренняя ошибка: ${e instanceof Error ? e.message : String(e)}` });
  }
});
