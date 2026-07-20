// notify-error: уведомление пользователя об ошибке отправки.
// Вход: { user_id, type, message }. Вызывается только планировщиком
// (service-права), фронтенду недоступна.
// Всегда пишет строку в notifications (колокольчик в UI).
// Если в профиле настроены error_notify_tg_id и error_notify_bot_id —
// дополнительно шлёт сообщение в личный Telegram через выбранного бота.
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

// По тексту ошибки Telegram подсказываем пользователю, как починить самому
function repairHint(type: string, message: string): string | null {
  if (type !== "post_failed" && type !== "chain_failed") return null;
  const m = message.toLowerCase();
  if (m.includes("chat not found") || m.includes("chat_id is empty")) {
    return "Канал не найден. В Настройках удалите этот чат и привяжите заново (проверьте Chat ID или @имя канала).";
  }
  if (
    m.includes("not enough rights") || m.includes("have no rights") ||
    m.includes("bot is not a member") || m.includes("kicked") ||
    m.includes("chat_write_forbidden")
  ) {
    return "Бот потерял доступ к каналу. В Telegram добавьте бота администратором канала с правом «Публикация сообщений» — и запланируйте пост заново.";
  }
  if (m.includes("unauthorized") || m.includes("bot token")) {
    return "Токен бота недействителен (похоже, отозван в BotFather). В Настройках добавьте бота заново с новым токеном.";
  }
  if (m.includes("бот неактивен")) {
    return "Бот отключён или удалён из приложения. Зайдите в Настройки и добавьте его заново.";
  }
  return "Откройте пост в приложении — полный текст ошибки на его карточке. Если непонятно, что делать, — напишите разработчику.";
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!callerIsService(req, serviceKey)) return json(403, { error: "forbidden" });

  const body = await req.json().catch(() => ({}));
  const { user_id, type, title, skip_bell } = body;
  let { message } = body;
  if (!user_id || !type || !message) {
    return json(400, { error: "Нужны user_id, type и message" });
  }

  const hint = repairHint(type, message);
  if (hint) message = `${message}\n\n🔧 Что делать: ${hint}`;

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  // 1. Запись в notifications (колокольчик) — кроме служебных рассылок
  //    вроде ежедневной сводки (skip_bell: true)
  if (!skip_bell) {
    const { error: insertError } = await admin
      .from("notifications")
      .insert({ user_id, type, message });
    if (insertError) {
      return json(500, { error: `notifications: ${insertError.message}` });
    }
  }

  // 2. Личный Telegram — если настроен в профиле
  let telegramSent = false;
  let telegramError: string | null = null;

  const { data: profile } = await admin
    .from("profiles")
    .select("error_notify_tg_id, error_notify_bot_id")
    .eq("id", user_id)
    .maybeSingle();

  if (profile?.error_notify_tg_id && profile?.error_notify_bot_id) {
    const { data: bot } = await admin
      .from("bots")
      .select("id, user_id, token_secret_id, is_active")
      .eq("id", profile.error_notify_bot_id)
      .maybeSingle();

    if (bot && bot.user_id === user_id && bot.is_active && bot.token_secret_id) {
      const { data: token } = await admin
        .rpc("get_bot_token", { p_secret_id: bot.token_secret_id });
      if (token) {
        try {
          const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: profile.error_notify_tg_id,
              text: `${typeof title === "string" && title ? title : "⚠️ VibePost — ошибка отправки"}\n\n${message}`,
            }),
          });
          const tg = await resp.json().catch(() => null);
          if (tg?.ok) telegramSent = true;
          else telegramError = tg?.description ?? "неизвестная ошибка Telegram";
        } catch (e) {
          telegramError = e instanceof Error ? e.message : String(e);
        }
      } else {
        telegramError = "не удалось получить токен бота";
      }
    } else {
      telegramError = "бот для уведомлений не найден или отключён";
    }
  }

  return json(200, { saved: true, telegram_sent: telegramSent, telegram_error: telegramError });
});
