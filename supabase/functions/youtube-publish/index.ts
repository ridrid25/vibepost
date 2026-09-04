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
  scheduled_at: string;
  attempts: number;
}

// Слоты расписания: по 2 в день, 10:00 и 17:00 МСК (07:00 и 14:00 UTC).
function nextSlot(after: Date): Date {
  for (const hour of [7, 14]) {
    const slot = new Date(Date.UTC(
      after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), hour,
    ));
    if (slot > after && slot > new Date()) return slot;
  }
  const next = new Date(after);
  next.setUTCDate(next.getUTCDate() + 1);
  return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), 7));
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
          // Скрытая заливка заранее: публикует сам YouTube по publishAt.
          // До выхода Татьяна вешает музыку в редакторе Studio.
          privacyStatus: "private",
          publishAt: new Date(item.scheduled_at).toISOString(),
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

async function tellOwner(
  admin: SupabaseClient,
  userId: string,
  text: string,
  button?: { text: string; url: string },
) {
  try {
    const { data: profile } = await admin.from("profiles")
      .select("error_notify_tg_id").eq("id", userId).maybeSingle();
    const token = Deno.env.get("TELEGRAM_TEST_BOT_TOKEN");
    if (!profile?.error_notify_tg_id || !token) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: profile.error_notify_tg_id,
        text,
        ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}),
      }),
    });
  } catch { /* уведомление не должно ронять публикацию */ }
}

function мск(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} в ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Шаг 1. Галочка = ролик сам идёт в очередь. Возврат к поведению до 29.08
  // по слову заказчицы 04.09: «я хочу сама их там увидеть и пустить, а не
  // каждый раз тебе говорить». Ждать музыку из VibePost нечего — её там нет,
  // музыку она вешает в студии по кнопке из бота. Черновикам с прошедшим или
  // занятым слотом даём ближайший свободный: по два в день, 10:00 и 17:00 МСК.
  const { data: drafts } = await admin.from("youtube_publish_queue")
    .select("id, scheduled_at").eq("status", "draft").order("scheduled_at");
  if (drafts?.length) {
    const { data: busyRows } = await admin.from("youtube_publish_queue")
      .select("scheduled_at").in("status", ["scheduled", "processing", "uploaded"]);
    const busy = new Set((busyRows ?? []).map((r) => new Date(r.scheduled_at).getTime()));
    let cursor = new Date();
    for (const d of drafts) {
      let slot = new Date(d.scheduled_at);
      if (slot.getTime() < Date.now() + 3 * 3600_000 || busy.has(slot.getTime())) {
        do { slot = nextSlot(cursor); cursor = slot; } while (busy.has(slot.getTime()));
      }
      busy.add(slot.getTime());
      await admin.from("youtube_publish_queue").update({
        status: "scheduled",
        scheduled_at: slot.toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", d.id);
    }
  }

  // Шаг 1б. Время выхода — двусторонняя связь (заказчица 04.09: «если я меняю
  // время, оно меняется в студии?»). youtube_publish_at — последнее время,
  // о котором мы договорились с YouTube. Разошлись наше время и оно — значит,
  // она передвинула карандашом у нас: отправляем на YouTube. Разошлось время
  // YouTube и оно — передвинула в студии: подтягиваем к нам. Оба — студия главнее.
  const { data: inStudio } = await admin.from("youtube_publish_queue")
    .select("id, account_id, youtube_video_id, scheduled_at, youtube_publish_at")
    .eq("status", "uploaded").not("youtube_video_id", "is", null);
  for (const row of inStudio ?? []) {
    if (!row.account_id) continue;
    try {
      const token = await freshAccessToken(admin, row.account_id);
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=status&id=${row.youtube_video_id}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const st = (await res.json()).items?.[0]?.status;
      if (!st || st.privacyStatus === "public" || !st.publishAt) continue;
      const ytMs = new Date(st.publishAt).getTime();
      const ourMs = new Date(row.scheduled_at).getTime();
      const knownMs = row.youtube_publish_at ? new Date(row.youtube_publish_at).getTime() : ytMs;
      if (ytMs !== knownMs || ourMs === ytMs) {
        // Студия изменила (или всё совпадает) — наша строка следует за ней.
        if (ourMs !== ytMs || row.youtube_publish_at === null) {
          await admin.from("youtube_publish_queue").update({
            scheduled_at: st.publishAt, youtube_publish_at: st.publishAt,
            updated_at: new Date().toISOString(),
          }).eq("id", row.id);
        }
        continue;
      }
      // Изменили у нас — переносим на YouTube.
      const upd = await fetch("https://www.googleapis.com/youtube/v3/videos?part=status", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          id: row.youtube_video_id,
          status: { privacyStatus: "private", publishAt: new Date(ourMs).toISOString(), selfDeclaredMadeForKids: false },
        }),
      });
      if (upd.ok) {
        await admin.from("youtube_publish_queue").update({
          youtube_publish_at: new Date(ourMs).toISOString(), updated_at: new Date().toISOString(),
        }).eq("id", row.id);
      } else {
        console.error("youtube publishAt push failed", { id: row.id, status: upd.status, body: (await upd.text()).slice(0, 200) });
      }
    } catch (e) {
      console.error("youtube time sync failed", { id: row.id, message: String(e).slice(0, 200) });
    }
  }

  // Шаг 2. Залитые скрытыми, чей срок прошёл, — YouTube уже опубликовал сам.
  // RPC атомарно сохраняет известную lineage и только затем меняет status.
  // Ошибка оставляет строку uploaded: следующий вызов повторяет только metadata,
  // а claim ниже никогда не загрузит тот же ролик второй раз.
  const { data: dueRelease, error: dueReleaseError } = await admin
    .from("youtube_publish_queue")
    .select("id, account_id, youtube_video_id")
    .eq("status", "uploaded").lt("scheduled_at", new Date().toISOString());
  if (dueReleaseError) {
    console.error("youtube release scan failed", { code: "YOUTUBE_RELEASE_SCAN_FAILED" });
  }
  for (const candidate of dueRelease ?? []) {
    // Срок по нашим часам — не доказательство выхода: заказчица могла
    // передвинуть publishAt в студии (олень 01.09 «вышел» у нас, оставаясь
    // скрытым до 02.09). Сверяем с YouTube и подтягиваем слот к его времени.
    if (candidate.account_id && candidate.youtube_video_id) {
      try {
        const token = await freshAccessToken(admin, candidate.account_id);
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=status&id=${candidate.youtube_video_id}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const body = await res.json();
        const st = body.items?.[0]?.status;
        if (st && st.privacyStatus !== "public") {
          if (st.publishAt) {
            await admin.from("youtube_publish_queue")
              .update({ scheduled_at: st.publishAt, updated_at: new Date().toISOString() })
              .eq("id", candidate.id);
          }
          continue;
        }
      } catch (e) {
        console.error("youtube status check failed", { id: candidate.id, message: String(e).slice(0, 200) });
        continue;
      }
    }
    const { data, error } = await admin.rpc("release_youtube_publication_lineage", {
      p_queue_id: candidate.id,
    });
    if (error) {
      console.error("youtube release lineage failed", {
        id: candidate.id,
        code: "YOUTUBE_RELEASE_LINEAGE_FAILED",
      });
      continue;
    }
    const row = Array.isArray(data) ? data[0] : null;
    if (!row || row.deduplicated) continue;
    await tellOwner(admin, row.owner_id,
      `Вышел на YouTube: «${row.title}»\nhttps://youtube.com/shorts/${row.youtube_video_id}`);
  }

  // Шаг 3. Заливка в студию — за 48 часов до выхода, скрытым с publishAt.
  const { data: claimed, error: claimError } = await admin
    .rpc("claim_due_youtube_publish", { p_limit: 1 });
  if (claimError) return json(500, { error: claimError.message });
  const item = (Array.isArray(claimed) ? claimed[0] : null) as QueueItem | null;
  if (!item) return json(200, { done: 0, message: "заливать нечего" });

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
        `Не смог залить в студию «${item.title}» после 3 попыток: ${message.slice(0, 200)}`);
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

    // Описание — свойство ролика (31.08): выбранный заказчицей текст на
    // карточке главнее заготовки очереди.
    const itemAny = item as unknown as { incoming_video_id?: string | null };
    if (itemAny.incoming_video_id) {
      const { data: clip } = await admin.from("incoming_videos")
        .select("post_description").eq("id", itemAny.incoming_video_id).maybeSingle();
      if (clip?.post_description) item.description = clip.post_description;
    }

    const accessToken = await freshAccessToken(admin, accountId);
    const video = await downloadVideo(admin, item);
    const youtubeId = await uploadToYouTube(accessToken, item, video);

    await admin.from("youtube_publish_queue").update({
      status: "uploaded",
      youtube_video_id: youtubeId,
      youtube_publish_at: new Date(item.scheduled_at).toISOString(),
      account_id: accountId,
      error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", item.id);

    await tellOwner(
      admin,
      item.user_id,
      `«${item.title}» повесил в студию, выйдет ${мск(item.scheduled_at)}.\n` +
        `Осталось подобрать музыку — кнопка ниже, вкладка «Аудио», сохранить.`,
      // approve_browser_access: без него мобильная студия показывает заглушку
      // «установите приложение» и теряет адрес ролика.
      { text: "🎵 Подобрать музыку", url: `https://studio.youtube.com/video/${youtubeId}/editor?approve_browser_access=true` },
    );
    return json(200, { done: 1, id: item.id, youtube_video_id: youtubeId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("youtube-publish failed", { id: item.id, message: message.slice(0, 300) });
    return await fail(message);
  }
});
