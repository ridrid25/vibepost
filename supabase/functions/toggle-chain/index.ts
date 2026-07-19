// toggle-chain: пауза и возобновление запущенной цепочки.
// Вход: { active_chain_id, action: 'pause' | 'resume' }. Требуется JWT.
// pause: status='paused', paused_at=now(). Планировщик такие шаги не берёт.
// resume: неотправленные шаги сдвигаются на длительность паузы
// (RPC resume_chain_shift), цепочка снова running.
// Ответ 200: { id, status }. Ошибка: { error }.
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
    const { active_chain_id, action } = body;
    if (!active_chain_id || !["pause", "resume"].includes(action)) {
      return json(400, { error: "Нужны active_chain_id и action: 'pause' | 'resume'" });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: ac } = await admin
      .from("active_chains")
      .select("id, user_id, status")
      .eq("id", active_chain_id)
      .maybeSingle();
    if (!ac || ac.user_id !== user.id) return json(404, { error: "Запущенная цепочка не найдена" });

    if (action === "pause") {
      if (ac.status !== "running") {
        return json(400, { error: `Пауза возможна только для running (сейчас: ${ac.status})` });
      }
      const { error } = await admin
        .from("active_chains")
        .update({ status: "paused", paused_at: new Date().toISOString() })
        .eq("id", ac.id);
      if (error) return json(500, { error: error.message });
      return json(200, { id: ac.id, status: "paused" });
    }

    // resume
    if (ac.status !== "paused") {
      return json(400, { error: `Возобновить можно только paused (сейчас: ${ac.status})` });
    }
    const { error: shiftError } = await admin
      .rpc("resume_chain_shift", { p_active_chain_id: ac.id });
    if (shiftError) return json(500, { error: shiftError.message });
    return json(200, { id: ac.id, status: "running" });
  } catch (e) {
    return json(500, { error: `Внутренняя ошибка: ${e instanceof Error ? e.message : String(e)}` });
  }
});
