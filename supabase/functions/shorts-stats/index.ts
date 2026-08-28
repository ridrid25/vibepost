// shorts-stats: учёт опубликованных шортсов Татьяны и съём их чисел.
//
// Публикация пока ручная (привязка канала отложена сознательно), поэтому
// регистрация — по ссылке, которую Татьяна присылает боту. Числа снимаются
// читательским ключом YouTube Data API v3: её шортсы публичные, разрешений
// не нужно.
//
// Вызовы:
//   POST { url: "https://youtube.com/shorts/..." , user_id } — записать шорт
//   POST { poll: true }                                      — снять числа всем
//
// Опрос дёшев: один запрос videos.list на до 50 роликов = 1 единица квоты
// из 10 000 суточных.
import { createClient } from "npm:@supabase/supabase-js@2";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

/** 11-значный номер ролика из любой формы ссылки YouTube. */
export function youtubeId(текст: string): string | null {
  const m = String(текст).match(
    /(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
  );
  return m ? m[1] : null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const ключ = Deno.env.get("YOUTUBE_API_KEY");
  if (!ключ) return json(500, { error: "YOUTUBE_API_KEY не настроен" });

  const body = await req.json().catch(() => ({}));

  // ── регистрация нового шорта по ссылке ──────────────────────────────────
  if (body.url) {
    const id = youtubeId(body.url);
    if (!id) return json(400, { error: "в ссылке не нашлось номера ролика" });

    // Сразу спрашиваем YouTube: существует ли, как называется, когда вышел.
    const r = await fetch(
      "https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics" +
      `&id=${id}&key=${ключ}`,
    );
    const данные = await r.json();
    const ролик = данные.items?.[0];
    if (!ролик) return json(404, { error: "YouTube такого ролика не знает" });

    const вышел = ролик.snippet?.publishedAt ?? null;
    const просмотров = Number(ролик.statistics?.viewCount ?? 0);
    const часов = вышел
      ? Math.max((Date.now() - new Date(вышел).getTime()) / 3600e3, 0.1)
      : null;

    const { error } = await admin.from("published_shorts").upsert({
      user_id: body.user_id,
      youtube_id: id,
      title: ролик.snippet?.title ?? null,
      published_at: вышел,
      views: просмотров,
      likes: Number(ролик.statistics?.likeCount ?? 0),
      comments: Number(ролик.statistics?.commentCount ?? 0),
      vph: часов ? +(просмотров / часов).toFixed(2) : null,
      last_polled_at: new Date().toISOString(),
      poll_error: null,
    }, { onConflict: "youtube_id" });
    if (error) return json(500, { error: error.message });

    return json(200, {
      ok: true, youtube_id: id,
      title: ролик.snippet?.title, views: просмотров,
    });
  }


  // ── самообслуживание: новые шортсы канала находим сами ──────────────────
  // Адрес канала вставлен один раз в profiles.youtube_channel_id. Дальше
  // Татьяна просто выкладывает — присылать ссылки не нужно: каждые полчаса
  // расписание смотрит свежие загрузки канала и берёт новые на учёт.
  async function подобратьНовыеСКанала() {
    const { data: профили } = await admin
      .from("profiles").select("id, youtube_channel_id")
      .not("youtube_channel_id", "is", null);
    let добавлено = 0;
    for (const п of профили ?? []) {
      const кан = await fetch(
        "https://www.googleapis.com/youtube/v3/channels?part=contentDetails" +
        `&id=${п.youtube_channel_id}&key=${ключ}`,
      ).then((x) => x.json()).catch(() => null);
      const плейлист = кан?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!плейлист) continue;
      const заг = await fetch(
        "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet" +
        `&playlistId=${плейлист}&maxResults=10&key=${ключ}`,
      ).then((x) => x.json()).catch(() => null);
      for (const эл of заг?.items ?? []) {
        const vid = эл.snippet?.resourceId?.videoId;
        if (!vid) continue;
        const { error } = await admin.from("published_shorts").upsert({
          user_id: п.id,
          youtube_id: vid,
          title: эл.snippet?.title ?? null,
          published_at: эл.snippet?.publishedAt ?? null,
        }, { onConflict: "youtube_id", ignoreDuplicates: true });
        if (!error) добавлено++;
      }
    }
    return добавлено;
  }

  // ── плановый съём чисел по всем шортсам ─────────────────────────────────
  if (body.poll) {
    await подобратьНовыеСКанала();
    const { data: шорты } = await admin
      .from("published_shorts").select("id, youtube_id, published_at").limit(50);
    if (!шорты?.length) return json(200, { ok: true, обновлено: 0 });

    const r = await fetch(
      "https://www.googleapis.com/youtube/v3/videos?part=statistics" +
      `&id=${шорты.map((s) => s.youtube_id).join(",")}&key=${ключ}`,
    );
    const данные = await r.json();
    if (!r.ok) return json(502, { error: JSON.stringify(данные).slice(0, 200) });

    const поId = new Map(
      (данные.items ?? []).map((i: { id: string }) => [i.id, i]),
    );
    let обновлено = 0;
    const сейчас = new Date().toISOString();
    for (const s of шорты) {
      const св = поId.get(s.youtube_id) as
        { statistics?: Record<string, string> } | undefined;
      if (!св) {
        await admin.from("published_shorts")
          .update({ poll_error: "ролик пропал из выдачи YouTube", last_polled_at: сейчас })
          .eq("id", s.id);
        continue;
      }
      const просмотров = Number(св.statistics?.viewCount ?? 0);
      const часов = s.published_at
        ? Math.max((Date.now() - new Date(s.published_at).getTime()) / 3600e3, 0.1)
        : null;
      await admin.from("published_shorts").update({
        views: просмотров,
        likes: Number(св.statistics?.likeCount ?? 0),
        comments: Number(св.statistics?.commentCount ?? 0),
        vph: часов ? +(просмотров / часов).toFixed(2) : null,
        last_polled_at: сейчас,
        poll_error: null,
      }).eq("id", s.id);
      await admin.from("published_shorts_stats").insert({
        short_id: s.id,
        views: просмотров,
        likes: Number(св.statistics?.likeCount ?? 0),
        comments: Number(св.statistics?.commentCount ?? 0),
      });
      обновлено++;
    }
    return json(200, { ok: true, обновлено });
  }

  return json(400, { error: "нужен url либо poll" });
});
