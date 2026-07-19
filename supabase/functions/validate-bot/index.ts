// validate-bot: проверяет токен бота через Telegram getMe,
// кладёт токен в Vault и создаёт запись в bots.
// Вход: { token: string, name?: string }. Требуется JWT пользователя.
// Ответ 200: { id, username, name }. Ошибка: { error }.
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
    // 1. Кто зовёт? Проверяем JWT пользователя.
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json(401, { error: "Требуется вход в систему" });

    // 2. Валидация входа
    const body = await req.json().catch(() => ({}));
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
      return json(400, { error: "Неверный формат токена бота" });
    }

    // 3. Спрашиваем Telegram, живой ли токен
    const tgResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const tg = await tgResp.json();
    if (!tg.ok) {
      return json(400, { error: `Telegram отклонил токен: ${tg.description ?? "неизвестная ошибка"}` });
    }

    // 4. Токен — в Vault, бот — в таблицу
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: secretId, error: vaultError } = await admin
      .rpc("store_bot_token", { p_token: token });
    if (vaultError || !secretId) {
      return json(500, { error: `Не удалось сохранить токен: ${vaultError?.message ?? "нет id секрета"}` });
    }

    const { data: bot, error: insertError } = await admin
      .from("bots")
      .insert({
        user_id: user.id,
        name: name || tg.result.first_name || tg.result.username,
        username: tg.result.username,
        token_secret_id: secretId,
      })
      .select("id, name, username")
      .single();

    if (insertError) {
      // Бот не записался — подчищаем секрет, чтобы не копить мусор в Vault
      await admin.rpc("delete_bot_token", { p_secret_id: secretId });
      return json(500, { error: `Не удалось сохранить бота: ${insertError.message}` });
    }

    return json(200, { id: bot.id, username: bot.username, name: bot.name });
  } catch (e) {
    return json(500, { error: `Внутренняя ошибка: ${e instanceof Error ? e.message : String(e)}` });
  }
});
