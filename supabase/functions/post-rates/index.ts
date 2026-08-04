// post-rates: автопост курсов валют/крипты.
// Источники: ЦБ РФ (cbr-xml-daily.ru) для фиата, CoinGecko для крипты.
// Режимы:
//  - cron (service-права): материализует подошедшие rate_configs в posts.
//  - preview (любой вошедший пользователь): { preview:true, fiat, crypto,
//    crypto_vs, header, show_change } → возвращает готовый текст без записи.
import { createClient } from "npm:@supabase/supabase-js@2";

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

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

const FIAT_LABEL: Record<string, string> = {
  USD: "🇺🇸 Доллар", EUR: "🇪🇺 Евро", CNY: "🇨🇳 Юань", GBP: "🇬🇧 Фунт",
  JPY: "🇯🇵 Иена", CHF: "🇨🇭 Франк", KZT: "🇰🇿 Тенге", TRY: "🇹🇷 Лира", UAH: "🇺🇦 Гривна",
};
const CRYPTO_LABEL: Record<string, string> = {
  bitcoin: "₿ Bitcoin", ethereum: "Ξ Ethereum", ton: "💎 TON", tether: "₮ Tether",
  binancecoin: "🔶 BNB", solana: "◎ Solana", dogecoin: "🐶 Dogecoin", tron: "🅣 TRON",
};

const ru = (n: number, dec = 2) =>
  n.toLocaleString("ru-RU", { minimumFractionDigits: dec, maximumFractionDigits: dec });

async function buildText(cfg: {
  fiat: string[]; crypto: string[]; crypto_vs: string; header?: string | null; show_change?: boolean;
}): Promise<string | null> {
  const dateMsk = new Date(Date.now() + MSK_OFFSET_MS);
  const dd = String(dateMsk.getUTCDate()).padStart(2, "0");
  const mm = String(dateMsk.getUTCMonth() + 1).padStart(2, "0");
  const lines: string[] = [cfg.header?.trim() || `💱 Курсы на ${dd}.${mm}`];

  // Фиат — ЦБ РФ
  if (cfg.fiat?.length) {
    const cbr = await fetch("https://www.cbr-xml-daily.ru/daily_json.js").then((r) => r.json()).catch(() => null);
    if (!cbr?.Valute) return null;
    lines.push("");
    for (const code of cfg.fiat) {
      const v = cbr.Valute[code];
      if (!v) continue;
      const val = v.Value / (v.Nominal || 1);
      let arrow = "";
      if (cfg.show_change !== false && v.Previous) {
        const prev = v.Previous / (v.Nominal || 1);
        // 🔺 и 🔻 — оба красные, поэтому рост выглядел как падение.
        // Зелёный кружок для роста, красный для падения: цвет читается сразу.
        if (val > prev) arrow = ` 🟢 +${ru(val - prev)}`;
        else if (val < prev) arrow = ` 🔴 −${ru(prev - val)}`;
      }
      lines.push(`${FIAT_LABEL[code] ?? code}: ${ru(val)} ₽${arrow}`);
    }
  }

  // Крипта — CoinGecko
  if (cfg.crypto?.length) {
    const ids = cfg.crypto.join(",");
    const vs = cfg.crypto_vs === "rub" ? "rub" : "usd";
    const cg = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${vs}`,
    ).then((r) => r.json()).catch(() => null);
    if (cg) {
      lines.push("");
      const sym = vs === "rub" ? "₽" : "$";
      for (const id of cfg.crypto) {
        const price = cg[id]?.[vs];
        if (typeof price !== "number") continue;
        lines.push(`${CRYPTO_LABEL[id] ?? id}: ${sym}${ru(price, price < 10 ? 2 : 0)}`);
      }
    }
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const body = await req.json().catch(() => ({}));

  // Предпросмотр — для любого вошедшего пользователя (без записи в базу)
  if (body?.preview) {
    const text = await buildText({
      fiat: Array.isArray(body.fiat) ? body.fiat : [],
      crypto: Array.isArray(body.crypto) ? body.crypto : [],
      crypto_vs: body.crypto_vs === "rub" ? "rub" : "usd",
      header: body.header,
      show_change: body.show_change,
    });
    return json(200, { text: text ?? "Не удалось получить курсы. Проверьте выбранные валюты." });
  }

  // Материализация по расписанию — только service
  if (!callerIsService(req, serviceKey)) return json(403, { error: "forbidden" });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  const { data: configs } = await admin
    .from("rate_configs")
    .select("*")
    .eq("is_active", true)
    .not("next_run_at", "is", null)
    .lte("next_run_at", new Date(Date.now() + 2 * 60 * 1000).toISOString());

  let posted = 0;
  for (const cfg of configs ?? []) {
    const text = await buildText(cfg);
    const dueAt = new Date(cfg.next_run_at).getTime();

    if (!text) {
      // источник недоступен: если сильно опоздали — пропускаем день, иначе ждём ретрая
      if (Date.now() > dueAt + 2 * 60 * 60 * 1000) {
        const { data: nn } = await admin.rpc("recurring_compute_next",
          { p_freq: "daily", p_weekdays: null, p_day_of_month: null, p_hour: cfg.hour, p_minute: cfg.minute, p_after: cfg.next_run_at });
        await admin.from("rate_configs").update({ next_run_at: nn }).eq("id", cfg.id);
      }
      continue;
    }

    await admin.from("posts").insert({
      user_id: cfg.user_id, bot_id: cfg.bot_id, chat_id: cfg.chat_id,
      format: "text", text, scheduled_at: cfg.next_run_at, status: "scheduled",
    });
    const { data: nn } = await admin.rpc("recurring_compute_next",
      { p_freq: "daily", p_weekdays: null, p_day_of_month: null, p_hour: cfg.hour, p_minute: cfg.minute, p_after: cfg.next_run_at });
    await admin.from("rate_configs").update({ next_run_at: nn }).eq("id", cfg.id);
    posted++;
  }

  return json(200, { posted });
});
