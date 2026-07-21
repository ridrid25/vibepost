// snapshot-subscribers: ежедневный замер числа подписчиков каждого канала.
// Для каждого чата берёт токен его бота и вызывает Telegram getChatMemberCount,
// пишет снимок (один на чат в день) в chat_subscriber_stats.
// Вызывается по cron с service-правами.
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

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!callerIsService(req, serviceKey)) return json(403, { error: "forbidden" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  // Дата снимка — по Москве
  const snapshotDate = new Date(Date.now() + MSK_OFFSET_MS).toISOString().slice(0, 10);

  const { data: chats } = await admin
    .from("chats")
    .select("id, telegram_chat_id, bot_id, type");
  if (!chats || chats.length === 0) return json(200, { snapshots: 0 });

  // Токен на каждого бота — по разу
  const tokenByBot = new Map<string, string>();
  let saved = 0;

  for (const chat of chats) {
    // Каналы/группы — есть смысл считать подписчиков; личку пропускаем
    if (chat.type === "private") continue;

    let token = tokenByBot.get(chat.bot_id);
    if (!token) {
      const { data: bot } = await admin
        .from("bots").select("token_secret_id, is_active").eq("id", chat.bot_id).maybeSingle();
      if (!bot?.is_active || !bot.token_secret_id) continue;
      const { data: t } = await admin.rpc("get_bot_token", { p_secret_id: bot.token_secret_id });
      if (!t) continue;
      token = t;
      tokenByBot.set(chat.bot_id, token);
    }

    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${token}/getChatMemberCount?chat_id=${encodeURIComponent(chat.telegram_chat_id)}`,
      );
      const tg = await resp.json();
      if (!tg?.ok || typeof tg.result !== "number") continue;

      await admin.from("chat_subscriber_stats").upsert(
        { chat_id: chat.id, snapshot_date: snapshotDate, member_count: tg.result, captured_at: new Date().toISOString() },
        { onConflict: "chat_id,snapshot_date" },
      );
      saved++;
    } catch (_e) {
      // один недоступный канал не должен ронять весь замер
    }
  }

  return json(200, { snapshots: saved, date: snapshotDate });
});
