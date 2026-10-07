// uborka-hranilishcha: ежедневная автоуборка хранилища post-photos.
//
// Правило заказчицы (29.09 и 07.10.2026): файл отклонённого или уже вышедшего
// ролика живёт неделю, потом удаляется; копий не храним. Список берём у
// public.spisok_uborki_hranilishcha() — там вся защита (свежие, manual/,
// карточки в работе, неотправленные посты, задел YouTube, шаблоны, музыка).
// Удаляем через Storage API, чтобы уходил и сам файл, а не только запись.
//
// Предохранитель: в обычные сутки уходит десяток-другой файлов. Если список
// длиннее ПРЕДЕЛ — значит, что-то сломалось в разметке (как 05.10, когда мера
// чуть не снесла ролики её будущих постов). Тогда не удаляем ничего и пишем
// причину в uborka_hranilishcha_log.
//
// Вызов: pg_cron раз в сутки, только с сервисным ключом.
//   supabase.functions.invoke("uborka-hranilishcha", { body: {} })
//   → { kandidatov, udaleno, mb } или { propusk }
import { createClient } from "npm:@supabase/supabase-js@2";

const ПРЕДЕЛ = 120;
const ПАЧКА = 50;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function callerIsService(req: Request, serviceKey: string): boolean {
  const m = (req.headers.get("Authorization") ?? "").match(/^Bearer (.+)$/);
  if (!m) return false;
  if (m[1] === serviceKey) return true;
  const parts = m[1].split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!callerIsService(req, serviceKey)) return json(401, { error: "только сервис" });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  const { data: список, error } = await admin.rpc("spisok_uborki_hranilishcha");
  if (error) return json(500, { error: error.message });
  const пути = (список ?? []) as Array<{ name: string; sz: number; kat: string }>;
  const мб = Math.round(пути.reduce((s, x) => s + Number(x.sz), 0) / 1048576);

  if (пути.length > ПРЕДЕЛ) {
    const propusk = `список ${пути.length} файлов длиннее предела ${ПРЕДЕЛ} — ничего не удалено`;
    await admin.from("uborka_hranilishcha_log").insert({
      kandidatov: пути.length, mb: мб, propusk,
      puti: пути.slice(0, 300).map((x) => [x.name, x.kat]),
    });
    return json(200, { propusk });
  }

  let удалено = 0;
  const ушли: string[] = [];
  for (let i = 0; i < пути.length; i += ПАЧКА) {
    const пачка = пути.slice(i, i + ПАЧКА).map((x) => x.name);
    const { data, error: e } = await admin.storage.from("post-photos").remove(пачка);
    if (e) break;
    for (const d of data ?? []) ушли.push(d.name);
    удалено += (data ?? []).length;
  }

  await admin.from("uborka_hranilishcha_log").insert({
    kandidatov: пути.length, udaleno: удалено, mb: мб, puti: ушли,
  });
  return json(200, { kandidatov: пути.length, udaleno: удалено, mb: мб });
});
