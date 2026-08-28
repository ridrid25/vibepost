// Воркер публикации на YouTube. Зовёт pg_cron; за один вызов — одно задание
// из очереди (ролик 10–30 МБ, загрузка занимает десятки секунд).
// Захват атомарный: claim_due_youtube_publish ставит processing через
// for update skip locked, двойная загрузка исключена.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { refreshAccessToken } from "../_shared/youtube-oauth.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface QueueItem {
  id: string;
  user_id: string;
  account_id: string | null;
  title: string;
  description: string;
  tags: string[];
  storage_bucket: string | null;
  storage_path: string | null;
  video_url: string | null;
  attempts: number;
}

async function freshAccessToken(admin: SupabaseClient, accountId: string): Promise<string> {
  const { data: bundleRaw, error } = await admin.rpc("get_youtube_token_bundle", {
    p_account_id: accountId,
  });
  if (error || !bundleRaw) throw new Error("token bundle missing");
  const bundle = JSON.parse(bundleRaw as string);
  if (!bundle.refresh_token) throw new Error("refresh_token missing");

  const token = await refreshAccessToken({
    clientId: Deno.env.get("YOUTUBE_OAUTH_CLIENT_ID")!,
    clientSecret: Deno.env.get("YOUTUBE_OAUTH_CLIENT_SECRET")!,
    refreshToken: bundle.refresh_token,
  });
  const { data: account } = await admin.from("youtube_accounts")
    .select("token_generation").eq("id", accountId).single();
  await admin.rpc("store_youtube_token_bundle", {
    p_account_id: accountId,
    p_bundle: JSON.stringify({
      access_token: token.access_token,
      refresh_token: bundle.refresh_token,
    }),
    p_expected_generation: account?.token_generation,
  });
  await admin.from("youtube_accounts").update({
    access_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    auth_status: "active",
    last_error: null,
  }).eq("id", accountId);
  return token.access_token;
}

async function downloadVideo(admin: SupabaseClient, item: QueueItem): Promise<Blob> {
  if (item.storage_bucket && item.storage_path) {
    const { data, error } = await admin.storage.from(item.storage_bucket)
      .download(item.storage_path);
    if (error || !data) throw new Error(`storage download failed: ${error?.message}`);
    return data;
  }
  if (item.video_url) {
    const response = await fetch(item.video_url);
    if (!response.ok) throw new Error(`video url fetch failed: ${response.status}`);
    return await response.blob();
  }
  throw new Error("у задания нет ни storage_path, ни video_url");
}

async function uploadToYouTube(
  accessToken: string,
  item: QueueItem,
  video: Blob,
): Promise<string> {
  const startResponse = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(video.size),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: {
          title: item.title.slice(0, 100),
          description: item.description,
          tags: item.tags?.length ? item.tags : undefined,
          categoryId: "22",
        },
        status: {
          privacyStatus: "public",
          selfDeclaredMadeForKids: false,
        },
      }),
    },
  );
  if (!startResponse.ok) {
    const body = await startResponse.text();
    throw new Error(`resumable start failed: ${startResponse.status} ${body.slice(0, 300)}`);
  }
  const uploadUrl = startResponse.headers.get("Location");
  if (!uploadUrl) throw new Error("resumable start: нет Location");

  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(video.size),
    },
    body: video,
  });
  const putBody = await putResponse.json().catch(() => ({}));
  if (!putResponse.ok || !putBody.id) {
    throw new Error(
      `upload failed: ${putResponse.status} ${JSON.stringify(putBody).slice(0, 300)}`,
    );
  }
  return putBody.id as string;
}

async function tellOwner(admin: SupabaseClient, userId: string, text: string) {
  try {
    const { data: profile } = await admin.from("profiles")
      .select("error_notify_tg_id").eq("id", userId).maybeSingle();
    const token = Deno.env.get("TELEGRAM_TEST_BOT_TOKEN");
    if (!profile?.error_notify_tg_id || !token) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: profile.error_notify_tg_id, text }),
    });
  } catch { /* уведомление не должно ронять публикацию */ }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: claimed, error: claimError } = await admin
    .rpc("claim_due_youtube_publish", { p_limit: 1 });
  if (claimError) return json(500, { error: claimError.message });
  const item = (Array.isArray(claimed) ? claimed[0] : null) as QueueItem | null;
  if (!item) return json(200, { done: 0, message: "очередь пуста" });

  const fail = async (message: string) => {
    // До 3 попыток: сетевые сбои и 5xx Google переживаем, вернув задание в
    // очередь со сдвигом на 30 минут. После третьей — failed и сигнал хозяйке.
    const terminal = item.attempts >= 3;
    await admin.from("youtube_publish_queue").update({
      status: terminal ? "failed" : "scheduled",
      scheduled_at: terminal
        ? undefined
        : new Date(Date.now() + 30 * 60_000).toISOString(),
      error: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("id", item.id);
    if (terminal) {
      await tellOwner(admin, item.user_id,
        `Не смог опубликовать «${item.title}» после 3 попыток: ${message.slice(0, 200)}`);
    }
    return json(200, { done: 0, failed: item.id, error: message.slice(0, 200) });
  };

  try {
    let accountId = item.account_id;
    if (!accountId) {
      const { data: account } = await admin.from("youtube_accounts")
        .select("id").eq("user_id", item.user_id).eq("auth_status", "active")
        .limit(1).maybeSingle();
      if (!account) return await fail("нет активного YouTube-аккаунта");
      accountId = account.id;
    }

    const accessToken = await freshAccessToken(admin, accountId);
    const video = await downloadVideo(admin, item);
    const youtubeId = await uploadToYouTube(accessToken, item, video);

    await admin.from("youtube_publish_queue").update({
      status: "published",
      youtube_video_id: youtubeId,
      account_id: accountId,
      error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", item.id);

    // Свежий шортс сразу на учёт — статистика снимается тем же заводом.
    await admin.from("published_shorts").upsert({
      user_id: item.user_id,
      youtube_id: youtubeId,
      title: item.title,
      published_at: new Date().toISOString(),
    }, { onConflict: "youtube_id", ignoreDuplicates: true });

    await tellOwner(admin, item.user_id,
      `Опубликовал на YouTube: «${item.title}»\nhttps://youtube.com/shorts/${youtubeId}`);
    return json(200, { done: 1, id: item.id, youtube_video_id: youtubeId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("youtube-publish failed", { id: item.id, message: message.slice(0, 300) });
    return await fail(message);
  }
});
