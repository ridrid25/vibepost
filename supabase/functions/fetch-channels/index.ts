// fetch-channels: собирает свежие посты из каналов-доноров в ленту.
//
// Читаем публичную страницу t.me/s/<канал> — она отдаётся без авторизации,
// ключей и токенов не нужно. Закрытые каналы так не прочитать: для них нужен
// вход под номером телефона, а это риск для аккаунта, и мы туда не лезем.
//
// Ничего не публикуем — только копим сырьё. Дайджест из него пишет отдельная
// функция, и только после одобрения человеком.
import { createClient } from "npm:@supabase/supabase-js@2";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Разбирает страницу канала на посты. Вёрстка простая и годами не меняется. */
function разобрать(html: string): Array<{
  post_id: number;
  text: string;
  link: string;
  published_at: string | null;
}> {
  const посты: Array<{ post_id: number; text: string; link: string; published_at: string | null }> = [];

  // Каждый пост — блок с data-post="канал/номер"; внутри текст и время.
  const блоки = html.split('class="tgme_widget_message ');
  for (const блок of блоки.slice(1)) {
    const ид = блок.match(/data-post="([^"]+)\/(\d+)"/);
    if (!ид) continue;

    const текстБлок = блок.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    );
    if (!текстБлок) continue;

    const текст = текстБлок[1]
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<\/p>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (текст.length < 40) continue;   // подписи к картинкам и служебное — мимо

    const время = блок.match(/datetime="([^"]+)"/);
    посты.push({
      post_id: Number(ид[2]),
      text: текст.slice(0, 2000),
      link: `https://t.me/${ид[1]}/${ид[2]}`,
      published_at: время ? время[1] : null,
    });
  }
  return посты;
}

Deno.serve(async () => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: каналы } = await admin
    .from("news_sources")
    .select("id, user_id, username, last_post_id")
    .eq("enabled", true);
  if (!каналы?.length) return json(200, { ok: true, нечего: true });

  let собрано = 0;
  const отчёт: Record<string, number | string> = {};

  for (const канал of каналы) {
    try {
      const res = await fetch(`https://t.me/s/${канал.username}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) { отчёт[канал.username] = `HTTP ${res.status}`; continue; }

      const посты = разобрать(await res.text())
        .filter((p) => p.post_id > канал.last_post_id);
      if (!посты.length) { отчёт[канал.username] = 0; continue; }

      await admin.from("news_items").upsert(
        посты.map((p) => ({
          user_id: канал.user_id,
          source_id: канал.id,
          post_id: p.post_id,
          text: p.text,
          link: p.link,
          published_at: p.published_at,
        })),
        { onConflict: "source_id,post_id", ignoreDuplicates: true },
      );

      const макс = Math.max(...посты.map((p) => p.post_id));
      await admin.from("news_sources")
        .update({ last_post_id: макс }).eq("id", канал.id);

      отчёт[канал.username] = посты.length;
      собрано += посты.length;
    } catch (e) {
      отчёт[канал.username] = `сбой: ${String((e as Error).message).slice(0, 60)}`;
    }
  }

  // Старьё не копим: непошедшее в дело чистим через трое суток.
  await admin.from("news_items")
    .delete()
    .lt("created_at", new Date(Date.now() - 3 * 86400000).toISOString());

  return json(200, { ok: true, собрано, отчёт });
});
