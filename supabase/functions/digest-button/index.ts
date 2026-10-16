// digest-button: обрабатывает кнопки под утренним дайджестом.
//
// «✅ В канал» ведёт себя по времени:
//   • слот публикации из news_config сегодня ещё впереди — пост встаёт в очередь
//     отложенного постинга, у Татьяны остаётся время передумать, отправкой
//     занимается общий планировщик;
//   • слот на сегодня уже прошёл — публикуем сразу и ЖДЁМ ответ Telegram.
//     Раньше в этом случае пост молча уезжал на завтра, а дайджест помечался
//     «опубликован» — в канале сегодня не появлялось ничего.
//
// Статус дайджеста везде честный: 'posted' ставится только вместе с настоящим
// message_id из ответа Telegram. Не приняли — 'failed' и текст ошибки в
// last_error, кнопки остаются на месте, чтобы можно было попробовать ещё раз.
import { createClient } from "npm:@supabase/supabase-js@2";

const МСК = 3 * 60 * 60 * 1000;
const ПОПЫТОК = 3;

const пауза = (мс: number) => new Promise((r) => setTimeout(r, мс));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Свежих новостей не нашлось: функция вернула нули вместо черновика. */
function itogПусто(итог: { новостей?: number; черновик?: string } | null): boolean {
  return !итог?.черновик;
}

/** Сегодняшний слот публикации (час:минута по МСК) в UTC. Может быть в прошлом. */
function слотСегодня(час: number, минута: number): Date {
  const мск = new Date(Date.now() + МСК);
  return new Date(Date.UTC(
    мск.getUTCFullYear(), мск.getUTCMonth(), мск.getUTCDate(), час, минута, 0,
  ) - МСК);
}

/** «09:30» — время момента по Москве. */
function поМоскве(момент: Date): string {
  const мск = new Date(момент.getTime() + МСК);
  return `${String(мск.getUTCHours()).padStart(2, "0")}:` +
    `${String(мск.getUTCMinutes()).padStart(2, "0")}`;
}

interface Итог {
  ok: boolean;
  messageId?: number;
  error?: string;
}

/**
 * Отправка текста в канал с разбором ответа Telegram. Возвращает только то,
 * что Telegram действительно подтвердил: ok=true и message_id — или ошибку.
 * Сеть, 429 и 5xx повторяем (с учётом retry_after), 4xx логики — сразу отказ.
 */
async function опубликовать(
  token: string,
  чат: string,
  текст: string,
): Promise<Итог> {
  for (let попытка = 0; ; попытка++) {
    let ответ: Response;
    try {
      ответ = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: чат,
          text: текст,
          link_preview_options: { is_disabled: false },
        }),
      });
    } catch (e) {
      const msg = `Сетевая ошибка: ${e instanceof Error ? e.message : String(e)}`;
      if (попытка + 1 >= ПОПЫТОК) return { ok: false, error: msg };
      await пауза(Math.pow(2, попытка) * 1000);
      continue;
    }

    const tg = await ответ.json().catch(() => null);
    if (tg?.ok) return { ok: true, messageId: tg.result?.message_id };

    const код: number = tg?.error_code ?? ответ.status;
    const текстОшибки: string = tg?.description ?? "неизвестная ошибка Telegram";
    const повторить = код === 429 || код >= 500;
    if (!повторить || попытка + 1 >= ПОПЫТОК) {
      return { ok: false, error: `Telegram ${код}: ${текстОшибки}` };
    }
    const ждать = tg?.parameters?.retry_after ?? Math.pow(2, попытка);
    if (ждать > 10) return { ok: false, error: `Telegram ${код}: ${текстОшибки}` };
    await пауза(ждать * 1000);
  }
}

Deno.serve(async (req) => {
  const { callback } = await req.json().catch(() => ({ callback: null }));
  if (!callback?.data) return json(200, { ok: true });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const [, действие, id] = String(callback.data).split(":");

  const { data: черновик } = await admin
    .from("news_digests")
    .select("id, user_id, text, status, tg_message_id, post_id")
    .eq("id", id).maybeSingle();
  if (!черновик) return json(200, { ok: false, причина: "черновик не найден" });

  const { data: cfg } = await admin
    .from("news_config")
    .select("bot_id, chat_id, post_hour, post_minute, digest_mode")
    .eq("user_id", черновик.user_id).maybeSingle();
  if (!cfg) return json(200, { ok: false, причина: "нет настроек" });

  const { data: bot } = await admin
    .from("bots").select("token_secret_id, is_active").eq("id", cfg.bot_id).maybeSingle();
  const { data: token } = await admin
    .rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });

  const ответить = (text: string) =>
    fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callback.id, text }),
    });

  // Кнопки убираем, чтобы нельзя было нажать дважды. При неудаче не убираем:
  // Татьяна должна иметь возможность попробовать ещё раз.
  const снятьКнопки = (подпись: string) =>
    fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        text: `${черновик.text}\n\n— — —\n${подпись}`,
      }),
    });

  // Идемпотентность: дошедший до канала дайджест не публикуем второй раз,
  // даже если кнопку нажали повторно или Telegram продублировал callback.
  if (черновик.tg_message_id) {
    await ответить("Уже в канале");
    return json(200, { ok: true, повтор: true, tg_message_id: черновик.tg_message_id });
  }
  // 'failed' — единственный статус, из которого разрешён повтор.
  if (черновик.status !== "draft" && черновик.status !== "failed") {
    await ответить("Уже решено");
    return json(200, { ok: true, повтор: true });
  }

  if (действие === "no") {
    await admin.from("news_digests")
      .update({ status: "skipped", decided_at: new Date().toISOString() })
      .eq("id", черновик.id);
    await снятьКнопки("🗑 Не пошло");
    await ответить("Ищу другие новости");

    // Отказ — не конец разговора: собираем следующий дайджест из тех новостей,
    // что ещё не шли в дело, и присылаем сразу же.
    const ещё = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/write-digest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    const итог = await ещё.json().catch(() => null);

    // Новостей не осталось — молчать нельзя, иначе выглядит как поломка.
    if (итог?.мало || itogПусто(итог)) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: callback.message.chat.id,
          text: "Других новостей по вашей теме за сутки не набралось. " +
            "Каналы читаются каждый час — как появятся, пришлю.",
        }),
      });
    }
    return json(200, { ok: true, решение: "мимо", ещё: итог });
  }

  // Режим «по новостям» (16.10.2026): одно нажатие на всю подборку — до шести
  // отдельных постов, каждый со своей обложкой от Контент-завода. Пока режим
  // 'single' (по умолчанию), эта ветка не работает и всё идёт как раньше.
  if (действие === "ok" && cfg.digest_mode && cfg.digest_mode !== "single") {
    const { data: план, error } = await admin.rpc("digest_approve_items", { p_digest_id: черновик.id });
    if (error) {
      await ответить("Не принялось");
      return json(200, { ok: false, причина: error.message });
    }
    const строки = (план ?? []).map((п: { item_order: number; base_slot_at: string; caption_len: number }) =>
      `${п.item_order}. ${поМоскве(new Date(п.base_slot_at))}${п.caption_len > 1024 ? " — текст длиннее 1024, стоп" : ""}`);
    const сухой = cfg.digest_mode === "items_dry" ? " (СУХОЙ ПРОГОН — в канал ничего не уйдёт)" : "";
    await снятьКнопки(`✅ Принято ${строки.length} новостей${сухой}. Жду обложки.
Сетка: ${строки.join(", ")}`);
    await ответить(`Принято: ${строки.length} новостей`);
    return json(200, { ok: true, решение: "по новостям", режим: cfg.digest_mode, план });
  }

  if (действие === "ok") {
    const слот = слотСегодня(cfg.post_hour, cfg.post_minute);
    const время = поМоскве(слот);

    // Слот ещё впереди — как и раньше, отдаём посту очередь и планировщику.
    // Статус 'queued': решение принято, но в канале дайджеста пока нет.
    if (слот.getTime() > Date.now()) {
      const { data: пост, error } = await admin.from("posts").insert({
        user_id: черновик.user_id,
        bot_id: cfg.bot_id,
        chat_id: cfg.chat_id,
        format: "text",
        text: черновик.text,
        scheduled_at: слот.toISOString(),
        status: "scheduled",
      }).select("id").single();
      if (error) {
        await ответить("Не встал в очередь");
        return json(200, { ok: false, причина: error.message });
      }

      await admin.from("news_digests").update({
        status: "queued",
        post_id: пост.id,
        last_error: null,
        decided_at: new Date().toISOString(),
      }).eq("id", черновик.id);

      await снятьКнопки(`✅ В очереди на ${время} МСК`);
      await ответить(`Поставил на ${время}`);
      return json(200, { ok: true, решение: "в очередь", когда: слот.toISOString() });
    }

    // Слот на сегодня прошёл. Ждать до завтра бессмысленно — новости протухнут.
    // Публикуем сейчас и статус ставим по ответу Telegram, а не по намерению.
    const { data: чат } = await admin
      .from("chats").select("telegram_chat_id").eq("id", cfg.chat_id).maybeSingle();
    // Выключенный бот — это выключатель владельца. Планировщик такие посты не
    // отправляет (process-scheduler фильтрует по is_active), и прямая отправка
    // не должна становиться лазейкой в обход него.
    if (!token || bot?.is_active === false || !чат?.telegram_chat_id) {
      const причина = "Бот неактивен/удалён или чат не найден";
      await admin.from("news_digests")
        .update({ status: "failed", last_error: причина, decided_at: new Date().toISOString() })
        .eq("id", черновик.id);
      await ответить("Не ушло: нет бота или чата");
      return json(200, { ok: false, причина });
    }

    // Пост заводим до отправки: он и след в истории, и то, что мы правим по итогу.
    // Не завёлся — не отправляем вовсе: иначе сообщение уйдёт в канал, а следа
    // о нём не останется нигде, и «успех» будет нечем подтвердить.
    const { data: пост, error: ошибкаПоста } = await admin.from("posts").insert({
      user_id: черновик.user_id,
      bot_id: cfg.bot_id,
      chat_id: cfg.chat_id,
      format: "text",
      text: черновик.text,
      scheduled_at: new Date().toISOString(),
      status: "processing",
    }).select("id").single();
    if (ошибкаПоста || !пост) {
      const причина = `Не удалось завести пост: ${ошибкаПоста?.message ?? "пустой ответ базы"}`;
      await admin.from("news_digests").update({
        status: "failed",
        last_error: причина,
        decided_at: new Date().toISOString(),
      }).eq("id", черновик.id);
      await ответить("Не ушло: пост не завёлся");
      return json(200, { ok: false, решение: "не ушло", причина });
    }
    await admin.from("news_digests").update({ post_id: пост.id }).eq("id", черновик.id);

    const итог = await опубликовать(token, чат.telegram_chat_id, черновик.text);
    const теперь = new Date().toISOString();

    if (!итог.ok) {
      // Ни при каких условиях не 'posted': в канале ничего нет.
      await admin.from("posts")
        .update({ status: "failed", error: итог.error }).eq("id", пост.id);
      await admin.from("news_digests").update({
        status: "failed",
        last_error: итог.error,
        decided_at: теперь,
      }).eq("id", черновик.id);
      // Кнопки оставляем: неудача — повод попробовать снова, а не тупик.
      await ответить(`Не ушло в канал: ${String(итог.error).slice(0, 150)}`);
      return json(200, { ok: false, решение: "не ушло", причина: итог.error });
    }

    await admin.from("posts").update({
      status: "sent",
      tg_message_id: итог.messageId,
      sent_at: теперь,
      error: null,
    }).eq("id", пост.id);
    if (итог.messageId) {
      await admin.from("post_analytics").upsert(
        {
          post_id: пост.id,
          chat_id: cfg.chat_id,
          tg_message_id: итог.messageId,
        },
        { onConflict: "chat_id,tg_message_id", ignoreDuplicates: true },
      );
    }
    await admin.from("news_digests").update({
      status: "posted",
      tg_message_id: итог.messageId,
      last_error: null,
      decided_at: теперь,
    }).eq("id", черновик.id);

    await снятьКнопки(`✅ Опубликовано в ${поМоскве(new Date())} МСК`);
    await ответить("Опубликовал в канале");
    return json(200, { ok: true, решение: "опубликовано", tg_message_id: итог.messageId });
  }

  return json(200, { ok: true });
});
