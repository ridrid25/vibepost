import { createClient } from "npm:@supabase/supabase-js@2";
import {
  boundedTelegramApi,
  buildCanaryDeepLink,
  createCanaryToken,
  digestCanaryToken,
  digestText,
  isVerifiedMarkupRemoval,
  readCtaActivationBody,
} from "../_shared/content-factory-leads-canary.mjs";
import { executeCtaActivation } from "../_shared/content-factory-leads-canary-orchestrator.mjs";

type CanaryRun = {
  user_id: string;
  bot_id: string;
  telegram_chat_id: string;
  tg_message_id: number;
  token_id: string;
  state: string;
};
type TelegramApiResponse = { ok?: boolean; result?: unknown };

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
  let rawToken = "";
  let publisherToken = "";
  try {
    const admin = adminClient();
    const bearer = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(
      req.headers.get("authorization") ?? "",
    )?.[1];
    if (!bearer) return json(401, { error: "UNAUTHORIZED" });
    const { data: authData, error: authError } = await admin.auth.getUser(
      bearer,
    );
    if (authError || !authData.user) {
      return json(401, { error: "UNAUTHORIZED" });
    }
    const ownerId = authData.user.id;
    const body = await readCtaActivationBody(req);

    const { data: runtime } = await admin.from("telegram_canary_runtime_state")
      .select("state").eq("singleton_key", "POST13C").maybeSingle();
    if (runtime?.state !== "ACTIVE") {
      return json(409, { error: "CANARY_BOT_NOT_ACTIVE" });
    }

    rawToken = createCanaryToken();
    const tokenDigest = await digestCanaryToken(rawToken);
    let replyMarkup: Record<string, unknown> | null = null;
    const result = await executeCtaActivation({
      snapshotSentinels: async () => {
        const { data, error } = await admin.rpc(
          "snapshot_content_factory_leads_canary_sentinels",
        );
        if (error || !Array.isArray(data) || data.length !== 1) {
          throw new Error("SENTINELS_UNAVAILABLE");
        }
        return data[0];
      },
      prepare: async () => {
        const { data, error } = await admin.rpc(
          "prepare_content_factory_leads_canary_run",
          {
            p_user_id: ownerId,
            p_creative_identity_map_id: body.creativeIdentityMapId,
            p_telegram_post_id: body.telegramPostId,
            p_token_digest: tokenDigest,
          },
        );
        if (error || !data?.token_id) {
          throw new Error("CANARY_RUN_PREPARE_FAILED");
        }
        return data;
      },
      getRun: async () => {
        const { data } = await admin.from("telegram_attribution_canary_runs")
          .select(
            "user_id,bot_id,telegram_chat_id,tg_message_id,token_id,state",
          )
          .eq("singleton_key", "POST13C").maybeSingle();
        return data?.user_id === ownerId ? data : null;
      },
      editCta: async (run: CanaryRun) => {
        publisherToken = await getPublisherToken(admin, run.bot_id);
        replyMarkup = {
          inline_keyboard: [[{
            text: "Записаться",
            url: buildCanaryDeepLink(rawToken),
          }]],
        };
        const response = await telegramApi(
          publisherToken,
          "editMessageReplyMarkup",
          {
            chat_id: run.telegram_chat_id,
            message_id: run.tg_message_id,
            reply_markup: replyMarkup,
          },
        );
        if (response?.ok !== true) throw new Error("CTA_WRITE_FAILED");
      },
      markActive: async () => {
        if (!replyMarkup) return false;
        const { data, error } = await admin.rpc(
          "mark_content_factory_leads_canary_cta_active",
          {
            p_cta_hash: await digestText(JSON.stringify(replyMarkup)),
          },
        );
        return !error && data === true;
      },
      ensureTokenRevoked: async () => {
        const { data, error } = await admin.rpc(
          "ensure_content_factory_leads_canary_token_revoked",
        );
        return !error && data === true;
      },
      removeAndVerifyCta: async (run: CanaryRun) => {
        if (!publisherToken) {
          publisherToken = await getPublisherToken(admin, run.bot_id);
        }
        return isVerifiedMarkupRemoval(
          await boundedTelegramApi(
            fetch,
            publisherToken,
            "editMessageReplyMarkup",
            {
              chat_id: run.telegram_chat_id,
              message_id: run.tg_message_id,
              reply_markup: { inline_keyboard: [] },
            },
            { acceptedStatuses: [400] },
          ),
          run.telegram_chat_id,
          run.tg_message_id,
        );
      },
      markRunRollback: async (_run: unknown, proven: boolean) => {
        const { data, error } = await admin.rpc(
          "mark_content_factory_leads_canary_run_rollback",
          {
            p_reason: proven
              ? "CTA_WRITE_FAILED"
              : "CTA_COMPENSATION_UNCERTAIN",
            p_uncertain: !proven,
          },
        );
        return !error && data === true;
      },
      beginDeactivation: async () => {
        const { data, error } = await admin.rpc(
          "begin_content_factory_leads_canary_deactivation",
        );
        return !error && data === true;
      },
    });

    const ctaHash = await digestText(JSON.stringify(replyMarkup));
    rawToken = "";
    publisherToken = "";
    return json(200, {
      status: result.state,
      canary_run: "POST13C",
      canary_count: 1,
      token_count: 1,
      cta_hash: ctaHash,
      version: "POST13C_CANARY_V1",
    });
  } catch {
    rawToken = "";
    publisherToken = "";
    return json(409, { error: "CANARY_CTA_ACTIVATION_FAILED" });
  }
});

async function getPublisherToken(
  admin: ReturnType<typeof adminClient>,
  botId: string,
): Promise<string> {
  const { data: bot } = await admin.from("bots")
    .select("token_secret_id,is_active").eq("id", botId).maybeSingle();
  if (!bot?.is_active || !bot.token_secret_id) {
    throw new Error("PUBLISHER_BOT_UNAVAILABLE");
  }
  const { data, error } = await admin.rpc("get_bot_token", {
    p_secret_id: bot.token_secret_id,
  });
  if (error || typeof data !== "string" || data.length < 30) {
    throw new Error("PUBLISHER_TOKEN_UNAVAILABLE");
  }
  return data;
}

function telegramApi(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramApiResponse> {
  return boundedTelegramApi(fetch, botToken, method, body);
}

function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
