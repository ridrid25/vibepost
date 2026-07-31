// veo-poll: раз в минуту опрашивает запущенные генерации Veo и забирает готовое.
//
// Главное правило: как только Google отдал ролик — немедленно кладём его
// в наше хранилище. Google держит результат недолго, и полагаться на него
// нельзя (проверено на собственной шкуре 31.07.2026).
//
// Готовый ролик попадает во «Входящие» и дальше идёт по той же дорожке, что
// и ролики, сделанные руками: подпись, время, канал.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const REGION = "us-central1";
const КУРС = 90;
// Если генерация висит дольше — считаем потерянной, чтобы не опрашивать вечно.
const ТЕРПЕНИЕ_МИНУТ = 20;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let cachedToken: { value: string; expiresAt: number } | null = null;

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(body);
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

async function googleToken(admin: SupabaseClient) {
  const { data: raw } = await admin.rpc("get_secret", { p_name: "google_sa_json" });
  if (!raw) throw new Error("В хранилище нет google_sa_json");
  const sa = JSON.parse(raw) as { client_email: string; private_key: string; project_id: string };
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return { token: cachedToken.value, project: sa.project_id };
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(header + "." + claims),
  ));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

/** base64 → байты, кусками: одним махом длинную строку не разобрать. */
function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async () => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: jobs } = await admin
    .from("veo_jobs")
    .select("id, user_id, idea_id, operation, model, created_at, cost_usd")
    .eq("status", "running").limit(5);
  if (!jobs?.length) return json(200, { ok: true, нечего: true });

  const { data: profile } = await admin
    .from("profiles")
    .select("id, error_notify_tg_id, error_notify_bot_id")
    .eq("id", jobs[0].user_id).maybeSingle();
  const { data: bot } = await admin
    .from("bots").select("token_secret_id").eq("id", profile?.error_notify_bot_id).maybeSingle();
  const { data: token } = await admin
    .rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });
  const сказать = (text: string) =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: profile?.error_notify_tg_id, text, parse_mode: "HTML" }),
    }).catch(() => null);

  const { token: gToken, project } = await googleToken(admin);
  let готово = 0;

  for (const job of jobs) {
    const минут = (Date.now() - new Date(job.created_at).getTime()) / 60000;
    try {
      const res = await fetch(
        `https://${REGION}-aiplatform.googleapis.com/v1/projects/${project}` +
        `/locations/${REGION}/publishers/google/models/${job.model}:fetchPredictOperation`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${gToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ operationName: job.operation }),
        },
      );
      const d = await res.json();

      if (!d.done) {
        if (минут > ТЕРПЕНИЕ_МИНУТ) {
          await admin.from("veo_jobs")
            .update({ status: "failed", error: "не завершилась за 20 минут", finished_at: new Date().toISOString() })
            .eq("id", job.id);
          if (job.idea_id) {
            await admin.from("video_ideas").update({ status: "approved" }).eq("id", job.idea_id);
          }
          await сказать("Генерация зависла дольше 20 минут, снял с ожидания. Деньги за неё Google всё равно спишет.");
        }
        continue;
      }

      const байты = d?.response?.videos?.[0]?.bytesBase64Encoded;
      if (!байты) {
        const причина = JSON.stringify(d.error ?? d.response ?? {}).slice(0, 200);
        await admin.from("veo_jobs")
          .update({ status: "failed", error: причина, finished_at: new Date().toISOString() })
          .eq("id", job.id);
        if (job.idea_id) {
          await admin.from("video_ideas").update({ status: "approved", error: причина }).eq("id", job.idea_id);
        }
        await сказать(`Ролик не получился: ${причина}`);
        continue;
      }

      // Забираем немедленно: у Google результат живёт недолго.
      const video = fromBase64(байты);
      const key = `${job.user_id}/incoming/${crypto.randomUUID()}.mp4`;
      const { error: upErr } = await admin.storage.from("post-photos")
        .upload(key, video, { contentType: "video/mp4", upsert: false });
      if (upErr) throw new Error(`не сохранился: ${upErr.message}`);
      const videoUrl = admin.storage.from("post-photos").getPublicUrl(key).data.publicUrl;

      const { data: идея } = job.idea_id
        ? await admin.from("video_ideas").select("hook, line, animal, slug").eq("id", job.idea_id).maybeSingle()
        : { data: null };

      await admin.from("incoming_videos").insert({
        user_id: job.user_id,
        name: идея ? `${идея.animal} — ${идея.hook}` : "Ролик от Veo",
        source: "Veo",
        caption: идея?.line ?? null,
        video_url: videoUrl,
        status: "new",
        ready: Boolean(идея?.line),
      });

      await admin.from("veo_jobs")
        .update({ status: "done", video_url: videoUrl, finished_at: new Date().toISOString() })
        .eq("id", job.id);
      if (job.idea_id) {
        await admin.from("video_ideas").update({ status: "done", video_url: videoUrl }).eq("id", job.idea_id);
      }

      // Показываем ролик сразу в боте — не заставляем открывать приложение
      const form = new FormData();
      form.append("chat_id", String(profile?.error_notify_tg_id));
      form.append("caption",
        `🎬 Готов: ${идея ? идея.hook : "ролик"}\n` +
        `Списано ${Number(job.cost_usd).toFixed(2)} $ (~${Math.round(Number(job.cost_usd) * КУРС)} ₽).\n` +
        `Уже во «Входящих» — осталось поставить время.`);
      form.append("video", new Blob([video], { type: "video/mp4" }), "veo.mp4");
      await fetch(`https://api.telegram.org/bot${token}/sendVideo`, { method: "POST", body: form })
        .catch(() => null);

      готово++;
    } catch (e) {
      await admin.from("veo_jobs")
        .update({ status: "failed", error: e instanceof Error ? e.message : String(e), finished_at: new Date().toISOString() })
        .eq("id", job.id);
      await сказать(`Сбой при получении ролика: ${e instanceof Error ? e.message : e}`);
    }
  }

  return json(200, { ok: true, готово });
});
