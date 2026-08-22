// ingest-video: приёмник готовых роликов от внешнего конвейера (Veo и т.п.).
// POST multipart/form-data, защита секретным заголовком X-Ingest-Secret.
// Поля: file (видео) + name, prompt, source, caption (необязательные).
// Кладёт видео в бакет post-photos, создаёт запись incoming_videos
// под владельцем (user_id из Vault). Возвращает { id, video_url }.
// deploy: verify_jwt=false — вызывает внешняя система без Supabase-ключа.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const ALLOWED_VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm"]);
const SECRET_DIGEST_TTL_MS = 60_000;
let cachedSecretDigest: Uint8Array | null = null;
let cachedSecretDigestAt = 0;
let secretDigestRefresh: Promise<Uint8Array | null> | null = null;

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const a = left;
  const b = right;
  let different = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    different |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return different === 0;
}

async function configuredSecretDigest(admin: SupabaseClient): Promise<Uint8Array | null> {
  if (cachedSecretDigest && Date.now() - cachedSecretDigestAt < SECRET_DIGEST_TTL_MS) {
    return cachedSecretDigest;
  }
  if (secretDigestRefresh) return await secretDigestRefresh;
  secretDigestRefresh = (async () => {
    const { data } = await admin.rpc("get_ingest_secret");
    if (typeof data !== "string" || !data) return null;
    cachedSecretDigest = await sha256(data);
    cachedSecretDigestAt = Date.now();
    return cachedSecretDigest;
  })();
  try {
    return await secretDigestRefresh;
  } finally {
    secretDigestRefresh = null;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const header = req.headers.get("x-ingest-secret");
  if (!header) return json(403, { error: "forbidden" });
  // Cache only a digest for at most 60 seconds. This prevents unauthenticated
  // requests from amplifying into one Vault read each while keeping secret
  // rotation effective without a redeploy.
  const expectedDigest = await configuredSecretDigest(admin);
  const presentedDigest = await sha256(header);
  if (!expectedDigest || !constantTimeEqual(presentedDigest, expectedDigest)) {
    return json(403, { error: "forbidden" });
  }

  const { data: configuredOwner } = await admin.rpc("get_ingest_owner");
  if (!configuredOwner) return json(500, { error: "owner not configured" });

  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_VIDEO_BYTES + 1024 * 1024) {
    return json(413, { error: "video_too_large" });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Ожидается multipart/form-data с полем file" });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return json(400, { error: "Поле file обязательно (видеофайл)" });
  const ext = (file.name?.split(".").pop() ?? "").toLowerCase();
  if (file.size < 1 || file.size > MAX_VIDEO_BYTES) return json(413, { error: "video_too_large" });
  if (!ALLOWED_VIDEO_TYPES.has(file.type) || !ALLOWED_VIDEO_EXTENSIONS.has(ext)) {
    return json(415, { error: "unsupported_video_type" });
  }

  const name = String(form.get("name") ?? "").slice(0, 200) || null;
  const deliveryId = String(form.get("delivery_id") ?? "").toLowerCase();
  if (deliveryId && !/^[a-f0-9]{64}$/.test(deliveryId)) {
    return json(400, { error: "invalid_delivery_id" });
  }
  const prompt = String(form.get("prompt") ?? "").slice(0, 20_000) || null;
  const source = String(form.get("source") ?? "").slice(0, 200) || null;
  const caption = String(form.get("caption") ?? "").slice(0, 1024) || null;

  if (deliveryId) {
    const { data: existing, error } = await admin.from("incoming_videos")
      .select("id,video_url")
      .eq("user_id", configuredOwner)
      .eq("delivery_id", deliveryId)
      .maybeSingle();
    if (error) return json(500, { error: "delivery_lookup_failed" });
    if (existing) return json(200, { ...existing, deduplicated: true });
  }

  const path = `${configuredOwner}/incoming/${crypto.randomUUID()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: upErr } = await admin.storage.from("post-photos")
    .upload(path, bytes, { contentType: file.type || "video/mp4", upsert: false });
  if (upErr) {
    console.error("VibePost ingest upload failed", { code: upErr.name });
    return json(500, { error: "video_upload_failed" });
  }

  const videoUrl = admin.storage.from("post-photos").getPublicUrl(path).data.publicUrl;

  const { data: row, error: insErr } = await admin
    .from("incoming_videos")
    .insert({
      user_id: configuredOwner,
      delivery_id: deliveryId || null,
      name,
      prompt,
      source,
      caption,
      video_url: videoUrl,
      status: "new",
    })
    .select("id, video_url")
    .single();
  if (insErr) {
    await admin.storage.from("post-photos").remove([path]);
    if (insErr.code === "23505" && deliveryId) {
      const { data: existing } = await admin.from("incoming_videos")
        .select("id,video_url")
        .eq("user_id", configuredOwner)
        .eq("delivery_id", deliveryId)
        .maybeSingle();
      if (existing) return json(200, { ...existing, deduplicated: true });
    }
    console.error("VibePost ingest insert failed", { code: insErr.code });
    return json(500, { error: "incoming_video_create_failed" });
  }

  return json(200, { id: row.id, video_url: row.video_url });
});
