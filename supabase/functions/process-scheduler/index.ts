// process-scheduler: вызывается pg_cron раз в минуту.
// 1. Захватывает до 25 постов со scheduled_at <= now() (FOR UPDATE SKIP LOCKED
//    внутри SQL-функции claim_due_posts) и переводит их в processing.
// 2. Отправляет через send-post с троттлингом: пауза между отправками
//    и не больше 19 сообщений в один чат за прогон (лимит Telegram ~20/мин).
// 3. Успех → sent + tg_message_id + строка в post_analytics.
//    Сеть/429/5xx → до 3 попыток (короткий повтор внутри прогона с учётом
//    retry_after, дальше — возврат в очередь на следующую минуту).
//    4xx-ошибки логики → сразу failed с текстом ошибки.
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendPost, type SendResult } from "./send-post.ts";

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
  post: Parameters<typeof sendPost>[2],
): Promise<SendResult> {
  let attempt = 0;
  while (true) {
    const res = await sendPost(token, chatId, post);
    if (res.ok || !res.retryable) return res;
    const waitSec = res.retryAfter ?? Math.pow(2, attempt); // 1s, 2s, ...
    // Долгие паузы внутри прогона не держим — пост вернётся в очередь
    if (attempt >= 2 || waitSec > 10) return res;
    await sleep(waitSec * 1000);
    attempt++;
  }
}

// Разрешаем запуск только с service-правами: либо JWT с ролью service_role
// (подпись уже проверена шлюзом Supabase), либо точное совпадение с ключом
// из окружения функции.
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
  if (!callerIsService(req, serviceKey)) {
    return json(403, { error: "forbidden" });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  const { data: posts, error: claimError } = await admin
    .rpc("claim_due_posts", { p_limit: MAX_BATCH });
  if (claimError) return json(500, { error: `claim_due_posts: ${claimError.message}` });
  if (!posts || posts.length === 0) return json(200, { claimed: 0, sent: 0, failed: 0, rescheduled: 0 });

  // Токены ботов и telegram_chat_id чатов — одним запросом на каждый справочник
  const botIds = [...new Set(posts.map((p: { bot_id: string }) => p.bot_id))];
  const chatIds = [...new Set(posts.map((p: { chat_id: string }) => p.chat_id))];

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

  const perChatCount = new Map<string, number>();
  let sent = 0, failed = 0, rescheduled = 0;

  for (const post of posts) {
    const token = tokenByBot.get(post.bot_id);
    const tgChatId = tgChatById.get(post.chat_id);

    if (!token || !tgChatId) {
      await admin.from("posts")
        .update({ status: "failed", error: "Бот неактивен/удалён или чат не найден" })
        .eq("id", post.id);
      failed++;
      continue;
    }

    // Лимит на чат: лишние возвращаем в очередь, отправятся в следующие минуты
    const used = perChatCount.get(post.chat_id) ?? 0;
    if (used >= PER_CHAT_LIMIT) {
      await admin.from("posts").update({ status: "scheduled" }).eq("id", post.id);
      rescheduled++;
      continue;
    }
    perChatCount.set(post.chat_id, used + 1);

    const res = await sendWithRetry(token, tgChatId, post);

    if (res.ok) {
      await admin.from("posts").update({
        status: "sent",
        tg_message_id: res.messageId,
        sent_at: new Date().toISOString(),
        error: null,
      }).eq("id", post.id);
      if (res.messageId) {
        await admin.from("post_analytics").upsert(
          { post_id: post.id, chat_id: post.chat_id, tg_message_id: res.messageId },
          { onConflict: "chat_id,tg_message_id", ignoreDuplicates: true },
        );
      }
      sent++;
    } else if (res.retryable && post.retry_count + 1 < MAX_RETRIES) {
      await admin.from("posts").update({
        status: "scheduled",
        retry_count: post.retry_count + 1,
        error: res.error,
      }).eq("id", post.id);
      rescheduled++;
    } else {
      await admin.from("posts").update({
        status: "failed",
        error: res.error,
        retry_count: post.retry_count + (res.retryable ? 1 : 0),
      }).eq("id", post.id);
      failed++;
    }

    await sleep(SEND_INTERVAL_MS);
  }

  return json(200, { claimed: posts.length, sent, failed, rescheduled });
});
