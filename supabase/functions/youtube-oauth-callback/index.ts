// Callback Google OAuth для YouTube-публикатора.
// Деплой с verify_jwt=false: Google зовёт этот URL напрямую. Защита — короткий
// одноразовый хэшированный state, как у tiktok-oauth-callback.
import { createClient } from "npm:@supabase/supabase-js@2";
import { exchangeAuthorizationCode, fetchOwnChannel, sha256Hex } from "../_shared/youtube-oauth.ts";

function html(status: number, title: string, message: string): Response {
  const escape = (value: string) => value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>` +
      `<main style="font:16px system-ui;max-width:680px;margin:48px auto;padding:0 20px">` +
      `<h1>${escape(title)}</h1><p>${escape(message)}</p></main>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

async function tellOwner(admin: ReturnType<typeof createClient>, userId: string, text: string) {
  // Подтверждение уходит в Telegram, чтобы Татьяна увидела итог там, где живёт.
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
  } catch (e) {
    console.error("owner notify failed", { message: String(e).slice(0, 200) });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return html(405, "YouTube OAuth", "Ожидается GET callback.");

  const callback = new URL(req.url);
  const rawState = callback.searchParams.get("state");
  if (!rawState) return html(400, "Подключение не выполнено", "Google не вернул OAuth state.");

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const stateHash = await sha256Hex(rawState);
  const { data: consumed, error: stateError } = await admin
    .rpc("consume_youtube_oauth_state", { p_state_hash: stateHash });
  const state = Array.isArray(consumed) ? consumed[0] : null;
  if (stateError || !state) {
    return html(400, "Подключение не выполнено", "OAuth state истёк, уже использован или не совпал.");
  }

  const oauthError = callback.searchParams.get("error");
  if (oauthError) {
    return html(400, "Google не дал доступ", oauthError);
  }
  const code = callback.searchParams.get("code");
  if (!code) return html(400, "Подключение не выполнено", "Google не вернул authorization code.");

  const clientId = Deno.env.get("YOUTUBE_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("YOUTUBE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return html(503, "YouTube OAuth не настроен", "На сервере нет client id или client secret.");
  }

  try {
    const token = await exchangeAuthorizationCode({
      clientId,
      clientSecret,
      code,
      redirectUri: state.redirect_uri,
    });

    const channel = await fetchOwnChannel(token.access_token);
    if (!channel) {
      return html(
        400,
        "Канал не найден",
        "Google дал доступ, но у выбранного аккаунта нет YouTube-канала. " +
          "Начните заново и на шаге выбора аккаунта выберите канал.",
      );
    }

    const scopes = token.scope.split(/\s+/).filter(Boolean);
    const { data: account, error: accountError } = await admin.from("youtube_accounts")
      .upsert({
        user_id: state.user_id,
        channel_id: channel.id,
        channel_title: channel.title,
        scopes,
        access_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        auth_status: "error",
        last_error: "oauth_token_pending",
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,channel_id" })
      .select("id,token_generation").single();
    if (accountError || !account) throw new Error(accountError?.message ?? "account save failed");

    if (!token.refresh_token) {
      // Без refresh_token публикатор умрёт через час. Требуем повторную выдачу.
      const { data: bundle } = await admin.rpc("get_youtube_token_bundle", { p_account_id: account.id });
      if (!bundle || !JSON.parse(bundle as string).refresh_token) {
        await admin.from("youtube_accounts").update({
          auth_status: "reauth_required",
          last_error: "Google не вернул refresh_token",
        }).eq("id", account.id);
        return html(
          400,
          "Нужна повторная авторизация",
          "Google не выдал долгосрочный ключ. Откройте ссылку подключения ещё раз.",
        );
      }
      // Старый refresh_token жив — обновляем только access.
      const old = JSON.parse(bundle as string);
      const { error: secretError } = await admin.rpc("store_youtube_token_bundle", {
        p_account_id: account.id,
        p_bundle: JSON.stringify({ access_token: token.access_token, refresh_token: old.refresh_token }),
        p_expected_generation: account.token_generation,
      });
      if (secretError) throw new Error(`token vault save failed: ${secretError.message}`);
    } else {
      const { error: secretError } = await admin.rpc("store_youtube_token_bundle", {
        p_account_id: account.id,
        p_bundle: JSON.stringify({
          access_token: token.access_token,
          refresh_token: token.refresh_token,
        }),
        p_expected_generation: account.token_generation,
      });
      if (secretError) throw new Error(`token vault save failed: ${secretError.message}`);
    }

    const canUpload = scopes.some((s) => s.endsWith("youtube.upload"));
    await admin.from("youtube_accounts").update({
      auth_status: canUpload ? "active" : "reauth_required",
      last_error: canUpload ? null : "Не выдан scope youtube.upload",
    }).eq("id", account.id);

    if (!canUpload) {
      return html(
        400,
        "Нужна повторная авторизация",
        "Google не выдал право загрузки роликов. Откройте ссылку подключения ещё раз " +
          "и отметьте все галочки доступа.",
      );
    }

    await admin.from("profiles").update({ youtube_channel_id: channel.id }).eq("id", state.user_id);
    await tellOwner(
      admin,
      state.user_id,
      `YouTube-канал «${channel.title}» подключён. Публикатор может выкладывать ролики сам.`,
    );
    return html(
      200,
      "YouTube подключён",
      `Канал «${channel.title}» привязан к VibePost. Эту вкладку можно закрыть — ` +
        "подтверждение уже пришло в Telegram.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("YouTube OAuth callback failed", { message: message.slice(0, 300) });
    return html(502, "Подключение YouTube не завершено", message.slice(0, 300));
  }
});
