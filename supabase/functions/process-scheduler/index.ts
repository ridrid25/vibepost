// process-scheduler: вызывается pg_cron раз в минуту.
// Единый конвейер для одиночных постов И шагов запущенных цепочек:
// 1. Захват до 25 постов + до 25 шагов (FOR UPDATE SKIP LOCKED в SQL-функциях
//    claim_due_posts / claim_due_chain_steps) со сменой статуса на processing.
//    Шаги цепочек в статусе paused не выбираются.
// 2. Отправка через send-post с общим троттлингом: пауза между отправками,
//    не больше 19 сообщений в один чат за прогон (лимит Telegram ~20/мин).
// 3. Успех → квитанция в post_analytics, затем sent + tg_message_id.
//    Запись статуса с проверкой ошибки и повтором: молча терять её нельзя.
//    Сеть/429/5xx → до 3 попыток; 4xx логики → сразу failed.
// 4. Цепочки, у которых не осталось необработанных шагов, получают done.
// 5. Каждый failed → вызов notify-error (запись в notifications + личный TG).
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendPost, type PostContent, type SendResult } from "./send-post.ts";

const MAX_BATCH = 25;
const MAX_RETRIES = 3;
const PER_CHAT_LIMIT = 19;
const SEND_INTERVAL_MS = 80; // ~12 сообщений/сек — с запасом до лимита 30/сек

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sendWithRetry(
  token: string,
  chatId: string,
  post: PostContent,
): Promise<SendResult> {
  let attempt = 0;
  while (true) {
    const res = await sendPost(token, chatId, post);
    if (res.ok || !res.retryable) return res;
    const waitSec = res.retryAfter ?? Math.pow(2, attempt); // 1s, 2s, ...
    if (attempt >= 2 || waitSec > 10) return res;
    await sleep(waitSec * 1000);
    attempt++;
  }
}

// Запуск только с service-правами: JWT с ролью service_role (подпись уже
// проверил шлюз Supabase) или точное совпадение с ключом окружения.
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

interface QueueItem {
  kind: "post" | "chain_step";
  id: string;
  user_id: string;
  bot_id: string;
  chat_id: string; // uuid чата в нашей БД
  retry_count: number;
  content: PostContent;
  post_id?: string; // только у постов — для post_analytics
}

// Запись статуса — единственное место, где потерянный ответ означает молчаливо
// зависший пост: 10.09.2026 PostgREST вернул 504 на этот PATCH, ошибку никто не
// проверял, и пост навсегда остался в processing — при том что сообщение ушло.
// Поэтому здесь ошибку проверяем и повторяем, а окончательный провал пишем в лог.
async function writeStatus(
  // deno-lint-ignore no-explicit-any
  admin: any,
  tableName: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await admin.from(tableName).update(patch).eq("id", id);
    if (!error) return true;
    if (attempt < 2) await sleep(400 * (attempt + 1));
    else console.error(`Статус не записан: ${tableName} ${id} — ${error.message}`);
  }
  return false;
}

// Ошибка отправки → notify-error (запись в notifications + личный Telegram).
// Сбой уведомления не должен ронять планировщик.
async function notifyError(serviceKey: string, item: QueueItem, message: string) {
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/notify-error`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: item.user_id,
        type: item.kind === "post" ? "post_failed" : "chain_failed",
        message,
      }),
    });
  } catch (_e) {
    // намеренно молчим
  }
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!callerIsService(req, serviceKey)) {
    return json(403, { error: "forbidden" });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const table = (item: QueueItem) => item.kind === "post" ? "posts" : "active_chain_steps";

  // 1. Захват постов и шагов цепочек
  const { data: posts, error: postsError } = await admin
    .rpc("claim_due_posts", { p_limit: MAX_BATCH });
  if (postsError) return json(500, { error: `claim_due_posts: ${postsError.message}` });

  const { data: steps, error: stepsError } = await admin
    .rpc("claim_due_chain_steps", { p_limit: MAX_BATCH });
  if (stepsError) return json(500, { error: `claim_due_chain_steps: ${stepsError.message}` });

  const items: QueueItem[] = [
    ...(posts ?? []).map((p: Record<string, unknown>) => ({
      kind: "post" as const,
      id: p.id as string,
      user_id: p.user_id as string,
      bot_id: p.bot_id as string,
      chat_id: p.chat_id as string,
      retry_count: (p.retry_count as number) ?? 0,
      content: p as unknown as PostContent,
      post_id: p.id as string,
    })),
    ...(steps ?? []).map((s: Record<string, unknown>) => ({
      kind: "chain_step" as const,
      id: s.id as string,
      user_id: s.user_id as string,
      bot_id: s.bot_id as string,
      chat_id: s.chat_id as string,
      retry_count: (s.retry_count as number) ?? 0,
      content: s as unknown as PostContent,
    })),
  ];

  let sent = 0, failed = 0, rescheduled = 0;

  if (items.length > 0) {
    // 2. Справочники: токены ботов и telegram_chat_id чатов
    const botIds = [...new Set(items.map((i) => i.bot_id))];
    const chatIds = [...new Set(items.map((i) => i.chat_id))];

    const { data: bots } = await admin
      .from("bots").select("id, token_secret_id, is_active").in("id", botIds);
    const { data: chats } = await admin
      .from("chats").select("id, telegram_chat_id").in("id", chatIds);

    const tokenByBot = new Map<string, string>();
    for (const bot of bots ?? []) {
      if (!bot.is_active || !bot.token_secret_id) continue;
      const { data: token } = await admin
        .rpc("get_bot_token", { p_secret_id: bot.token_secret_id });
      if (token) tokenByBot.set(bot.id, token);
    }
    const tgChatById = new Map<string, string>(
      (chats ?? []).map((c: { id: string; telegram_chat_id: string }) => [c.id, c.telegram_chat_id]),
    );

    // 3. Отправка
    const perChatCount = new Map<string, number>();

    for (const item of items) {
      const token = tokenByBot.get(item.bot_id);
      const tgChatId = tgChatById.get(item.chat_id);

      if (!token || !tgChatId) {
        const msg = "Бот неактивен/удалён или чат не найден";
        await writeStatus(admin, table(item), item.id, { status: "failed", error: msg });
        await notifyError(serviceKey, item, msg);
        failed++;
        continue;
      }

      const used = perChatCount.get(item.chat_id) ?? 0;
      if (used >= PER_CHAT_LIMIT) {
        await writeStatus(admin, table(item), item.id, { status: "scheduled" });
        rescheduled++;
        continue;
      }
      perChatCount.set(item.chat_id, used + 1);

      const res = await sendWithRetry(token, tgChatId, item.content);

      if (res.ok) {
        // Квитанция пишется ДО статуса: если функция умрёт сразу после отправки,
        // по ней recover_stuck_posts поймёт, что сообщение уже ушло, и починит
        // статус вместо повторной публикации.
        if (res.messageId) {
          await admin.from("post_analytics").upsert(
            {
              post_id: item.kind === "post" ? item.id : null,
              active_chain_step_id: item.kind === "chain_step" ? item.id : null,
              chat_id: item.chat_id,
              tg_message_id: res.messageId,
            },
            { onConflict: "chat_id,tg_message_id", ignoreDuplicates: true },
          );
        }
        await writeStatus(admin, table(item), item.id, {
          status: "sent",
          tg_message_id: res.messageId,
          sent_at: new Date().toISOString(),
          error: null,
        });
        sent++;
      } else if (res.retryable && item.retry_count + 1 < MAX_RETRIES) {
        await writeStatus(admin, table(item), item.id, {
          status: "scheduled",
          retry_count: item.retry_count + 1,
          error: res.error,
        });
        rescheduled++;
      } else {
        await writeStatus(admin, table(item), item.id, {
          status: "failed",
          error: res.error,
          retry_count: item.retry_count + (res.retryable ? 1 : 0),
        });
        const what = item.kind === "post" ? "Пост" : "Шаг цепочки";
        const preview = (item.content.text ?? item.content.poll_question ?? "").slice(0, 80);
        await notifyError(
          serviceKey,
          item,
          `${what} не отправлен.\nПричина: ${res.error}${preview ? `\nТекст: «${preview}…»` : ""}`,
        );
        failed++;
      }

      await sleep(SEND_INTERVAL_MS);
    }
  }

  // 4. Завершённые цепочки → done + «✅ цепочка завершена» владельцу
  const { data: doneChains } = await admin.rpc("finalize_done_chains");
  for (const dc of doneChains ?? []) {
    try {
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/notify-error`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: dc.user_id,
          type: "chain_done",
          title: "✅ VibePost",
          message: `Цепочка «${dc.chain_name}» завершена: отправлено ${dc.steps_sent} из ${dc.steps_total} шагов.`,
        }),
      });
    } catch (_e) {
      // уведомление не должно ронять планировщик
    }
  }

  return json(200, {
    claimed: items.length,
    sent,
    failed,
    rescheduled,
    chains_done: (doneChains ?? []).length,
  });
});
