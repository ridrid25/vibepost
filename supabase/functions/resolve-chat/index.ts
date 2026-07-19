// resolve-chat: проверяет доступ бота к чату через Telegram getChat
// и создаёт запись в chats (title и type берутся из ответа Telegram).
// Вход: { bot_id: uuid, telegram_chat_id: string|number }. Требуется JWT.
// Ответ 200: { id, title, type, telegram_chat_id }. Ошибка: { error }.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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
    // 1. Проверяем JWT пользователя
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json(401, { error: "Требуется вход в систему" });

    // 2. Валидация входа
    const body = await req.json().catch(() => ({}));
    const botId = typeof body.bot_id === "string" ? body.bot_id : "";
    const chatId = String(body.telegram_chat_id ?? "").trim();
    if (!botId || !chatId) {
      return json(400, { error: "Нужны bot_id и telegram_chat_id" });
    }

    // 3. Бот существует и принадлежит этому пользователю?
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: bot } = await admin
      .from("bots")
      .select("id, user_id, token_secret_id")
      .eq("id", botId)
      .maybeSingle();
    if (!bot) return json(404, { error: "Бот не найден" });
    if (bot.user_id !== user.id) return json(403, { error: "Этот бот принадлежит другому пользователю" });

    const { data: token, error: tokenError } = await admin
      .rpc("get_bot_token", { p_secret_id: bot.token_secret_id });
    if (tokenError || !token) {
      return json(500, { error: "Не удалось получить токен бота из Vault" });
    }

    // 4. Спрашиваем Telegram про чат
    const tgResp = await fetch(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`,
    );
    const tg = await tgResp.json();
    if (!tg.ok) {
      return json(400, {
        error: `Бот не имеет доступа к чату: ${tg.description ?? "неизвестная ошибка"}. ` +
          "Проверьте Chat ID и что бот добавлен в канал/чат.",
      });
    }

    // Telegram знает типы private/group/supergroup/channel; supergroup для нас — group
    const rawType: string = tg.result.type;
    const type = rawType === "supergroup" ? "group" : rawType;
    if (!["private", "channel", "group"].includes(type)) {
      return json(400, { error: `Неподдерживаемый тип чата: ${rawType}` });
    }
    const title = tg.result.title ??
      [tg.result.first_name, tg.result.last_name].filter(Boolean).join(" ") ??
      tg.result.username ?? chatId;

    // 5. Записываем чат
    const { data: chat, error: insertError } = await admin
      .from("chats")
      .insert({
        user_id: user.id,
        bot_id: bot.id,
        telegram_chat_id: String(tg.result.id ?? chatId),
        title,
        type,
      })
      .select("id, title, type, telegram_chat_id")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        return json(409, { error: "Этот чат уже привязан к данному боту" });
      }
      return json(500, { error: `Не удалось сохранить чат: ${insertError.message}` });
    }

    return json(200, chat);
  } catch (e) {
    return json(500, { error: `Внутренняя ошибка: ${e instanceof Error ? e.message : String(e)}` });
  }
});
