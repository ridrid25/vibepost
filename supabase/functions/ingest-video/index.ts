// ingest-video: принимает готовый видеоролик (из внешнего пайплайна озвучки)
// и создаёт ЧЕРНОВИК поста (format='video', status='draft') в VibePost, чтобы
// пользователь сам посмотрел его и назначил чат/время публикации. Черновик
// планировщиком НЕ отправляется (claim_due_posts берёт только 'scheduled').
//
// Вход: multipart/form-data
//   video        — файл mp4 (обязательно)
//   name         — короткое имя, напр. "01-raccoon-inflation" (обязательно)
//   caption      — текст подписи к посту (необязательно)
//   scheduled_at — ISO-время (необязательно; без него — заглушка now()+1ч,
//                  пользователь всё равно правит время в интерфейсе)
//   bot_id       — в какой бот (необязательно; по умолчанию первый бот)
//   chat_id      — в какой чат (необязательно; по умолчанию первый чат бота)
//
// Авторизация: заголовок `Authorization: Bearer <service_role key>` — это
// server-to-server вызов из локального CLI пользователя (ключ хранится в его
// личном .env, в git не попадает).
//
// Ответ 200: { id, video_url, status, bot_id, chat_id }. Ошибка: { error }.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Безопасное имя файла для storage. */
function safeName(name: string): string {
  return (name || "video")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "video";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Используйте POST" });

  try {
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1. Авторизация: только по service_role ключу (server-to-server).
    const auth = req.headers.get("Authorization") ?? "";
    const bearer = auth.replace(/^Bearer\s+/i, "").trim();
    if (!bearer || bearer !== serviceKey) {
      return json(401, { error: "Требуется service_role ключ" });
    }

    // 2. Разбор multipart.
    const form = await req.formData().catch(() => null);
    if (!form) return json(400, { error: "Ожидается multipart/form-data" });

    const video = form.get("video");
    if (!(video instanceof File) || video.size === 0) {
      return json(400, { error: "Нужен файл video (mp4)" });
    }
    const name = safeName(String(form.get("name") ?? "video"));
    const caption = form.get("caption") ? String(form.get("caption")) : null;
    const scheduledAtRaw = form.get("scheduled_at") ? String(form.get("scheduled_at")) : null;
    const wantBotId = form.get("bot_id") ? String(form.get("bot_id")) : null;
    const wantChatId = form.get("chat_id") ? String(form.get("chat_id")) : null;

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

    // 3. Определяем бота (заданный или первый) и его владельца.
    const botQuery = admin.from("bots").select("id, user_id").order("created_at", { ascending: true }).limit(1);
    const { data: bot } = wantBotId
      ? await admin.from("bots").select("id, user_id").eq("id", wantBotId).maybeSingle()
      : await botQuery.maybeSingle();
    if (!bot) return json(404, { error: "Бот не найден. Сначала добавьте бота в VibePost." });

    // 4. Определяем чат (заданный или первый чат этого бота).
    const { data: chat } = wantChatId
      ? await admin.from("chats").select("id").eq("id", wantChatId).eq("bot_id", bot.id).maybeSingle()
      : await admin.from("chats").select("id").eq("bot_id", bot.id).order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (!chat) return json(404, { error: "Чат не найден. Привяжите чат к боту в VibePost." });

    // 5. Загружаем видео в бакет post-photos (в папку владельца).
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const objectPath = `${bot.user_id}/videos/${name}-${ts}.mp4`;
    const bytes = new Uint8Array(await video.arrayBuffer());
    const { error: upErr } = await admin.storage
      .from("post-photos")
      .upload(objectPath, bytes, { contentType: "video/mp4", upsert: true });
    if (upErr) return json(500, { error: `Загрузка видео не удалась: ${upErr.message}` });

    const videoUrl = admin.storage.from("post-photos").getPublicUrl(objectPath).data.publicUrl;

    // 6. Черновик поста (status='draft' — планировщик его не тронет).
    const scheduledAt = scheduledAtRaw ?? new Date(Date.now() + 3600_000).toISOString();
    const { data: post, error: insErr } = await admin
      .from("posts")
      .insert({
        user_id: bot.user_id,
        bot_id: bot.id,
        chat_id: chat.id,
        format: "video",
        video_url: videoUrl,
        text: caption,
        status: "draft",
        scheduled_at: scheduledAt,
      })
      .select("id, status")
      .single();
    if (insErr) return json(500, { error: `Не удалось создать черновик: ${insErr.message}` });

    return json(200, {
      id: post.id,
      video_url: videoUrl,
      status: post.status,
      bot_id: bot.id,
      chat_id: chat.id,
    });
  } catch (e) {
    return json(500, { error: `Внутренняя ошибка: ${e instanceof Error ? e.message : String(e)}` });
  }
});
