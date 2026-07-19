// telegram-webhook: приём обновлений от Telegram (реакции на посты).
// Деплой с verify_jwt=false — Telegram не умеет слать JWT. Вместо этого
// каждый запрос проверяется по секретному заголовку
// X-Telegram-Bot-Api-Secret-Token (задаётся при setWebhook, лежит в Vault).
// message_reaction_count → полная замена счётчиков (анонимные реакции каналов).
// message_reaction → дельта по old/new набору одного пользователя.
// Чужие запросы — 403. Неизвестные обновления подтверждаем 200, иначе
// Telegram будет присылать их снова и снова.
import { createClient } from "npm:@supabase/supabase-js@2";

let cachedSecret: string | null = null;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
    }
  } catch (_e) {
    // Ошибку глотаем сознательно: Telegram при не-200 повторяет доставку,
    // а нам повторы одного и того же обновления не нужны.
  }

  return json(200, { ok: true });
});
