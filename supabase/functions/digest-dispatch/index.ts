// digest-dispatch: раз в минуту двигает дайджест «по новостям».
//
// Вся логика расписания и идемпотентности — в SQL (digest_dispatch): пост
// заводится ровно один раз, отправляет его общий планировщик, квитанция
// Telegram возвращается в публикацию. Здесь только сообщения владелице о том,
// что требует её внимания: обложка опаздывает, пересечение с дневной сеткой,
// текст длиннее лимита Telegram, Telegram не принял пост. Молча текст без
// обложки не уходит никогда.
//
// Вызов: pg_cron раз в минуту, только с сервисным ключом.
//   supabase.functions.invoke("digest-dispatch", { body: {} })
//   → { действий: n, сообщено: m }
import { createClient } from "npm:@supabase/supabase-js@2";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function callerIsService(req: Request, serviceKey: string): boolean {
  const m = (req.headers.get("Authorization") ?? "").match(/^Bearer (.+)$/);
  if (!m) return false;
  if (m[1] === serviceKey) return true;
  const parts = m[1].split(".");
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))).role === "service_role";
  } catch {
    return false;
  }
}

const ПОНЯТНО: Record<string, (d: string) => string> = {
  cover_late: (d) => `обложка не готова, ${d} — пост ждёт её, без обложки не отправляю`,
  blocked_overlap: (d) => `утренняя новость сдвинулась на ${d} и наезжает на дневные слоты — остановил, нужно ваше правило`,
  blocked_long_caption: (d) => `текст ${d} знаков, а Telegram под видео берёт 1024 — остановил, обрезать не стал`,
  failed: (d) => `Telegram не принял пост: ${d}`,
};

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!callerIsService(req, serviceKey)) return json(401, { error: "только сервис" });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  const { data: действия, error } = await admin.rpc("digest_dispatch");
  if (error) return json(500, { error: error.message });
  const тревоги = (действия ?? []).filter((д: { action: string }) => ПОНЯТНО[д.action]);
  if (!тревоги.length) return json(200, { действий: (действия ?? []).length, сообщено: 0 });

  const { data: cfg } = await admin.from("news_config").select("user_id, bot_id").limit(1).maybeSingle();
  const { data: bot } = await admin.from("bots").select("token_secret_id").eq("id", cfg?.bot_id).maybeSingle();
  const { data: token } = await admin.rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });
  const { data: профиль } = await admin.from("profiles").select("error_notify_tg_id").eq("id", cfg?.user_id).maybeSingle();
  if (!token || !профиль?.error_notify_tg_id) return json(200, { действий: действия.length, сообщено: 0, причина: "некуда писать" });

  const текст = "📰 Дайджест по новостям:\n" + тревоги.map((д: { item_order: number; action: string; detail: string }) =>
    `• новость ${д.item_order}: ${ПОНЯТНО[д.action](String(д.detail ?? ""))}`).join("\n");
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: профиль.error_notify_tg_id, text: текст }),
  }).catch(() => null);
  return json(200, { действий: действия.length, сообщено: тревоги.length });
});
