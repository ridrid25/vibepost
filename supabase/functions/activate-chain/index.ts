// activate-chain: запуск цепочки.
// Вход: { chain_id, bot_id, chat_id }. Требуется JWT пользователя.
// Создаёт active_chains (running) и active_chain_steps со
// scheduled_at = started_at + delay_minutes каждого шага.
// Ответ 200: { id, steps, started_at, last_at }. Ошибка: { error }.
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
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json(401, { error: "Требуется вход в систему" });

    const body = await req.json().catch(() => ({}));
    const { chain_id, bot_id, chat_id } = body;
    if (!chain_id || !bot_id || !chat_id) {
      return json(400, { error: "Нужны chain_id, bot_id и chat_id" });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Всё должно принадлежать этому пользователю, чат — этому боту
    const { data: chain } = await admin
      .from("message_chains").select("id, user_id, name").eq("id", chain_id).maybeSingle();
    if (!chain || chain.user_id !== user.id) return json(404, { error: "Цепочка не найдена" });

    const { data: bot } = await admin
      .from("bots").select("id, user_id, is_active").eq("id", bot_id).maybeSingle();
    if (!bot || bot.user_id !== user.id) return json(404, { error: "Бот не найден" });
    if (!bot.is_active) return json(400, { error: "Бот отключён" });

    const { data: chat } = await admin
      .from("chats").select("id, user_id, bot_id").eq("id", chat_id).maybeSingle();
    if (!chat || chat.user_id !== user.id) return json(404, { error: "Чат не найден" });
    if (chat.bot_id !== bot.id) return json(400, { error: "Чат привязан к другому боту" });

    const { data: steps } = await admin
      .from("chain_steps")
      .select("id, position, delay_minutes, template_id, format")
      .eq("chain_id", chain.id)
      .order("position");
    if (!steps || steps.length === 0) return json(400, { error: "В цепочке нет шагов" });

    const broken = steps.find((s) => !s.template_id && !s.format);
    if (broken) {
      return json(400, { error: `Шаг ${broken.position}: не задан ни шаблон, ни контент` });
    }

    const { data: ac, error: acError } = await admin
      .from("active_chains")
      .insert({ user_id: user.id, chain_id: chain.id, bot_id: bot.id, chat_id: chat.id })
      .select("id, started_at")
      .single();
    if (acError || !ac) {
      return json(500, { error: `Не удалось запустить цепочку: ${acError?.message}` });
    }

    const startedMs = new Date(ac.started_at).getTime();
    const rows = steps.map((s) => ({
      active_chain_id: ac.id,
      step_id: s.id,
      scheduled_at: new Date(startedMs + s.delay_minutes * 60_000).toISOString(),
    }));
    const { error: stepsError } = await admin.from("active_chain_steps").insert(rows);
    if (stepsError) {
      await admin.from("active_chains").delete().eq("id", ac.id);
      return json(500, { error: `Не удалось создать шаги: ${stepsError.message}` });
    }

    return json(200, {
      id: ac.id,
      steps: rows.length,
      started_at: ac.started_at,
      last_at: rows[rows.length - 1].scheduled_at,
    });
  } catch (e) {
    return json(500, { error: `Внутренняя ошибка: ${e instanceof Error ? e.message : String(e)}` });
  }
});
