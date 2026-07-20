// daily-digest: ежедневная сводка в личный Telegram (21:00 МСК по cron).
// Для каждого пользователя с настроенными уведомлениями: отправлено за
// сегодня, ошибок, запланировано на завтра, активных цепочек. Если всё
// по нулям — молчим (не спамим). В колокольчик не пишется (skip_bell).
import { createClient } from "npm:@supabase/supabase-js@2";

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

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

// Границы «сегодня» и «завтра» по Москве, в UTC для запросов
function mskDayBounds() {
  const nowMsk = new Date(Date.now() + MSK_OFFSET_MS);
  const dayStartMsk = Date.UTC(
    nowMsk.getUTCFullYear(), nowMsk.getUTCMonth(), nowMsk.getUTCDate(),
  );
  const todayStart = new Date(dayStartMsk - MSK_OFFSET_MS);
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const dayAfterStart = new Date(todayStart.getTime() + 48 * 60 * 60 * 1000);
  return {
    todayStart: todayStart.toISOString(),
    tomorrowStart: tomorrowStart.toISOString(),
    dayAfterStart: dayAfterStart.toISOString(),
  };
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!callerIsService(req, serviceKey)) return json(403, { error: "forbidden" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const { todayStart, tomorrowStart, dayAfterStart } = mskDayBounds();

  const { data: profiles } = await admin
    .from("profiles")
    .select("id")
    .not("error_notify_tg_id", "is", null)
    .not("error_notify_bot_id", "is", null);

  let sentDigests = 0;

  for (const profile of profiles ?? []) {
    const uid = profile.id;

    const { count: sentToday } = await admin
      .from("posts").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("status", "sent").gte("sent_at", todayStart);

    const { count: failedToday } = await admin
      .from("posts").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("status", "failed").gte("created_at", todayStart);

    const { count: plannedTomorrow } = await admin
      .from("posts").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("status", "scheduled")
      .gte("scheduled_at", tomorrowStart).lt("scheduled_at", dayAfterStart);

    const { count: runningChains } = await admin
      .from("active_chains").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("status", "running");

    const s = sentToday ?? 0, f = failedToday ?? 0,
      p = plannedTomorrow ?? 0, r = runningChains ?? 0;
    if (s + f + p + r === 0) continue; // нечего рассказывать — молчим

    const lines = [
      `Отправлено сегодня: ${s}`,
      f > 0 ? `Ошибок: ${f} ⚠️` : `Ошибок: 0`,
      `Запланировано на завтра: ${p}`,
    ];
    if (r > 0) lines.push(`Цепочек в работе: ${r}`);

    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/notify-error`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: uid,
        type: "daily_digest",
        title: "📊 VibePost — сводка за день",
        message: lines.join("\n"),
        skip_bell: true,
      }),
    }).catch(() => {});
    sentDigests++;
  }

  return json(200, { digests: sentDigests });
});
