// veo-start: отправляет одобренные идеи (кнопка 💸) на генерацию в Veo.
//
// Три предохранителя, потому что это живые деньги:
//   1. Без явного согласия (profiles.veo_confirmed_at) не запускается вообще —
//      вместо этого бот присылает смету с кнопкой подтверждения.
//   2. Модель только быстрая: обычная вчетверо дороже.
//   3. Месячный лимит из profiles.veo_month_limit_usd. Упёрлись — бот скажет.
//
// Генерация долгая, поэтому здесь только ставим задание и запоминаем номер
// операции. Забирает готовое отдельная функция veo-poll раз в минуту.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const REGION = "us-central1";
// Лёгкая модель — самая дешёвая из доступных: 8 секунд примерно за 0.4 доллара.
// Быстрая стоит вдвое, обычная — в восемь раз. Дороже лёгкой не берём без
// отдельного разговора: именно обычная модель сожгла 3.2 доллара 31.07.2026.
const МОДЕЛЬ = "veo-3.1-lite-generate-001";
const ЦЕНА_ЗА_РОЛИК = 0.4;
const КУРС = 90; // рублей за доллар, для понятной суммы в сообщении

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

export async function googleToken(admin: SupabaseClient) {
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: profile } = await admin
    .from("profiles")
    .select("id, error_notify_tg_id, error_notify_bot_id, veo_confirmed_at")
    .not("error_notify_tg_id", "is", null).limit(1).maybeSingle();
  if (!profile) return json(200, { ok: true });

  const { data: bot } = await admin
    .from("bots").select("token_secret_id").eq("id", profile.error_notify_bot_id).maybeSingle();
  const { data: token } = await admin
    .rpc("get_bot_token", { p_secret_id: bot?.token_secret_id });
  const tg = (method: string, payload: unknown) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
  const сказать = (text: string, kb?: unknown) =>
    tg("sendMessage", {
      chat_id: profile.error_notify_tg_id, text, parse_mode: "HTML",
      ...(kb ? { reply_markup: kb } : {}),
    });

  // Идеи, одобренные кнопкой 💸 и ещё не отправленные
  const { data: идеи } = await admin
    .from("video_ideas")
    .select("id, slug, hook, line, animal, prompt")
    .eq("user_id", profile.id).eq("status", "approved").eq("route", "paid")
    .order("decided_at").limit(5);
  if (!идеи?.length) return json(200, { ok: true, нечего: true });

  const [траты] = await admin.rpc("veo_spend", { p_user: profile.id })
    .then((r: { data: Array<Record<string, number>> | null }) => r.data ?? [{}]);
  const осталось = Number(траты?.осталось_usd ?? 0);
  const смета = идеи.length * ЦЕНА_ЗА_РОЛИК;

  // Предохранитель 1: без согласия ничего не запускаем
  if (!profile.veo_confirmed_at) {
    await сказать(
      `<b>Смета на генерацию</b>\n\n` +
      `Роликов к генерации: ${идеи.length}\n` +
      `Модель: быстрая (Veo 3.1 Fast)\n` +
      `Примерно ${смета.toFixed(2)} $ — около ${Math.round(смета * КУРС)} ₽\n\n` +
      `Потрачено в этом месяце: ${Number(траты?.за_месяц_usd ?? 0).toFixed(2)} $ ` +
      `из ${Number(траты?.лимит_usd ?? 0).toFixed(2)} $\n\n` +
      `Нажмите, если запускать. Спрошу один раз — дальше буду генерировать ` +
      `сам в пределах лимита.`,
      { inline_keyboard: [[
        { text: "✅ Запускать", callback_data: "veo:on" },
        { text: "🚫 Не надо", callback_data: "veo:off" },
      ]] },
    );
    return json(200, { ok: true, ждём_подтверждения: true });
  }

  // Предохранитель 3: месячный лимит
  if (смета > осталось) {
    await сказать(
      `Остановился: на генерацию нужно ${смета.toFixed(2)} $, а до месячного ` +
      `лимита осталось ${осталось.toFixed(2)} $.\n\n` +
      `Лимит можно поднять — скажите, на сколько.`,
    );
    return json(200, { ok: true, лимит: true });
  }

  const { token: gToken, project } = await googleToken(admin);
  const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${REGION}/publishers/google/models/${МОДЕЛЬ}:predictLongRunning`;

  let запущено = 0;
  for (const идея of идеи) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${gToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          instances: [{ prompt: идея.prompt }],
          parameters: { sampleCount: 1, aspectRatio: "9:16", durationSeconds: 8, resolution: "720p" },
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.name) throw new Error(JSON.stringify(d).slice(0, 200));

      await admin.from("veo_jobs").insert({
        user_id: profile.id, idea_id: идея.id, operation: d.name,
        model: МОДЕЛЬ, status: "running", cost_usd: ЦЕНА_ЗА_РОЛИК,
      });
      await admin.from("video_ideas").update({ status: "generating" }).eq("id", идея.id);
      запущено++;
    } catch (e) {
      await admin.from("video_ideas")
        .update({ error: e instanceof Error ? e.message : String(e) }).eq("id", идея.id);
      await сказать(`Не удалось отправить «${идея.hook}»: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (запущено) {
    await сказать(
      `🎬 Отправил в генерацию: ${запущено} ролик(ов).\n` +
      `Списано примерно ${(запущено * ЦЕНА_ЗА_РОЛИК).toFixed(2)} $ ` +
      `(${Math.round(запущено * ЦЕНА_ЗА_РОЛИК * КУРС)} ₽).\n` +
      `Готовые пришлю сюда через пару минут.`,
    );
  }
  return json(200, { ok: true, запущено });
});
