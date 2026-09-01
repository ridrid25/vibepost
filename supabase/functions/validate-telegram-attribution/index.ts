import { createClient } from "npm:@supabase/supabase-js@2";
import { handleInternalTokenValidation } from "../_shared/telegram-lead-attribution.mjs";

Deno.serve(async (req) => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  return handleInternalTokenValidation(req, {
    expectedSecret: Deno.env.get("MEETING_TO_VIBE_TOKEN_VALIDATOR_SECRET") ?? "",
    resolve: async (tokenDigest: string) => {
      const { data, error } = await admin.rpc("resolve_active_telegram_attribution_token", {
        p_token_digest: tokenDigest,
      });
      return error ? null : (Array.isArray(data) ? data[0] : data);
    },
  });
});
