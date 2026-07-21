// fetch-rss: автопостинг из RSS/Atom-лент.
// Режимы:
//  - cron (service): по каждому активному источнику берёт новые статьи и
//    ставит их постами в канал. При ПЕРВОЙ проверке ленты просто запоминает
//    текущие статьи (базовая линия), чтобы не вывалить сразу весь архив.
//  - preview (вошедший пользователь): { preview:true, feed_url } →
//    вернуть первые статьи для проверки ленты, без записи.
import { createClient } from "npm:@supabase/supabase-js@2";
import { XMLParser } from "npm:fast-xml-parser@4";

const MAX_PER_RUN = 5;   // не больше 5 новых постов из одной ленты за проверку
const MAX_ITEMS = 40;    // сколько статей ленты рассматриваем

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function callerIsService(req: Request, serviceKey: string): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return false;
  if (m[1] === serviceKey) return true;
  const parts = m[1].split(".");
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))).role === "service_role";
  } catch { return false; }
}

const str = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) return String((v as Record<string, unknown>)["#text"]);
  return String(v);
};

const stripHtml = (s: string) =>
  s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

interface FeedItem { title: string; link: string; desc: string; guid: string; }

async function parseFeed(feedUrl: string): Promise<FeedItem[]> {
  const resp = await fetch(feedUrl, { headers: { "User-Agent": "VibePost/1.0 (+telegram bot)" } });
  const xml = await resp.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const doc = parser.parse(xml);

  const out: FeedItem[] = [];

  // RSS 2.0
  const channel = doc?.rss?.channel;
  if (channel) {
    const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
    for (const it of items) {
      const title = stripHtml(str(it.title));
      const link = str(it.link);
      const guid = str(it.guid) || link || title;
      const desc = stripHtml(str(it.description));
      if (title || link) out.push({ title, link, desc, guid });
    }
  }

  // Atom
  const feed = doc?.feed;
  if (feed) {
    const entries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];
    for (const e of entries) {
      const title = stripHtml(str(e.title));
      let link = "";
      if (Array.isArray(e.link)) {
        const alt = e.link.find((l: Record<string, unknown>) => l["@_rel"] === "alternate") ?? e.link[0];
        link = str(alt?.["@_href"]);
      } else if (e.link) {
        link = str(e.link["@_href"] ?? e.link);
      }
      const guid = str(e.id) || link || title;
      const desc = stripHtml(str(e.summary) || str(e.content));
      if (title || link) out.push({ title, link, desc, guid });
    }
  }

  return out.slice(0, MAX_ITEMS);
}

function buildPost(item: FeedItem, includeDesc: boolean, includeLink: boolean): string {
  const lines: string[] = [item.title];
  if (includeDesc && item.desc) {
    const d = item.desc.length > 300 ? item.desc.slice(0, 300).trimEnd() + "…" : item.desc;
    lines.push("", d);
  }
  if (includeLink && item.link) lines.push("", `🔗 ${item.link}`);
  return lines.join("\n");
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const body = await req.json().catch(() => ({}));

  // Предпросмотр ленты — для любого вошедшего пользователя
  if (body?.preview) {
    if (typeof body.feed_url !== "string" || !body.feed_url) return json(400, { error: "Укажите feed_url" });
    try {
      const items = await parseFeed(body.feed_url);
      if (items.length === 0) return json(200, { items: [], note: "Лента прочитана, но статей не найдено. Проверьте ссылку." });
      return json(200, { items: items.slice(0, 5).map((i) => ({ title: i.title, link: i.link })) });
    } catch (e) {
      return json(400, { error: `Не удалось прочитать ленту: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  if (!callerIsService(req, serviceKey)) return json(403, { error: "forbidden" });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  const { data: sources } = await admin.from("rss_sources").select("*").eq("is_active", true);
  let postedTotal = 0;

  for (const src of sources ?? []) {
    let items: FeedItem[];
    try {
      items = await parseFeed(src.feed_url);
    } catch (_e) {
      await admin.from("rss_sources").update({ last_checked_at: new Date().toISOString() }).eq("id", src.id);
      continue;
    }

    // Уже виденные guid этого источника
    const { data: seenRows } = await admin
      .from("rss_seen_items").select("guid").eq("source_id", src.id).limit(1000);
    const seen = new Set((seenRows ?? []).map((r: { guid: string }) => r.guid));
    const firstRun = seen.size === 0;

    // Новые статьи в хронологическом порядке (старые → новые)
    const fresh = items.filter((i) => !seen.has(i.guid)).reverse();

    if (firstRun) {
      // Базовая линия: запоминаем всё, не постим
      if (items.length > 0) {
        await admin.from("rss_seen_items").insert(items.map((i) => ({ source_id: src.id, guid: i.guid })));
      }
      await admin.from("rss_sources").update({ last_checked_at: new Date().toISOString() }).eq("id", src.id);
      continue;
    }

    let posted = 0;
    for (const item of fresh) {
      if (posted >= MAX_PER_RUN) break;
      const text = buildPost(item, src.include_desc, src.include_link);
      await admin.from("posts").insert({
        user_id: src.user_id, bot_id: src.bot_id, chat_id: src.chat_id,
        format: "text", text, scheduled_at: new Date().toISOString(), status: "scheduled",
        disable_link_preview: false,
      });
      await admin.from("rss_seen_items").insert({ source_id: src.id, guid: item.guid });
      posted++;
      postedTotal++;
    }
    // Остальные новые (сверх лимита) тоже отметим виденными, чтобы не копить хвост
    for (const item of fresh.slice(posted)) {
      await admin.from("rss_seen_items").upsert(
        { source_id: src.id, guid: item.guid }, { onConflict: "source_id,guid", ignoreDuplicates: true });
    }
    await admin.from("rss_sources").update({ last_checked_at: new Date().toISOString() }).eq("id", src.id);
  }

  return json(200, { posted: postedTotal });
});
