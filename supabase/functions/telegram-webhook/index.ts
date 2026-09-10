// telegram-webhook: приём обновлений от Telegram.
// 1) Реакции на посты (message_reaction_count / message_reaction) →
//    обновление post_analytics.
// 2) Команды в личке бота от владельца (/status, /queue, /today) —
//    владелец опознаётся по profiles.error_notify_tg_id, чужим не отвечаем.
// Защита: секретный заголовок X-Telegram-Bot-Api-Secret-Token (Vault).
// Всегда отвечаем Telegram 200, иначе он будет повторять доставку.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  TARGET_PLATFORMS,
  normalizeTargetPlatform,
  platformLabel,
} from "../_shared/youtube-trend.mjs";

let cachedSecret: string | null = null;

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const СТРОКА = String.fromCharCode(10);

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

function ownerKeyboard(targetPlatform: string) {
  // Две площадки двумя кнопками, активная помечена галочкой. Одна кнопка
  // «Сейчас: …» была непонятна: Татьяна не находила, ГДЕ переключать, и не
  // видела, ЧТО переключилось. Теперь жмёшь нужную — она и включается.
  const тг = targetPlatform !== TARGET_PLATFORMS.YOUTUBE_SHORTS;
  return {
    keyboard: [
      [{ text: `${тг ? "✅ " : ""}ТикТок/Телеграм` },
       { text: `${тг ? "" : "✅ "}YouTube-канал` }],
      [{ text: "📊 Статус" }, { text: "📅 Очередь" }, { text: "📥 Входящие" }],
      [{ text: "💡 Идеи" }, { text: "📰 Дайджест" }],
      [{ text: "🩺 Как дела" }, { text: "🛠 Если сломалось" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function trustedVideoContext(video: Record<string, unknown> | null) {
  if (!video || video.target_platform !== TARGET_PLATFORMS.YOUTUBE_SHORTS || !video.causal_pattern) {
    return "";
  }
  return ` TRUSTED INTERNAL METADATA: target_platform=youtube_shorts; ` +
    `causal_pattern=${JSON.stringify(video.causal_pattern)}. При исправлении ` +
    `сохранить causal pattern, beat order, violation и payoff class; source details не копировать.`;
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
    .select("id, error_notify_bot_id, awaiting_task, awaiting_video_id, awaiting_kind, target_platform")
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
  const targetPlatform = normalizeTargetPlatform(profile.target_platform);
  // Понимаем и команды (/status), и нажатия кнопок меню («📊 Статус»)
  const raw = msg.text.trim().toLowerCase();
  let cmd = raw.split(/[\s@]/)[0];
  if (!cmd.startsWith("/")) {
    if ((raw.includes("ютуб") || raw.includes("youtube")) && raw.includes("очередь")) cmd = "/yt_queue";
    else if ((raw.includes("ютуб") || raw.includes("youtube")) && raw.includes("стоп")) cmd = "/yt_stop";
    else if ((raw.includes("ютуб") || raw.includes("youtube")) && raw.includes("пуск")) cmd = "/yt_go";
    else if (raw.includes("статус")) cmd = "/status";
    else if (raw.includes("очередь")) cmd = "/queue";
    else if (raw.includes("сводка")) cmd = "/today";
    else if (raw.includes("как дела")) cmd = "/health";
    else if (raw.includes("сломалось") || raw.includes("sos")) cmd = "/sos";
    else if (raw.includes("идеи")) cmd = "/ideas";
    else if (raw.includes("дайджест")) cmd = "/digest";
    else if (raw.includes("входящие")) cmd = "/inbox";
    else if (raw.includes("задание")) cmd = "/task";
    else if ((raw.includes("подключ") || raw.includes("привяж")) &&
      (raw.includes("ютуб") || raw.includes("youtube"))) cmd = "/yt_connect";
    else if (raw.includes("тикток") || raw.includes("телеграм-канал")) cmd = "/pf_tg";
    else if (raw.includes("youtube")) cmd = "/pf_yt";
    else if (raw.includes("площадк") || raw.includes("🎯")) cmd = "/platform";
    else cmd = "";
  }

  // Режим «жду текст задания»: следующее сообщение — не команда, а задание
  // для Claude. Проверяется до разбора команд, иначе съест их как текст.
  // Кнопка под замером назвала ролик прямо — угадывать не нужно.
  if (!cmd && profile.awaiting_video_id) {
    const текст = msg.text.trim();
    const первая = текст.split("\n")[0].trim();
    const ждём = profile.awaiting_kind;
    const { data: ролик } = await admin
      .from("incoming_videos").select("id,name,tag,idea_id,target_platform,causal_pattern")
      .eq("id", profile.awaiting_video_id).maybeSingle();

    let ответ: string;
    if (ждём === "name") {
      const заголовок = первая.includes("—") ? первая.split("—").pop()!.trim() : первая;
      await admin.from("incoming_videos").update({
        name: первая.includes("—") ? первая.slice(0, 200) : `${ролик?.tag ?? "Ролик"} — ${первая}`,
        hook: заголовок,
        status: "new", ready: true, owner_accepted_at: new Date().toISOString(),
        rework_note: null, rework_at: null,
      }).eq("id", profile.awaiting_video_id);
      ответ = `Заголовок в кадре: «${заголовок.toUpperCase()}». Вешаю титры.`;
    } else {
      // rework_ack_at ставим сразу: ответ Татьяне уходит прямо здесь, и
      // приёмник не должен подтверждать то же самое второй раз. 8 августа на
      // одно её замечание бот ответил дважды и назвал ролик по-разному.
      const сейчас = new Date().toISOString();
      await admin.from("incoming_videos").update({
        status: "rework", rework_note: текст, rework_at: сейчас, rework_ack_at: сейчас,
        ready: false, owner_accepted_at: null,
      }).eq("id", profile.awaiting_video_id);
      await admin.from("claude_tasks").insert({
        user_id: profile.id, video_id: profile.awaiting_video_id, idea_id: ролик?.idea_id ?? null,
        text: ждём === "sound"
          ? `ПРАВКА ЗВУКА, промт не переписывать. ${текст}. Порядок — ` +
            `docs/07_ПРАВИЛА.md, «Брак в звуке чинится звуком»: распознать по ` +
            `словам, найти донора в прошлом дубле, пересадить, вернуть роликом в бота.`
          : `${текст}.${trustedVideoContext(ролик)}`,
      });
      ответ = ждём === "sound"
        ? `Записал: «${текст.slice(0, 80)}». Чиню звук донором из прошлого дубля — ` +
          `картинку не трогаю, промт не переписываю. Пришлю готовый ролик сюда.`
        : `Записал замечание к ролику «${ролик?.tag ?? ролик?.name}». ` +
          `Титры не вешаю, перепишу промт.`;
    }
    await admin.from("profiles")
      .update({ awaiting_video_id: null, awaiting_kind: null, awaiting_task: false })
      .eq("id", profile.id);
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: msg.chat.id, text: ответ }),
    }).catch(() => {});
    return;
  }

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
      .select("id,name,status,idea_id,target_platform,causal_pattern")
      .eq("user_id", profile.id)
      .gte("created_at", давность)
      .in("status", ["new", "rework"])
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();

    let хвост = "";
    if (свежий) {
      // Названием считается ТОЛЬКО строка с тире — «Герой — ЗАГОЛОВОК».
      // Всё остальное это замечание, и названия оно не касается. Раньше
      // сюда попадала любая первая строка, и 4 августа фраза «сам добавь
      // букву А, хватит промтов» стала названием ролика, а затем и
      // заголовком прямо в кадре.
      const первая = текст.split("\n")[0].trim();
      // Название приходит двумя способами: строкой с тире («Скорпион — ХУК»)
      // или прямым «название - У нас честный процент». Второй вариант раньше
      // считался обычным замечанием, и название пропадало.
      const явное = первая.match(/^назван\S*\s*[-—:]?\s*[«"]?(.+?)[»"]?$/i);
      const заголовок = явное
        ? явное[1].trim()
        : (первая.includes("—") && первая.length <= 80
          ? первая.split("—").pop()!.trim()
          : null);
      // Название — это знак согласия: ролик годится, можно вешать титры.
      // Поэтому оно снимает пометку доработки, а замечание её ставит.
      await admin.from("incoming_videos").update(заголовок
        ? {
          hook: заголовок,
          ...(!явное ? { name: первая } : {}),
          status: "new", ready: true, owner_accepted_at: new Date().toISOString(),
          rework_note: null,
          rework_at: null,
        }
        : {
          status: "rework",
          rework_note: текст,
          ready: false,
          owner_accepted_at: null,
          // Подтверждение уходит тут же, ниже. Второе от приёмника не нужно.
          rework_at: new Date().toISOString(),
          rework_ack_at: new Date().toISOString(),
        }).eq("id", свежий.id);
      хвост = заголовок
        ? `\n\nЗаголовок в кадре: «${заголовок.toUpperCase()}». Вешаю титры.`
        : `\n\nОтнёс к ролику «${свежий.name}» — он ушёл на доделку. ` +
          `Титры не вешаю, пока не скажете, что годится.`;
    }

    await admin.from("claude_tasks").insert({
      user_id: profile.id,
      text: `${текст}${trustedVideoContext(свежий)}`,
      video_id: свежий?.id ?? null,
      idea_id: свежий?.idea_id ?? null,
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

    // Названием считается ТОЛЬКО строка с тире. Всё остальное — замечание, и
    // трогать им название нельзя: 4 августа фраза «сам добавь букву А, хватит
    // промтов» стала названием ролика и попала заголовком прямо в кадр.
    const названиеПрислали = /—/.test(msg.text.trim().split("\n")[0]);
    const безЗаголовка = безымянный && !/—/.test(безымянный.name ?? "");

    if (безЗаголовка && названиеПрислали) {
      const название = msg.text.trim().split("\n")[0].slice(0, 200);
      const заголовок = название.split("—").pop()!.trim();
      // Название = «ролик годится». Снимает доработку, разрешает титры.
      // Галочку «готово» это не ставит: её ставит только Татьяна и только
      // после того, как увидит готовый ролик с титрами.
      await admin.from("incoming_videos").update({
        name: название, hook: заголовок,
        status: "new", rework_note: null, rework_at: null,
      }).eq("id", безымянный!.id);
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

  if (cmd === "/pf_tg" || cmd === "/pf_yt") {
    const нов = cmd === "/pf_yt" ? TARGET_PLATFORMS.YOUTUBE_SHORTS : TARGET_PLATFORMS.TIKTOK;
    await admin.from("profiles").update({ target_platform: нов }).eq("id", uid);
    const текст = нов === TARGET_PLATFORMS.YOUTUBE_SHORTS
      ? "Переключила на YouTube-канал: идеи будут строиться по чужим удачным " +
        "шортсам, а новые ролики вашего канала берутся на учёт сами." + СТРОКА + СТРОКА +
        "Галочка на кнопке внизу показывает, какой режим включён."
      : "Переключила на ТикТок/Телеграм: идеи снова свои, из стиля серии." + СТРОКА + СТРОКА +
        "Галочка на кнопке внизу показывает, какой режим включён.";
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id, text: текст,
        reply_markup: ownerKeyboard(нов),
      }),
    }).catch(() => {});
    return;
  } else if (cmd === "/yt_queue") {
    const { data: строки } = await admin.from("youtube_publish_queue")
      .select("title,status,scheduled_at,youtube_video_id,error")
      .eq("user_id", uid).order("scheduled_at");
    const все = строки ?? [];
    const счёт = (s: string) => все.filter((r) => r.status === s).length;
    const ближайшие = все.filter((r) => r.status === "scheduled").slice(0, 5)
      .map((r) => {
        const д = new Date(r.scheduled_at);
        const мск = new Date(д.getTime() + 3 * 3600_000);
        const дд = String(мск.getUTCDate()).padStart(2, "0");
        const мм = String(мск.getUTCMonth() + 1).padStart(2, "0");
        const чч = String(мск.getUTCHours()).padStart(2, "0");
        const мин = String(мск.getUTCMinutes()).padStart(2, "0");
        return `${дд}.${мм} ${чч}:${мин} — ${r.title}`;
      });
    const битые = все.filter((r) => r.status === "failed").slice(0, 3)
      .map((r) => `• ${r.title}: ${String(r.error ?? "").slice(0, 60)}`);
    const текст = "📺 Очередь YouTube\n\n" +
      `Вышло: ${счёт("published")}\nВ студии, ждут выхода: ${счёт("uploaded")}\n` +
      `В расписании: ${счёт("scheduled")}\nНа паузе: ${счёт("draft")}\nСбоев: ${счёт("failed")}\n\n` +
      (ближайшие.length ? `Ближайшие:\n${ближайшие.join("\n")}` : "Ближайших публикаций нет.") +
      (битые.length ? `\n\nСбои:\n${битые.join("\n")}` : "") +
      "\n\nКоманды: «стоп ютуб» — пауза, «пуск ютуб» — продолжить.";
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: msg.chat.id, text: текст }),
    }).catch(() => {});
    return;
  } else if (cmd === "/yt_stop") {
    const { data: стало } = await admin.from("youtube_publish_queue")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("user_id", uid).eq("status", "scheduled").select("id");
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: `Остановил очередь YouTube: ${стало?.length ?? 0} роликов на паузе. ` +
          "Продолжить — «пуск ютуб».",
      }),
    }).catch(() => {});
    return;
  } else if (cmd === "/yt_go") {
    const { data: сколько } = await admin.rpc("youtube_queue_resume", { p_user_id: uid });
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: `Очередь YouTube снова идёт: вернул в расписание ${сколько ?? 0} роликов. ` +
          "Просроченные развёл по 5 часов, будущие сроки не трогал.",
      }),
    }).catch(() => {});
    return;
  } else if (cmd === "/yt_connect") {
    // Привязка YouTube-канала: одна кнопка, дальше Google сам ведёт по шагам.
    const r = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/youtube-oauth-start`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ user_id: uid }),
      },
    );
    const тело = await r.json().catch(() => ({}));
    const текст = r.ok && тело.authorization_url
      ? "Привязываю YouTube-канал. Нажмите кнопку, выберите аккаунт, на котором " +
        "живёт канал, и разрешите доступ." + СТРОКА + СТРОКА +
        "Ссылка живёт 10 минут. Если не успели — напишите «подключить ютуб» ещё раз."
      : `Не смог подготовить ссылку: ${тело.error ?? r.status}. Напишите «подключить ютуб» позже.`;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id, text: текст,
        ...(r.ok && тело.authorization_url
          ? { reply_markup: { inline_keyboard: [[
              { text: "🔗 Разрешить доступ к YouTube", url: тело.authorization_url },
            ]] } }
          : {}),
      }),
    }).catch(() => {});
    return;
  } else if (cmd === "/platform") {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: `🎯 Сейчас: ${platformLabel(targetPlatform)}\n\nВыберите целевую площадку:`,
        reply_markup: {
          inline_keyboard: [[
            { text: "TikTok", callback_data: `pf:${TARGET_PLATFORMS.TIKTOK}` },
            { text: "YouTube Shorts", callback_data: `pf:${TARGET_PLATFORMS.YOUTUBE_SHORTS}` },
          ]],
        },
      }),
    }).catch(() => {});
    return;
  } else if (cmd === "/status") {
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
      .select("name, status, ready, target_platform")
      .eq("user_id", uid).eq("status", "new")
      .order("created_at", { ascending: false }).limit(10);
    reply = v?.length
      ? `📥 Во «Входящих» ${v.length}:\n` +
        v.map((x) => `• ${x.name} · 🎯 ${platformLabel(x.target_platform)}` +
          `${x.ready ? "" : " — не согласован"}`).join("\n")
      : "📥 Входящие пусты.";
  } else if (cmd === "/ideas") {
    // Идеи придумываются не мгновенно — предупреждаем, чтобы не ждали молча.
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: `🎯 ${platformLabel(targetPlatform)}\nПридумываю пять идей…`,
      }),
    }).catch(() => {});
    const ideasResponse = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/suggest-ideas`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    }).catch(() => null);
    if (!ideasResponse?.ok) {
      const failure = await ideasResponse?.json().catch(() => null);
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: msg.chat.id,
          text: `Идеи не созданы: ${failure?.error ?? "временный сбой"}`.slice(0, 500),
        }),
      }).catch(() => {});
    }
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
  } else if (cmd === "/health") {
    // Отвечает на вопрос «почему не работает» фактами из базы, без гадания.
    // Причину падения кладёт сюда приёмник в момент сбоя: журнал живёт на
    // компьютере Татьяны, а бот в облаке и до журнала не дотягивается.
    const { data: очередь } = await admin
      .from("claude_tasks").select("created_at")
      .eq("user_id", uid).in("status", ["new", "processing"])
      .order("created_at").limit(1);
    const { count: ждут } = await admin
      .from("claude_tasks").select("id", { count: "exact", head: true })
      .eq("user_id", uid).in("status", ["new", "processing"]);
    const { data: последнее } = await admin
      .from("claude_tasks").select("done_at")
      .eq("user_id", uid).eq("status", "done")
      .order("done_at", { ascending: false }).limit(1).maybeSingle();
    const { data: здоровье } = await admin
      .from("worker_health").select("reason, detail, happened_at")
      .eq("id", 1).maybeSingle();

    const мин = (iso: string | null) =>
      iso ? Math.round((Date.now() - new Date(iso).getTime()) / 60000) : null;
    const ждётМин = мин(очередь?.[0]?.created_at ?? null);
    const отвечалМин = мин(последнее?.done_at ?? null);

    const строки: string[] = [];
    строки.push(ждут ? `В очереди: ${ждут}, старшее ждёт ${ждётМин} мин.` : "В очереди пусто.");
    строки.push(отвечалМин === null
      ? "Дежурный ещё ни разу не отвечал."
      : `Дежурный отвечал ${отвечалМин} мин назад.`);

    const болен = здоровье?.reason && здоровье.reason !== "ok";
    if (болен) {
      строки.push("");
      строки.push(`⚠️ ${здоровье.detail}`);
      строки.push(здоровье.reason === "vpn"
        ? "Поднимите v2rayN и включите TUN."
        : здоровье.reason === "auth"
          ? "Подойдите к компьютеру и нажмите «Войти в Claude» на рабочем столе."
          : здоровье.reason === "limit"
            ? "Ничего чинить не нужно: задание сохранено и продолжится после сброса лимита."
            : "Проверьте компьютер и сообщение дежурного.");
    } else if ((ждут ?? 0) > 0 && (ждётМин ?? 0) > 20) {
      строки.push("");
      строки.push("⚠️ Задание висит дольше обычного, а причина неизвестна. " +
        "Проверьте, включён ли компьютер.");
    } else {
      строки.push("");
      строки.push("✅ Всё работает.");
    }
    reply = "🩺 Как дела" + СТРОКА + СТРОКА + строки.join(СТРОКА);
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
    // Ссылка на YouTube-шортс — не задание, а публикация: Татьяна выложила
    // ролик руками и прислала адрес. Регистрируем его в учёте, и дальше
    // расписание само снимает просмотры читательским ключом.
    const текст = msg.text.trim();
    const ютуб = текст.match(/(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)[A-Za-z0-9_-]{11}/);
    if (ютуб) {
      const р = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/shorts-stats`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: текст, user_id: uid }),
      }).then((x) => x.json()).catch(() => null);
      reply = р?.ok
        ? `Шорт принят на учёт: «${р.title ?? "без названия"}».` + СТРОКА + СТРОКА +
          `Сейчас у него ${р.views ?? 0} просмотров. Числа буду снимать сам ` +
          `каждые несколько часов — когда наберётся несколько роликов, станет ` +
          `видно, что заходит вашей аудитории.`
        : `Ссылку вижу, но записать не смог: ${р?.error ?? "нет ответа"}. ` +
          `Проверьте, что ролик открыт для всех.`;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: msg.chat.id, text: reply }),
      }).catch(() => {});
      return;
    }
    await admin.from("claude_tasks").insert({ user_id: uid, text: текст });
    // Подсказка про кнопку — только когда ролик правда ждёт решения. Иначе
    // Татьяна отвечает на вопрос про реплики, а бот заговаривает про замер.
    const { data: ждёт } = await admin
      .from("incoming_videos").select("tag, name")
      .eq("user_id", uid).eq("status", "new").is("hook", null)
      .not("measure_avg", "is", null)
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();
    // Ответ обязан говорить ровно две вещи: что записано и нужно ли что-то от
    // неё. 8 августа он писал «нажмите кнопку под его замером» — и Татьяна не
    // поняла, какую кнопку и где её искать. Просьбу к ней оставляем только
    // тогда, когда без неё действительно нельзя, и говорим, где кнопка.
    reply = "Записал. Промт напишу и пришлю сюда — от вас ничего не нужно." +
      (ждёт
        ? `\n\nЕсли это было про ролик «${ждёт.tag ?? ждёт.name}» — ничего не ` +
          `делайте, я и так отнесу замечание к нему. Кнопки под замером нужны ` +
          `только чтобы сказать «годится» и повесить титры.`
        : "");
  }

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: msg.chat.id,
      text: reply,
      // Постоянное меню-клавиатура под полем ввода
      reply_markup: ownerKeyboard(targetPlatform),
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

/**
 * Кнопки «Годится» / «Не годится» под замером.
 *
 * Раньше замечание Татьяны привязывалось к ролику по времени: берётся тот,
 * что пришёл в последние 20 минут. Она справедливо спросила — а к какому
 * ролику это будет правка? Теперь ролик назван прямо в кнопке, и бот
 * запоминает его до следующего сообщения.
 */
async function решениеПоРолику(
  admin: SupabaseClient,
  cq: { id: string; data: string; from: { id: number }; message?: { chat: { id: number } } },
) {
  const части = String(cq.data).split(":");
  const выборЗаголовка = части[0] === "hk";
  const что = выборЗаголовка ? "hook" : части[1];
  const videoId = выборЗаголовка ? части[1] : части[2];
  const номер = выборЗаголовка ? Number(части[2]) : -1;
  const { data: profile } = await admin
    .from("profiles").select("id, error_notify_bot_id")
    .eq("error_notify_tg_id", String(cq.from.id)).maybeSingle();
  if (!profile) return;

  const { data: bot } = await admin
    .from("bots").select("token_secret_id").eq("id", profile.error_notify_bot_id).maybeSingle();
  const { data: token } = await admin
    .rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });
  const { data: ролик } = await admin
    .from("incoming_videos")
    .select("tag,name,hook_options,idea_id,target_platform,causal_pattern")
    .eq("id", videoId).maybeSingle();
  const кто = ролик?.tag || ролик?.name || "ролик";
  const варианты: string[] = ролик?.hook_options ?? [];

  // «Другие пять» — новые варианты придумывает отдельная функция.
  if (выборЗаголовка && части[2] === "more") {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cq.id, text: "Придумываю…" }),
    }).catch(() => {});
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/hook-options`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ video_id: videoId, chat_id: cq.message?.chat.id ?? cq.from.id }),
    }).catch(() => {});
    return;
  }

  if (выборЗаголовка) {
    const заголовок = (варианты[номер] ?? "").trim();
    await admin.from("incoming_videos").update({
      hook: заголовок,
      name: `${кто} — ${заголовок}`,
      status: "new", rework_note: null, rework_at: null,
      ready: true, owner_accepted_at: new Date().toISOString(),
    }).eq("id", videoId);
    await admin.from("profiles")
      .update({ awaiting_video_id: null, awaiting_kind: null }).eq("id", profile.id);
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cq.id }),
    }).catch(() => {});
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cq.message?.chat.id ?? cq.from.id,
        text: `Заголовок в кадре: «${заголовок.toUpperCase()}». Вешаю титры.`,
      }),
    }).catch(() => {});
    return;
  }

  // «🔊 Поправь звук» — беда в озвучке, а не в картинке.
  //
  // Раньше выбор был только «годится» или «не годится», и второе всегда
  // означало новый промт. Но чаще всего испорчено одно слово или ударение:
  // у лобстера вместо «крепкий» звучало «креп». Переснимать ради этого —
  // сжечь генерацию и потерять картинку, которая уже понравилась.
  if (что === "snd") {
    await admin.from("profiles").update({
      awaiting_video_id: videoId, awaiting_kind: "sound", awaiting_task: false,
    }).eq("id", profile.id);
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cq.id }),
    }).catch(() => {});
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cq.message?.chat.id ?? cq.from.id,
        text: `Ролик «${кто}»: что не так со звуком?

` +
          `Напишите следующим сообщением — какое слово проглочено или где ` +
          `неверное ударение. Промт переписывать не буду: возьму это слово из ` +
          `прошлого дубля и пересажу, картинку не трону.`,
      }),
    }).catch(() => {});
    return;
  }

  // «🔁 Переписывай сам» — Татьяне нечего добавить, промт целиком на Claude.
  // Отдельная кнопка нужна затем, что раньше выбор был из двух: либо принять
  // плохой ролик, либо печатать замечание. Молчание при этом ничего не
  // значило, и промт мог не переписать никто.
  if (что === "self") {
    // Приёмник сам заводит задание, как только видит замер ниже нормы. Если
    // после этого нажать «Переписывай сам», на один ролик повиснет два задания
    // об одном и том же — 10.09.2026 заказчица получила ровно это. Второе не
    // заводим, просто подтверждаем, что дело уже в работе.
    const { data: ужеЕсть } = await admin.from("claude_tasks")
      .select("id").eq("video_id", videoId).in("status", ["new", "in_progress", "rework"])
      .ilike("text", "%промт%").limit(1);
    if (!ужеЕсть?.length) {
      await admin.from("claude_tasks").insert({
        user_id: profile.id, video_id: videoId, idea_id: ролик?.idea_id ?? null,
        text: `Ролик «${кто}»: переписать промт самому. Своих пожеланий у Татьяны нет — ` +
          `разбери замер по секундам, найди провал и почини его.` + trustedVideoContext(ролик),
      });
    }
    // Ролик НЕ помечаем доделкой. Задание с внятным текстом уже создано выше,
    // а пометка без пояснения — пустая строка «ДОДЕЛКА … <ничего>» в списке:
    // отличить её от случайного нажатия невозможно, и она висит, топя под собой
    // настоящие замечания. Одно действие — одна запись.
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cq.id, text: "Переписываю" }),
    }).catch(() => {});
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cq.message?.chat.id ?? cq.from.id,
        text: `Ролик «${кто}»: переписываю промт сам. От вас ничего не нужно — ` +
          `пришлю сюда готовый блок и напишу, что именно поменял.`,
      }),
    }).catch(() => {});
    return;
  }

  await admin.from("profiles").update({
    awaiting_video_id: videoId,
    awaiting_kind: что === "ok" ? "name" : "note",
    awaiting_task: false,
  }).eq("id", profile.id);

  // Заголовок придумывает Claude, Татьяна только выбирает. Печатать ей
  // ничего не нужно — но свой вариант всегда можно прислать текстом.
  const естьВарианты = что === "ok" && варианты.length > 0;
  const текст = что !== "ok"
    ? `Ролик «${кто}»: расскажите, что хотите.

Напишите следующим сообщением — что не нравится или каким должен быть кадр. ` +
      `Перепишу промт по-вашему. Титры пока не вешаю.`
    : естьВарианты
    ? `Ролик «${кто}» годится. Выберите заголовок в кадр:

` +
      варианты.map((h, i) => `${i + 1}. ${h.toUpperCase()}`).join("\n") +
      `

Не нравится ни один — жмите «Другие пять» или пришлите свой текстом.`
    // Готовых вариантов нет — придумываем прямо сейчас, а не просим её печатать.
    // Заголовок придумывает Claude, Татьяна только выбирает: это её правило, и
    // 9 августа бот его нарушил именно здесь.
    : `Ролик «${кто}» годится. Придумываю пять заголовков, пришлю через минуту.`;

  if (что === "ok" && !естьВарианты) {
    fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/hook-options`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ video_id: videoId }),
    }).catch(() => {});
  }

  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cq.id }),
  }).catch(() => {});
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: cq.message?.chat.id ?? cq.from.id, text: текст,
      ...(естьВарианты
        ? {
          reply_markup: {
            inline_keyboard: [
              варианты.slice(0, 3).map((_, i) => ({
                text: String(i + 1), callback_data: `hk:${videoId}:${i}`,
              })),
              варианты.slice(3).map((_, i) => ({
                text: String(i + 4), callback_data: `hk:${videoId}:${i + 3}`,
              })),
              // Ни один не подошёл — Claude придумывает пять новых.
              [{ text: "🔄 Другие пять", callback_data: `hk:${videoId}:more` }],
            ],
          },
        }
        : {}),
    }),
  }).catch(() => {});
}

async function решениеПоПлатформе(
  admin: SupabaseClient,
  cq: { id: string; data: string; from: { id: number }; message?: { chat: { id: number } } },
) {
  const selected = normalizeTargetPlatform(String(cq.data).split(":")[1]);
  const { data: profile } = await admin.from("profiles")
    .select("id,error_notify_bot_id")
    .eq("error_notify_tg_id", String(cq.from.id)).maybeSingle();
  if (!profile?.error_notify_bot_id) return;
  const { data: bot } = await admin.from("bots").select("token_secret_id")
    .eq("id", profile.error_notify_bot_id).maybeSingle();
  const { data: token } = await admin.rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });
  if (!token) return;

  await admin.from("profiles").update({
    target_platform: selected,
    active_video_idea_id: null,
  }).eq("id", profile.id);
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cq.id, text: `Выбрано: ${platformLabel(selected)}` }),
  }).catch(() => {});
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: cq.message?.chat.id ?? cq.from.id,
      text: `🎯 Сейчас: ${platformLabel(selected)}`,
      reply_markup: ownerKeyboard(selected),
    }),
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
      // Кнопки «Годится» / «Не годится» под замером. Разбираем здесь: они
      // только запоминают, о каком ролике пойдёт речь дальше, — чтобы
      // следующее сообщение Татьяны не приходилось привязывать по времени.
      const данные = String(update.callback_query.data ?? "");
      if (данные.startsWith("pf:")) {
        await решениеПоПлатформе(admin, update.callback_query);
        return json(200, { ok: true });
      }
      if (данные.startsWith("vid:") || данные.startsWith("hk:")) {
        await решениеПоРолику(admin, update.callback_query);
        return json(200, { ok: true });
      }
      // Остальные нажатия обрабатывают отдельные функции — их можно править,
      // не трогая вебхук. Дайджест новостей помечен префиксом «dg:».
      const дайджест = данные.startsWith("dg:");
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
