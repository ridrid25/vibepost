// watchdog: сторож постинга. Вызывается pg_cron раз в 10 минут.
// Если у пользователя есть публикации, просроченные дольше 10 минут
// (планировщик встал или падает), шлём тревогу — но не чаще раза в час,
// чтобы не заспамить.
import { createClient } from "npm:@supabase/supabase-js@2";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function callerIsService(req: Request, serviceKey: string): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return false;
  if (m[1] === serviceKey) return true;
  const parts = m[1].split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!callerIsService(req, serviceKey)) return json(403, { error: "forbidden" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  const { data: stuck, error } = await admin.rpc("stuck_report", { p_minutes: 10 });
  if (error) return json(500, { error: error.message });
  if (!stuck || stuck.length === 0) return json(200, { alerted: 0 });

  let alerted = 0;
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  for (const row of stuck) {
    // Антиспам: не чаще одной тревоги в час на пользователя
    const { data: recent } = await admin
      .from("notifications")
      .select("id")
      .eq("user_id", row.user_id)
      .eq("type", "posting_stuck")
      .gte("created_at", hourAgo)
      .limit(1);
    if (recent && recent.length > 0) continue;

    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/notify-error`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: row.user_id,
        type: "posting_stuck",
        title: "🚨 VibePost — постинг встал",
        message:
          `${row.stuck_count} публикаций ждут отправки дольше 10 минут. ` +
          "Планировщик, похоже, остановился. Загляните в приложение: " +
          "если посты так и висят «Запланирован» с прошедшим временем — " +
          "сообщите разработчику.",
      }),
    }).catch(() => {});
    alerted++;
  }

  return json(200, { stuck_users: stuck.length, alerted });
});
