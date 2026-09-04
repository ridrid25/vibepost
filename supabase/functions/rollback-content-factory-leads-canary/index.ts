import { createClient } from "npm:@supabase/supabase-js@2";
import {
  boundedTelegramApi,
  isVerifiedMarkupRemoval,
} from "../_shared/content-factory-leads-canary.mjs";
import { executeCanaryRollback } from "../_shared/content-factory-leads-canary-orchestrator.mjs";

type CanaryRun = {
  user_id: string;
  bot_id: string;
  telegram_chat_id: string;
  tg_message_id: number;
  token_id: string;
  state: string;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
  let publisherToken = "";
  try {
    if (
      req.headers.get("content-length") &&
      req.headers.get("content-length") !== "0"
    ) {
      return json(400, { error: "BODY_NOT_ALLOWED" });
    }
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

    const result = await executeCanaryRollback({
      getRun: async () => {
        const { data, error } = await admin.from(
          "telegram_attribution_canary_runs",
        )
          .select(
            "user_id,bot_id,telegram_chat_id,tg_message_id,token_id,state",
          )
          .eq("singleton_key", "POST13C").maybeSingle();
        if (error) throw new Error("CANARY_RUN_UNAVAILABLE");
        if (!data) return null;
        if (
          data.user_id !== ownerId ||
          !["TOKEN_ISSUED", "ACTIVE", "ROLLBACK_REQUIRED"].includes(data.state)
        ) {
          throw new Error("CANARY_ROLLBACK_NOT_ALLOWED");
        }
        return data;
      },
      ensureTokenRevoked: async () => {
        const { data, error } = await admin.rpc(
          "ensure_content_factory_leads_canary_token_revoked",
        );
        return !error && data === true;
      },
      removeAndVerifyCta: async (run: CanaryRun) => {
        publisherToken = await getPublisherToken(admin, run.bot_id);
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
      snapshotSentinels: async () => {
        const { data, error } = await admin.rpc(
          "snapshot_content_factory_leads_canary_sentinels",
        );
        if (error || !Array.isArray(data) || data.length !== 1) {
          throw new Error("SENTINELS_UNAVAILABLE");
        }
        return data[0];
      },
      markRunRollback: async (_run: unknown, proven: boolean) => {
        const { data, error } = await admin.rpc(
          "mark_content_factory_leads_canary_run_rollback",
          {
            p_reason: proven ? "OWNER_ROLLBACK" : "CTA_COMPENSATION_UNCERTAIN",
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
    publisherToken = "";
    return json(200, {
      status: result.state,
      zero_run: result.zero_run,
      cf1_revoked: !result.zero_run,
      cta_removed: !result.zero_run,
      version: "POST13C_CANARY_V1",
    });
  } catch {
    publisherToken = "";
    return json(409, { error: "ROLLBACK_REQUIRES_OWNER_PROOF" });
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
