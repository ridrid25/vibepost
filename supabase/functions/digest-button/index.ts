// digest-button: обрабатывает кнопки под утренним дайджестом.
//
// «✅ В канал» не публикует немедленно, а ставит пост в очередь отложенного
// постинга на час из news_config — у Татьяны остаётся время передумать, и
// отправкой занимается общий планировщик, а не эта функция.
import { createClient } from "npm:@supabase/supabase-js@2";

const МСК = 3 * 60 * 60 * 1000;

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

/** Ближайший момент в МСК с заданным часом: сегодня, а если прошёл — завтра. */
function ближайший(час: number, минута: number): string {
  const сейчас = new Date();
  const мск = new Date(сейчас.getTime() + МСК);
  const цель = new Date(Date.UTC(
    мск.getUTCFullYear(), мск.getUTCMonth(), мск.getUTCDate(), час, минута, 0,
  ) - МСК);
  if (цель.getTime() <= сейчас.getTime()) цель.setUTCDate(цель.getUTCDate() + 1);
  return цель.toISOString();
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
    .from("news_digests").select("id, user_id, text, status").eq("id", id).maybeSingle();
  if (!черновик) return json(200, { ok: false, причина: "черновик не найден" });

  const { data: cfg } = await admin
    .from("news_config")
    .select("bot_id, chat_id, post_hour, post_minute")
    .eq("user_id", черновик.user_id).maybeSingle();
  if (!cfg) return json(200, { ok: false, причина: "нет настроек" });

  const { data: bot } = await admin
    .from("bots").select("token_secret_id").eq("id", cfg.bot_id).maybeSingle();
  const { data: token } = await admin
    .rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });

  const ответить = (text: string) =>
    fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callback.id, text }),
    });

  // Кнопки убираем, чтобы нельзя было нажать дважды.
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

  if (черновик.status !== "draft") {
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

  if (действие === "ok") {
    const когда = ближайший(cfg.post_hour, cfg.post_minute);
    const { error } = await admin.from("posts").insert({
      user_id: черновик.user_id,
      bot_id: cfg.bot_id,
      chat_id: cfg.chat_id,
      format: "text",
      text: черновик.text,
      scheduled_at: когда,
      status: "scheduled",
    });
    if (error) {
      await ответить("Не встал в очередь");
      return json(200, { ok: false, причина: error.message });
    }

    await admin.from("news_digests")
      .update({ status: "posted", decided_at: new Date().toISOString() })
      .eq("id", черновик.id);

    const мск = new Date(new Date(когда).getTime() + МСК);
    const время = `${String(мск.getUTCHours()).padStart(2, "0")}:${String(мск.getUTCMinutes()).padStart(2, "0")}`;
    await снятьКнопки(`✅ В очереди на ${время} МСК`);
    await ответить(`Поставил на ${время}`);
    return json(200, { ok: true, решение: "в очередь", когда });
  }

  return json(200, { ok: true });
});
