// tiktok-opoznanie: узнаёт, какой карточке завода соответствует ролик в ТикТоке.
//
// Зачем (12.10.2026). Заказчица выкладывает в ТикТок со своими подписями и
// хэштегами, поэтому по тексту ни один из 76 роликов не связался с карточкой, и
// аналитика не видела, какой зверь, какая схема съёмки и какой замер дают
// просмотры. Здесь опознаём по обложке и подписи: Gemini видит обложку (на ней
// обычно наш заголовок в кадре) и список карточек, созданных до выхода ролика.
//
// Пишет в public.tiktok_kartochki. Неопознанные и чужие ролики тоже записывает
// (ne_nash / incoming_video_id null), чтобы не гонять их повторно.
//
// Вызов: pg_cron раз в сутки, только с сервисным ключом.
//   supabase.functions.invoke("tiktok-opoznanie", { body: { limit: 15 } })
//   → { obrabotano, opoznano, ne_nashi, ostalos }
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const REGION = "us-central1";
const MODEL = "gemini-2.5-flash";
const ПОРОГ = 0.6;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function callerIsService(req: Request, serviceKey: string): boolean {
  const m = (req.headers.get("Authorization") ?? "").match(/^Bearer (.+)$/);
  if (!m) return false;
  if (m[1] === serviceKey) return true;
  const parts = m[1].split(".");
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))).role === "service_role";
  } catch {
    return false;
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

function pemToDer(pem: string): ArrayBuffer {
  const raw = atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

const b64url = (data: string | Uint8Array) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function googleToken(admin: SupabaseClient): Promise<{ token: string; project: string }> {
  const { data: raw } = await admin.rpc("get_secret", { p_name: "google_sa_json" });
  if (!raw) throw new Error("В хранилище нет google_sa_json");
  const sa = JSON.parse(raw) as { client_email: string; private_key: string; project_id: string };
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return { token: cachedToken.value, project: sa.project_id };
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key,
    new TextEncoder().encode(header + "." + claims)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: header + "." + claims + "." + b64url(sig),
    }),
  });
  const tok = await res.json();
  if (!tok.access_token) throw new Error("Google не выдал токен");
  cachedToken = { value: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 };
  return { token: tok.access_token, project: sa.project_id };
}

const СХЕМА = {
  type: "OBJECT",
  properties: {
    nomer: { type: "INTEGER", description: "номер карточки из списка; 0 — ни одна не подходит" },
    zver: { type: "STRING", description: "кто на обложке, одним-двумя словами по-русски" },
    uverennost: { type: "NUMBER", description: "уверенность от 0 до 1" },
    poyasnenie: { type: "STRING", description: "по какому признаку узнал, коротко" },
  },
  required: ["nomer", "zver", "uverennost", "poyasnenie"],
};

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!callerIsService(req, serviceKey)) return json(401, { error: "только сервис" });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const body = await req.json().catch(() => ({}));
  const limit = Math.min(Number(body.limit ?? 15), 30);

  const { data: сделано } = await admin.from("tiktok_kartochki").select("external_video_id");
  const есть = new Set((сделано ?? []).map((x) => x.external_video_id as string));

  const { data: снимки, error } = await admin.from("tiktok_raw_video_items")
    .select("user_id, external_video_id, captured_at, cover:raw_payload->>cover_image_url, " +
      "title:raw_payload->>title, ct:raw_payload->>create_time")
    .order("captured_at", { ascending: false }).limit(3000);
  if (error) return json(500, { error: error.message });
  const свежие = new Map<string, Record<string, unknown>>();
  for (const с of (снимки ?? []) as unknown as Array<Record<string, unknown>>) {
    const id = String(с.external_video_id);
    if (!свежие.has(id)) свежие.set(id, с);
  }
  const очередь = [...свежие.values()].filter((с) => !есть.has(String(с.external_video_id)));

  const { data: карточки } = await admin.from("incoming_videos")
    .select("id, user_id, name, review, created_at, prompt")
    .order("created_at", { ascending: false }).limit(1000);

  let obrabotano = 0, opoznano = 0, ne_nashi = 0;
  const { token, project } = await googleToken(admin);
  const адрес = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${REGION}/publishers/google/models/${MODEL}:generateContent`;

  // Неопознаваемые (нет карточек раньше ролика, обложка недоступна) помечаем
  // сразу: иначе они стоят первыми в очереди и загораживают остальные.
  const отметить = (с: Record<string, unknown>, poyasnenie: string, ne_nash: boolean) =>
    admin.from("tiktok_kartochki").upsert({
      external_video_id: String(с.external_video_id), user_id: с.user_id,
      incoming_video_id: null, ne_nash, poyasnenie,
    });
  let попыток = 0;
  for (const с of очередь) {
    if (obrabotano >= limit || попыток >= limit * 3) break;
    попыток++;
    const вышел = new Date(Number(с.ct ?? 0) * 1000);
    // Одна карточка на имя: свежайшая до выхода ролика, с промтом — предпочтительно.
    const поИмени = new Map<string, Record<string, unknown>>();
    for (const к of (карточки ?? []) as Array<Record<string, unknown>>) {
      if (к.user_id !== с.user_id) continue;
      if (new Date(String(к.created_at)) > new Date(вышел.getTime() + 86400000)) continue;
      const имя = String(к.name ?? "").trim();
      const прежняя = поИмени.get(имя);
      if (!прежняя || (!прежняя.prompt && к.prompt)) поИмени.set(имя, к);
    }
    const кандидаты = [...поИмени.values()].slice(0, 250);

    let обложка: Uint8Array | null = null;
    try {
      const r = await fetch(String(с.cover ?? ""));
      if (r.ok) обложка = new Uint8Array(await r.arrayBuffer());
    } catch { /* ссылка протухла — возьмём со следующего снимка */ }
    if (!кандидаты.length) { await отметить(с, "ролик вышел раньше первой карточки завода", true); obrabotano++; ne_nashi++; continue; }
    if (!обложка) {
      const r = await fetch(String(с.cover ?? "")).catch(() => null);
      if (r && r.status === 403) { await отметить(с, "ТикТок не отдаёт обложку (403): ролик удалён или скрыт", false); obrabotano++; }
      continue;
    }

    const список = кандидаты.map((к, i) =>
      `${i + 1}. ${к.name} | ${String(к.review ?? "").replace(/\s+/g, " ").slice(0, 140)}`).join("\n");
    const текст =
      `Это обложка ролика из ТикТока, выложенного ${вышел.toISOString().slice(0, 10)}. ` +
      `Подпись автора: «${String(с.title ?? "").slice(0, 200)}».\n` +
      `Ниже список наших роликов (номер. название карточки — зверь и тема | что было в кадре). ` +
      `На обложке обычно наш 3D-зверь и заголовок темы крупными буквами. Определи, какой ` +
      `из роликов на обложке. Если ни один не подходит или это вообще не наш ролик — nomer 0.\n\n${список}`;

    try {
      const r = await fetch(адрес, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { inlineData: { mimeType: "image/jpeg", data: toBase64(обложка) } },
            { text: текст },
          ] }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: СХЕМА },
        }),
      });
      const d = await r.json();
      if (!r.ok) continue;
      const о = JSON.parse(d.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
      const nomer = Number(о.nomer ?? 0);
      const уверен = Number(о.uverennost ?? 0);
      const карта = nomer > 0 && уверен >= ПОРОГ ? кандидаты[nomer - 1] : null;
      await admin.from("tiktok_kartochki").upsert({
        external_video_id: String(с.external_video_id),
        user_id: с.user_id,
        incoming_video_id: карта ? карта.id : null,
        zver: о.zver ?? null,
        uverennost: уверен,
        ne_nash: nomer === 0,
        poyasnenie: String(о.poyasnenie ?? "").slice(0, 300),
      });
      obrabotano++;
      if (карта) opoznano++;
      if (nomer === 0) ne_nashi++;
    } catch { /* следующий прогон */ }
  }

  return json(200, { obrabotano, opoznano, ne_nashi, ostalos: Math.max(0, очередь.length - obrabotano) });
});
