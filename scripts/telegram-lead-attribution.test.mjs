import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  TELEGRAM_ATTRIBUTION,
  TelegramAttributionError,
  buildMeetingDeepLink,
  digestCf1Token,
  generateCf1Token,
  handleInternalTokenValidation,
  mapBusinessEvidence,
  normalizePiiFreeOutcomePage,
  readBoundedStrictJson,
} from "../supabase/functions/_shared/telegram-lead-attribution.mjs";

const migration = readFileSync("supabase/migrations/20260901000002_telegram_lead_attribution_v1.sql", "utf8");
const issuer = readFileSync("supabase/functions/issue-telegram-attribution/index.ts", "utf8");
const validator = readFileSync("supabase/functions/validate-telegram-attribution/index.ts", "utf8");
const resolver = readFileSync("supabase/functions/telegram-business-attribution/index.ts", "utf8");
const revoker = readFileSync("supabase/functions/revoke-telegram-attribution/index.ts", "utf8");
const supabaseConfig = readFileSync("supabase/config.toml", "utf8");

test("cf1 tokens contain 256 random bits and never expose internal IDs", async () => {
  const tokens = new Set(Array.from({ length: 128 }, () => generateCf1Token()));
  assert.equal(tokens.size, 128);
  for (const token of tokens) {
    assert.match(token, TELEGRAM_ATTRIBUTION.TOKEN_RE);
    assert.equal(Buffer.from(token.slice(4), "base64url").length, 32);
    assert.match(await digestCf1Token(token), TELEGRAM_ATTRIBUTION.DIGEST_RE);
    const url = buildMeetingDeepLink("Meeting_bot", token);
    assert.equal(url, `https://t.me/Meeting_bot?start=${token}`);
    assert.equal(/creative-|posts|chat_id|user_id/u.test(url), false);
  }
});

test("deep-link construction fails closed", () => {
  for (const [bot, token] of [
    ["bad/path", generateCf1Token()],
    ["Meeting_bot", "cf1_bad"],
    ["https://evil.example", generateCf1Token()],
  ]) assert.throws(() => buildMeetingDeepLink(bot, token), TelegramAttributionError);
});

test("PII-free outcome envelope preserves exact quality and separate BUSINESS root", () => {
  const tokenDigest = "a".repeat(64);
  const page = normalizePiiFreeOutcomePage({
    status: "OK",
    events: [{
      event_id: "event-1", event_type: "LEAD_CONFIRMED", token_digest: tokenDigest,
      source_system: "meeting_assistant", subject_id: "subject-1", booking_id: "booking-1",
      occurred_at: "2026-09-01T10:00:00.000Z", status: "RECORDED",
      attribution_quality: "DETERMINISTIC",
      provenance: { policy_version: "TELEGRAM_LEAD_ATTRIBUTION_V1", source_record_id: "outcome-1" },
    }], complete: true, next_cursor: null,
  });
  const evidence = mapBusinessEvidence({
    token_digest: tokenDigest, token_id: "token-1", creative_id: `creative-${"b".repeat(64)}`,
    publication_id: "post-1",
  }, page.events[0]);
  assert.equal(evidence.evidence_root, "BUSINESS_PERFORMANCE");
  assert.equal(evidence.attribution_quality, "DETERMINISTIC");
  assert.equal(JSON.stringify(evidence).includes("CONTENT_PERFORMANCE"), false);
});

test("read-side rejects PII, unknown fields, missing values and synthetic gaps", () => {
  const base = {
    event_id: "event-1", event_type: "BOT_START", token_digest: "a".repeat(64),
    source_system: "meeting_assistant", subject_id: "subject-1", booking_id: null,
    occurred_at: "2026-09-01T10:00:00.000Z", status: "ACTIVE",
    attribution_quality: "DIRECT_LINK", provenance: {},
  };
  for (const event of [
    { ...base, email: "pii@example.invalid" },
    { ...base, telegram_id: "123" },
    { ...base, attribution_quality: "PROBABILISTIC" },
    { ...base, token_digest: "bad" },
  ]) assert.throws(() => normalizePiiFreeOutcomePage({
    status: "OK", events: [event], complete: true, next_cursor: null,
  }), TelegramAttributionError);
});

test("bounded JSON reader rejects content-type, oversized streams and schema drift", async () => {
  assert.deepEqual(await readBoundedStrictJson(new Request("http://local.test", {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"token_digest":"' + "a".repeat(64) + '"}',
  }), 512, ["token_digest"]), { token_digest: "a".repeat(64) });
  await assert.rejects(readBoundedStrictJson(new Request("http://local.test", {
    method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
  }), 512, []), /CONTENT_TYPE_INVALID/u);
  await assert.rejects(readBoundedStrictJson(new Request("http://local.test", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: "x".repeat(600) }),
  }), 512, ["data"]), /REQUEST_TOO_LARGE/u);
  await assert.rejects(readBoundedStrictJson(new Request("http://local.test", {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"ok":true,"extra":true}',
  }), 512, ["ok"]), /REQUEST_SCHEMA_INVALID/u);
});

test("JWT-disabled internal function boundary still requires the directional secret", async () => {
  const secret = "meeting-validator-secret-aaaaaaaaaaaaaaaa";
  const tokenDigest = "a".repeat(64);
  const request = (providedSecret) => new Request("http://local.test/functions/v1/validate-telegram-attribution", {
    method: "POST",
    headers: { "content-type": "application/json", "x-meeting-attribution-secret": providedSecret },
    body: JSON.stringify({ token_digest: tokenDigest }),
  });
  assert.equal((await handleInternalTokenValidation(request("wrong"), {
    expectedSecret: secret, resolve: async () => ({ token_version: "cf1", destination: "meeting_assistant" }),
  })).status, 401);
  const response = await handleInternalTokenValidation(request(secret), {
    expectedSecret: secret,
    resolve: async (value) => value === tokenDigest
      ? { token_version: "cf1", destination: "meeting_assistant" }
      : null,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    active: true, token_digest: tokenDigest, token_version: "cf1", destination: "meeting_assistant",
  });
});

test("production boundary is preview-only and contains no raw-token persistence or live CTA", () => {
  assert.match(issuer, /live_activation:\s*false/u);
  assert.doesNotMatch(issuer, /inline_buttons|sendMessage|publish/u);
  assert.match(migration, /token_digest text not null unique/u);
  assert.doesNotMatch(migration, /raw_token/u);
  assert.match(migration, /revoke all on table public\.telegram_attribution_tokens/u);
  assert.match(validator, /handleInternalTokenValidation/u);
  assert.match(resolver, /redirect:\s*"error"/u);
  assert.match(resolver, /evidence_root:\s*"BUSINESS_PERFORMANCE"/u);
  assert.match(resolver, /resolution:\s*page\.status === "NO_EVENTS" \? "UNKNOWN"/u);
  assert.match(revoker, /revoke_telegram_attribution_token/u);
  assert.match(issuer, /RAW_TOKEN_UNAVAILABLE/u);
  assert.match(supabaseConfig,
    /\[functions\.validate-telegram-attribution\]\s*verify_jwt\s*=\s*false/u);
});
