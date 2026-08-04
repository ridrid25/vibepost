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
    .select("id, error_notify_bot_id, awaiting_task")
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
  // Понимаем и команды (/status), и нажатия кнопок меню («📊 Статус»)
  const raw = msg.text.trim().toLowerCase();
  let cmd = raw.split(/[\s@]/)[0];
  if (!cmd.startsWith("/")) {
    if (raw.includes("статус")) cmd = "/status";
    else if (raw.includes("очередь")) cmd = "/queue";
    else if (raw.includes("сводка")) cmd = "/today";
    else if (raw.includes("сломалось") || raw.includes("sos")) cmd = "/sos";
    else if (raw.includes("идеи")) cmd = "/ideas";
    else if (raw.includes("дайджест")) cmd = "/digest";
    else if (raw.includes("входящие")) cmd = "/inbox";
    else if (raw.includes("задание")) cmd = "/task";
    else cmd = "";
  }

  // Режим «жду текст задания»: следующее сообщение — не команда, а задание
  // для Claude. Проверяется до разбора команд, иначе съест их как текст.
  if (!cmd && profile.awaiting_task) {
    const текст = msg.text.trim();

    // Татьяна присылает ролик, а название и замечание пишет следующим
    // сообщением — подпись к самому видео она не набирает. Раньше эти два
    // сообщения жили порознь: ролик оставался «Ролик из Telegram», а задание
    // «Переделываем» повисало без адресата. Теперь свежий ролик (последние
    // 20 минут) подхватывается: текст становится и названием, и замечанием.
    const давность = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const { data: свежий } = await admin
      .from("incoming_videos")
      .select("id, name, status")
      .eq("user_id", profile.id)
      .gte("created_at", давность)
      .in("status", ["new", "rework"])
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();

    let хвост = "";
    if (свежий) {
      // Название — первая строка, без хвоста в полкилобайта.
      const название = текст.split("\n")[0].trim().slice(0, 60);
      const безымянный = !свежий.name || свежий.name === "Ролик из Telegram";
      await admin.from("incoming_videos").update({
        ...(безымянный && название ? { name: название } : {}),
        status: "rework",
        rework_note: текст,
        rework_at: new Date().toISOString(),
      }).eq("id", свежий.id);
      хвост = безымянный && название
        ? `\n\nОтнёс к ролику, который вы прислали только что, и назвал его «${название}».`
        : `\n\nОтнёс к ролику «${свежий.name}» — он ушёл на доделку.`;
    }

    await admin.from("claude_tasks").insert({
      user_id: profile.id, text: текст, video_id: свежий?.id ?? null,
    });
    await admin.from("profiles").update({ awaiting_task: false }).eq("id", profile.id);
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: "Записал. Возьму в работу, как только буду запущен на компьютере — " +
          "список заданий проверяю первым делом." + хвост,
      }),
    }).catch(() => {});
    return;
  }
  // Ответ на вопрос «как назвать ролик?». Кнопку «Задание» при этом никто не
  // жмёт — Татьяна просто пишет строку следом за роликом. Ловим только тогда,
  // когда свежий ролик действительно лежит без названия: ролик, присланный
  // файлом, зовётся «duration_seconds_aspect (11).mp4», и заголовок в кадр из
  // такого имени не поставить. Обработка этого ролика ждёт ответа.
  if (!cmd) {
    const давность = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: безымянный } = await admin
      .from("incoming_videos")
      .select("id, name")
      .eq("user_id", profile.id)
      .is("polished_at", null)
      .gte("created_at", давность)
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();

    const безЗаголовка = безымянный && !/—/.test(безымянный.name ?? "") &&
      (/\.(mp4|mov|webm|mkv|avi)$/i.test(безымянный.name ?? "") ||
        !/[а-яё]/i.test(безымянный.name ?? ""));

    if (безЗаголовка) {
      const название = msg.text.trim().split("\n")[0].slice(0, 200);
      await admin.from("incoming_videos")
        .update({ name: название }).eq("id", безымянный!.id);
      const заголовок = название.includes("—")
        ? название.split("—").pop()!.trim()
        : название;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: msg.chat.id,
          text: `Назвал ролик «${название}». Заголовок в кадре: «${заголовок.toUpperCase()}». ` +
            `Вешаю титры.`,
        }),
      }).catch(() => {});
      return;
    }
  }

  const { todayStart, tomorrowStart, dayAfterStart } = mskDayBounds();
  let reply: string;
  // Если задан — шлём вторым сообщением как блок кода (одно касание = копия)
  let copyBlock: string | null = null;

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
    // Деньги на генерацию: считаем сами, у служебного аккаунта нет доступа
    // к балансу биллинга Google.
    const { data: деньги } = await admin.rpc("veo_spend", { p_user: uid });
    const м = деньги?.[0];
    if (м) {
      reply += `\nГенерация: потрачено ${Number(м.за_месяц_usd).toFixed(2)} $ из ${Number(м.лимит_usd).toFixed(2)} $, осталось ${Number(м.осталось_usd).toFixed(2)} $ (~${Math.round(Number(м.осталось_usd) * 90)} ₽), роликов за месяц: ${м.роликов_за_месяц}.`;
    }
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
  } else if (cmd === "/inbox") {
    const { data: v } = await admin
      .from("incoming_videos")
      .select("name, status, ready")
      .eq("user_id", uid).eq("status", "new")
      .order("created_at", { ascending: false }).limit(10);
    reply = v?.length
      ? `📥 Во «Входящих» ${v.length}:\n` +
        v.map((x) => `• ${x.name}${x.ready ? "" : " — не согласован"}`).join("\n")
      : "📥 Входящие пусты.";
  } else if (cmd === "/ideas") {
    // Идеи придумываются не мгновенно — предупреждаем, чтобы не ждали молча.
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: msg.chat.id, text: "Придумываю пять идей…" }),
    }).catch(() => {});
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/suggest-ideas`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    }).catch(() => {});
    return;
  } else if (cmd === "/digest") {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: msg.chat.id, text: "Собираю дайджест…" }),
    }).catch(() => {});
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/write-digest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    }).catch(() => {});
    return;
  } else if (cmd === "/task") {
    await admin.from("profiles").update({ awaiting_task: true }).eq("id", uid);
    const { data: ждут } = await admin
      .from("claude_tasks").select("text")
      .eq("user_id", uid).eq("status", "new")
      .order("created_at").limit(5);
    reply = "✍️ Напишите задание следующим сообщением.\n\n" +
      "Claude живёт на компьютере и сам в Telegram не отвечает. Задание " +
      "полежит здесь и попадёт к нему при первом же запуске — ничего не " +
      "потеряется и держать в голове не нужно.\n\nОтменить: любая кнопка меню." +
      (ждут?.length
        ? `\n\nУже ждут (${ждут.length}):\n` +
          ждут.map((t) => `• ${t.text.slice(0, 70)}`).join("\n")
        : "");
  } else if (cmd === "/sos" || cmd === "/help") {
    reply = "🛠 Ремонтная памятка VibePost\n\n" +
      "1️⃣ Пришла ошибка отправки с причиной — почти всегда чинится за " +
      "2 минуты: следуйте разделу «🔧 Что делать» прямо в уведомлении " +
      "(перепривязать канал, вернуть бота в админы и т.п.).\n\n" +
      "2️⃣ Пришло 🚨 «постинг встал» — нужен разработчик: откройте " +
      "Claude Code на компьютере в папке проекта и напишите «сторож " +
      "ругается, постинг встал».\n\n" +
      "3️⃣ Вы не у компьютера — откройте приложение Claude на телефоне, " +
      "пришлите ему скриншот ошибки и текст из блока ниже.\n" +
      "👇 Нажмите на серый блок — он скопируется одним касанием.\n\n" +
      "ℹ️ Если бот и приложение молчат несколько дней — возможно, уснул " +
      "бесплатный Supabase: зайдите на supabase.com → проект VibePost → " +
      "кнопка Restore.";
    copyBlock =
      "У меня сервис VibePost: отложенный постинг в Telegram на Supabase, " +
      "проект rjtyjybwygfkdekdzqbm (облако supabase.com). Посты шлёт " +
      "Edge Function process-scheduler по pg_cron раз в минуту. Проверь " +
      "через коннектор Supabase журналы и зависшие посты и скажи, что " +
      "сломалось и как чинить.";
  } else {
    reply = "Я слежу за вашим постингом. Команды:\n" +
      "/status — всё ли работает\n" +
      "/queue — ближайшие публикации\n" +
      "/today — сводка за день\n" +
      "/sos — что делать, если сломалось";
  }

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: msg.chat.id,
      text: reply,
      // Постоянное меню-клавиатура под полем ввода
      reply_markup: {
        keyboard: [
          [{ text: "📊 Статус" }, { text: "📅 Очередь" }, { text: "📥 Входящие" }],
          [{ text: "💡 Идеи" }, { text: "📰 Дайджест" }],
          [{ text: "✍️ Задание" }, { text: "🛠 Если сломалось" }],
        ],
        resize_keyboard: true,
        is_persistent: true,
      },
    }),
  }).catch(() => {});

  // Второе сообщение — блок кода. На телефоне у него есть кнопка «копировать»
  // (одно касание переносит весь текст в буфер обмена).
  if (copyBlock) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: `<pre>${copyBlock}</pre>`,
        parse_mode: "HTML",
      }),
    }).catch(() => {});
  }
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
      (update.message.video || update.message.document)
    ) {
      // Ролик, присланный боту с телефона: «Поделиться» → бот. Приёмом
      // занимается отдельная функция.
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/video-from-bot`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(update.message),
      });
    } else if (
      update.message &&
      update.message.chat?.type === "private" &&
      update.message.reply_to_message &&
      typeof update.message.text === "string" &&
      update.message.text.trim().length > 0
    ) {
      // Ответ на карточку идеи своим текстом = правка реплики.
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/idea-button`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "edit",
          data: "idea:edit",
          from: update.message.from,
          new_line: update.message.text,
          message: {
            chat: update.message.chat,
            message_id: update.message.reply_to_message.message_id,
          },
        }),
      });
    } else if (
      update.message &&
      update.message.chat?.type === "private" &&
      typeof update.message.text === "string" &&
      update.message.text.trim().length > 0
    ) {
      await handleCommand(admin, update.message);
    } else if (update.callback_query) {
      // Нажатия кнопок обрабатывают отдельные функции — их можно править,
      // не трогая вебхук. Дайджест новостей помечен префиксом «dg:».
      const дайджест = String(update.callback_query.data ?? "").startsWith("dg:");
      await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/${дайджест ? "digest-button" : "idea-button"}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            дайджест ? { callback: update.callback_query } : update.callback_query,
          ),
        },
      );
    }
  } catch (_e) {
    // Ошибку глотаем сознательно: Telegram при не-200 повторяет доставку,
    // а нам повторы одного и того же обновления не нужны.
  }

  return json(200, { ok: true });
});
