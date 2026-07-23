// ingest-video: приёмник готовых роликов от внешнего конвейера (Veo и т.п.).
// POST multipart/form-data, защита секретным заголовком X-Ingest-Secret.
// Поля: file (видео) + name, prompt, source, caption (необязательные).
// Кладёт видео в бакет post-photos, создаёт запись incoming_videos
// под владельцем (user_id из Vault). Возвращает { id, video_url }.
// deploy: verify_jwt=false — вызывает внешняя система без Supabase-ключа.
import { createClient } from "npm:@supabase/supabase-js@2";

let cachedSecret: string | null = null;
let cachedOwner: string | null = null;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (!cachedSecret) {
    const { data } = await admin.rpc("get_ingest_secret");
    cachedSecret = data ?? null;
  }
  const header = req.headers.get("x-ingest-secret");
  if (!cachedSecret || header !== cachedSecret) return json(403, { error: "forbidden" });

  if (!cachedOwner) {
    const { data } = await admin.rpc("get_ingest_owner");
    cachedOwner = data ?? null;
  }
  if (!cachedOwner) return json(500, { error: "owner not configured" });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Ожидается multipart/form-data с полем file" });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return json(400, { error: "Поле file обязательно (видеофайл)" });

  const name = String(form.get("name") ?? "").slice(0, 200) || null;
  const prompt = String(form.get("prompt") ?? "").slice(0, 4000) || null;
  const source = String(form.get("source") ?? "").slice(0, 200) || null;
  const caption = String(form.get("caption") ?? "").slice(0, 1024) || null;

  const ext = (file.name?.split(".").pop() ?? "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
  const path = `${cachedOwner}/incoming/${crypto.randomUUID()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: upErr } = await admin.storage.from("post-photos")
    .upload(path, bytes, { contentType: file.type || "video/mp4", upsert: false });
  if (upErr) return json(500, { error: `Загрузка не удалась: ${upErr.message}` });

  const videoUrl = admin.storage.from("post-photos").getPublicUrl(path).data.publicUrl;

  const { data: row, error: insErr } = await admin
    .from("incoming_videos")
    .insert({ user_id: cachedOwner, name, prompt, source, caption, video_url: videoUrl, status: "new" })
    .select("id, video_url")
    .single();
  if (insErr) {
    await admin.storage.from("post-photos").remove([path]);
    return json(500, { error: `Не удалось создать запись: ${insErr.message}` });
  }

  return json(200, { id: row.id, video_url: row.video_url });
});
