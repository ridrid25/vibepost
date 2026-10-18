// digest-covers: единственная дверь Контент-завода в дайджест VibePost.
//
// Контент-завод НЕ получает сервисный ключ Supabase и сам в базу/хранилище не
// пишет. Он знает только свой ключ (Vault: cf_digest_key) и три запроса:
//
//   GET  ?vid=need  → новости, которым нужна обложка
//        [{ publication_id, digest_id, item_id, item_order, text, slot_at, dry_run }]
//   POST ?publication_id=…&cover_id=…&sha256=…   тело: mp4 (Content-Type video/mp4)
//        → { result: "принято" | "повтор" | причина отказа }
//        Файл кладём сами: post-photos/content-factory/digest/<digest>/<order>-<cover>.mp4
//   GET  ?vid=sent  → только подтверждённые Telegram отправки для галереи «В канале»
//        [{ publication_id, digest_id, item_order, cover_id, tg_message_id, sent_at }]
//
// Заголовок: x-cf-key: <ключ>. Источник новостей — ТОЛЬКО одобренная подборка
// VibePost (news_digest_items), не радар Контент-завода.
import { createClient } from "npm:@supabase/supabase-js@2";

const МАКС = 15 * 1024 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function равны(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ключ } = await admin.rpc("get_secret", { p_name: "cf_digest_key" });
  const прислан = req.headers.get("x-cf-key") ?? "";
  if (!ключ || !прислан || !равны(String(ключ), прислан)) return json(401, { error: "нет доступа" });

  const u = new URL(req.url);
  if (req.method === "GET" && u.searchParams.get("vid") === "need") {
    const { data, error } = await admin.from("news_digest_publications")
      .select("id, digest_id, item_id, item_order, base_slot_at, dry_run, news_digest_items(text)")
      .eq("cover_status", "requested").eq("status", "waiting_cover").order("base_slot_at");
    if (error) return json(500, { error: error.message });
    return json(200, (data ?? []).map((p: Record<string, any>) => ({
      publication_id: p.id, digest_id: p.digest_id, item_id: p.item_id, item_order: p.item_order,
      // 18.10: в новости разметка **жирного** для канала — заводу нужен чистый текст
      text: (p.news_digest_items?.text ?? "").replace(/\*\*/g, ""), slot_at: p.base_slot_at, dry_run: p.dry_run,
    })));
  }
  if (req.method === "GET" && u.searchParams.get("vid") === "sent") {
    const { data, error } = await admin.from("news_digest_publications")
      .select("id, digest_id, item_order, cover_id, tg_message_id, sent_at")
      .eq("status", "sent").not("tg_message_id", "is", null).order("sent_at", { ascending: false }).limit(200);
    if (error) return json(500, { error: error.message });
    return json(200, (data ?? []).map((p: Record<string, any>) => ({
      publication_id: p.id, digest_id: p.digest_id, item_order: p.item_order,
      cover_id: p.cover_id, tg_message_id: p.tg_message_id, sent_at: p.sent_at,
    })));
  }
  if (req.method !== "POST") return json(405, { error: "GET ?vid=need|sent или POST" });

  const pid = u.searchParams.get("publication_id") ?? "";
  const cover = (u.searchParams.get("cover_id") ?? "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80);
  const sha = (u.searchParams.get("sha256") ?? "").toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(pid) || !cover || !/^[0-9a-f]{64}$/.test(sha)) {
    return json(400, { error: "нужны publication_id, cover_id, sha256" });
  }
  if (!(req.headers.get("content-type") ?? "").startsWith("video/mp4")) return json(415, { error: "только video/mp4" });
  const тело = new Uint8Array(await req.arrayBuffer());
  if (тело.length < 10_000 || тело.length > МАКС) return json(413, { error: `размер ${тело.length} вне 10 КБ–15 МБ` });
  if ((await sha256hex(тело)) !== sha) return json(422, { error: "sha256 не совпал — файл повреждён в пути" });

  const { data: п } = await admin.from("news_digest_publications")
    .select("digest_id, item_order, post_id, cover_id").eq("id", pid).maybeSingle();
  if (!п) return json(404, { error: "нет такой публикации" });
  if (п.cover_id === cover) return json(200, { result: "повтор" });
  if (п.post_id) return json(409, { result: "пост уже заведён — обложку не меняем" });

  const путь = `content-factory/digest/${п.digest_id}/${п.item_order}-${cover}.mp4`;
  const { error: ош } = await admin.storage.from("post-photos")
    .upload(путь, тело, { contentType: "video/mp4", upsert: false });
  if (ош && !/exists|Duplicate/i.test(ош.message)) return json(500, { error: ош.message });

  const { data: итог, error } = await admin.rpc("digest_cover_ready", {
    p_publication_id: pid, p_cover_id: cover, p_media_path: путь, p_sha256: sha,
  });
  if (error) return json(500, { error: error.message });
  return json(200, { result: итог, media_path: путь });
});
