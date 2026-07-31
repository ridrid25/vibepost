// post-econ: экономический календарь — напоминания о событиях в канал.
//
// Раз в час проверяем, не пора ли предупредить о ближайшем событии. Постим
// в тот час и минуту, что заданы в econ_config, и только если событие
// наступает ровно через days_before дней (по умолчанию — завтра).
//
// Источник дат — не парсинг чужих сайтов, а то, что известно наперёд: график
// заседаний ЦБ публикуется на год вперёд, налоговые сроки закреплены в НК РФ.
// Поэтому календарь не ломается от смены вёрстки и не требует ключей.
//
// Каждое событие постится один раз: отметка в posted_at.
import { createClient } from "npm:@supabase/supabase-js@2";

const МСК = 3 * 60 * 60 * 1000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ЗНАЧКИ: Record<string, string> = {
  rate: "🏦",
  tax: "🧾",
  stat: "📊",
  other: "📌",
};

/** Дата в МСК как YYYY-MM-DD, со сдвигом на нужное число дней. */
function деньМск(сдвиг = 0): string {
  const d = new Date(Date.now() + МСК + сдвиг * 86400000);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async () => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: configs } = await admin
    .from("econ_config")
    .select("user_id, bot_id, chat_id, days_before, post_hour, post_minute, enabled")
    .eq("enabled", true);
  if (!configs?.length) return json(200, { ok: true, нечего: true });

  const сейчас = new Date(Date.now() + МСК);
  const часМск = сейчас.getUTCHours();
  const минутаМск = сейчас.getUTCMinutes();

  let отправлено = 0;
  for (const cfg of configs) {
    // Постим в заданный час; минуту сверяем с допуском, чтобы не промахнуться
    // мимо запуска по расписанию.
    if (часМск !== cfg.post_hour) continue;
    if (Math.abs(минутаМск - cfg.post_minute) > 7) continue;

    const целевойДень = деньМск(cfg.days_before);
    const { data: события } = await admin
      .from("econ_events")
      .select("id, event_date, event_time, title, note, kind")
      .eq("user_id", cfg.user_id)
      .eq("event_date", целевойДень)
      .is("posted_at", null);
    if (!события?.length) continue;

    const { data: bot } = await admin
      .from("bots").select("token_secret_id").eq("id", cfg.bot_id).maybeSingle();
    const { data: token } = await admin
      .rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });
    const { data: chat } = await admin
      .from("chats").select("telegram_chat_id").eq("id", cfg.chat_id).maybeSingle();
    if (!token || !chat?.telegram_chat_id) continue;

    const когда = cfg.days_before === 0
      ? "Сегодня"
      : cfg.days_before === 1
      ? "Завтра"
      : `Через ${cfg.days_before} дн.`;

    const строки = события.map((s) => {
      const значок = ЗНАЧКИ[s.kind] ?? ЗНАЧКИ.other;
      const время = s.event_time ? ` в ${String(s.event_time).slice(0, 5)} МСК` : "";
      return `${значок} <b>${s.title}</b>${время}` + (s.note ? `\n${s.note}` : "");
    });

    const текст = `📅 <b>${когда}</b>\n\n${строки.join("\n\n")}`;

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat.telegram_chat_id,
        text: текст,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const tg = await res.json().catch(() => null);
    if (!tg?.ok) continue;

    await admin.from("econ_events")
      .update({ posted_at: new Date().toISOString() })
      .in("id", события.map((s) => s.id));
    отправлено += события.length;
  }

  return json(200, { ok: true, отправлено });
});
