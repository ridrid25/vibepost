// telegram-webhook: приём обновлений от Telegram.
// 1) Реакции на посты (message_reaction_count / message_reaction) →
//    обновление post_analytics.
// 2) Команды в личке бота от владельца (/status, /queue, /today) —
//    владелец опознаётся по profiles.error_notify_tg_id, чужим не отвечаем.
// Защита: секретный заголовок X-Telegram-Bot-Api-Secret-Token (Vault).
// Всегда отвечаем Telegram 200, иначе он будет повторять доставку.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

let cachedSecret: string | null = null;

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fmtMsk(iso: string): string {
  const d = new Date(new Date(iso).getTime() + MSK_OFFSET_MS);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}.${mm} ${hh}:${mi}`;
}

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

// Ключ реакции: обычное эмодзи, кастомное или платная (звезда)
function emojiKey(r: unknown): string | null {
  if (!r || typeof r !== "object") return null;
  const t = r as { type?: string; emoji?: string; custom_emoji_id?: string };
  if (t.type === "emoji") return t.emoji ?? null;
  if (t.type === "custom_emoji") return `custom:${t.custom_emoji_id}`;
  if (t.type === "paid") return "⭐";
  return null;
}

// Команды владельца в личке бота
async function handleCommand(
  admin: SupabaseClient,
  msg: { from?: { id?: number }; chat: { id: number }; text: string },
) {
  const fromId = String(msg.from?.id ?? "");
  if (!fromId) return;

  // Владелец = тот, чей Telegram ID записан в настройках уведомлений
  const { data: profile } = await admin
    .from("profiles")
    .select("id, error_notify_bot_id")
    .eq("error_notify_tg_id", fromId)
    .maybeSingle();
  if (!profile?.error_notify_bot_id) return; // незнакомцам не отвечаем

  const { data: bot } = await admin
    .from("bots")
    .select("token_secret_id")
    .eq("id", profile.error_notify_bot_id)
    .maybeSingle();
  if (!bot?.token_secret_id) return;
  const { data: token } = await admin
    .rpc("get_bot_token", { p_secret_id: bot.token_secret_id });
  if (!token) return;

  const uid = profile.id;
  const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();
  const { todayStart, tomorrowStart, dayAfterStart } = mskDayBounds();
  let reply: string;

  if (cmd === "/status") {
    const { data: stuck } = await admin.rpc("stuck_report", { p_minutes: 10 });
    const mine = (stuck ?? []).find((r: { user_id: string }) => r.user_id === uid);

    const { count: sentToday } = await admin
      .from("posts").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("status", "sent").gte("sent_at", todayStart);
    const { count: failedToday } = await admin
      .from("posts").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("status", "failed").gte("created_at", todayStart);
    const { count: queued } = await admin
      .from("posts").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("status", "scheduled");
    const { data: next } = await admin
      .from("posts").select("scheduled_at")
      .eq("user_id", uid).eq("status", "scheduled")
      .order("scheduled_at").limit(1);

    reply = mine
      ? `🚨 Внимание: ${mine.stuck_count} публикаций зависли дольше 10 минут — постинг, похоже, встал.`
      : "✅ Всё работает, зависших публикаций нет.";
    reply += `\nСегодня: отправлено ${sentToday ?? 0}, ошибок ${failedToday ?? 0}.`;
    reply += `\nВ очереди: ${queued ?? 0} пост(ов).`;
    if (next && next.length > 0) {
      reply += ` Ближайший — ${fmtMsk(next[0].scheduled_at)} МСК.`;
    }
  } else if (cmd === "/queue") {
    const { data: q } = await admin
      .from("posts")
      .select("scheduled_at, format, text, poll_question, chats(title)")
      .eq("user_id", uid).eq("status", "scheduled")
      .order("scheduled_at").limit(5);
    const { count: stepsQueued } = await admin
      .from("active_chain_steps")
      .select("id, active_chains!inner(user_id, status)", { count: "exact", head: true })
      .eq("status", "scheduled")
      .eq("active_chains.user_id", uid)
      .eq("active_chains.status", "running");

    if ((!q || q.length === 0) && !(stepsQueued && stepsQueued > 0)) {
      reply = "Очередь пуста — запланированных публикаций нет.";
    } else {
      const lines = (q ?? []).map((p) => {
        const what = (p.text ?? p.poll_question ?? "(фото)").slice(0, 40);
        const chat = (p.chats as unknown as { title?: string })?.title ?? "";
        return `• ${fmtMsk(p.scheduled_at)} — ${chat}: ${what}`;
      });
      reply = `Ближайшие посты (МСК):\n${lines.join("\n")}`;
      if (stepsQueued && stepsQueued > 0) {
        reply += `\nПлюс шагов цепочек в очереди: ${stepsQueued}`;
      }
    }
  } else if (cmd === "/today") {
    const { count: s } = await admin
      .from("posts").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("status", "sent").gte("sent_at", todayStart);
    const { count: f } = await admin
      .from("posts").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("status", "failed").gte("created_at", todayStart);
    const { count: p } = await admin
      .from("posts").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("status", "scheduled")
      .gte("scheduled_at", tomorrowStart).lt("scheduled_at", dayAfterStart);
    const { count: r } = await admin
      .from("active_chains").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("status", "running");
    reply = `📊 Сводка:\nОтправлено сегодня: ${s ?? 0}\nОшибок: ${f ?? 0}` +
      `\nЗапланировано на завтра: ${p ?? 0}\nЦепочек в работе: ${r ?? 0}`;
  } else {
    reply = "Я слежу за вашим постингом. Команды:\n" +
      "/status — всё ли работает\n" +
      "/queue — ближайшие публикации\n" +
      "/today — сводка за день";
  }

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: msg.chat.id, text: reply }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (!cachedSecret) {
    const { data } = await admin.rpc("get_webhook_secret");
    cachedSecret = data ?? null;
  }
  const header = req.headers.get("x-telegram-bot-api-secret-token");
  if (!cachedSecret || header !== cachedSecret) {
    return json(403, { error: "forbidden" });
  }

  const update = await req.json().catch(() => null);
  if (!update) return json(200, { ok: true });

  try {
    if (update.message_reaction_count) {
      const mrc = update.message_reaction_count;
      const reactions: Record<string, number> = {};
      let total = 0;
      for (const rc of mrc.reactions ?? []) {
        const key = emojiKey(rc.type);
        if (!key) continue;
        const count = rc.total_count ?? 0;
        reactions[key] = count;
        total += count;
      }
      await admin.rpc("set_reactions", {
        p_telegram_chat_id: String(mrc.chat.id),
        p_tg_message_id: mrc.message_id,
        p_reactions: reactions,
        p_reactions_count: total,
      });
    } else if (update.message_reaction) {
      const mr = update.message_reaction;
      const oldSet = (mr.old_reaction ?? []).map(emojiKey).filter(Boolean) as string[];
      const newSet = (mr.new_reaction ?? []).map(emojiKey).filter(Boolean) as string[];
      const added = newSet.filter((e) => !oldSet.includes(e));
      const removed = oldSet.filter((e) => !newSet.includes(e));
      if (added.length || removed.length) {
        await admin.rpc("apply_reaction_delta", {
          p_telegram_chat_id: String(mr.chat.id),
          p_tg_message_id: mr.message_id,
          p_added: added,
          p_removed: removed,
        });
      }
    } else if (
      update.message &&
      update.message.chat?.type === "private" &&
      typeof update.message.text === "string" &&
      update.message.text.startsWith("/")
    ) {
      await handleCommand(admin, update.message);
    }
  } catch (_e) {
    // Ошибку глотаем сознательно: Telegram при не-200 повторяет доставку,
    // а нам повторы одного и того же обновления не нужны.
  }

  return json(200, { ok: true });
});
