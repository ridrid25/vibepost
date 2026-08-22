import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildAuthorizeUrl,
  callerIsServiceRole,
  chunks,
  fieldInventory,
  missingRequiredScopes,
  normalizeTikTokVideos,
  parseTikTokResponse,
  refreshAccessToken,
  revokeAccess,
  sanitizeForFixture,
  schemaGateAllowsNormalization,
  sha256Hex,
  TikTokApiError,
  videoIdBatchesFromResponse,
} from "./tiktok.ts";

test("authorize URL uses official v2 endpoint and CSRF state", () => {
  const url = new URL(buildAuthorizeUrl({
    clientKey: "client-key",
    redirectUri: "https://example.com/functions/v1/tiktok-oauth-callback",
    state: "state-value",
  }));
  assert.equal(url.origin + url.pathname, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(url.searchParams.get("scope"), "user.info.basic,video.list");
});

test("fixture sanitizer removes tokens and personal identifiers but keeps metrics", () => {
  const sanitized = sanitizeForFixture({
    access_token: "secret",
    data: { videos: [{ id: "123", title: "private title", future_identity: "private", view_count: 42 }] },
  });
  assert.deepEqual(sanitized, {
    access_token: "<redacted-secret>",
    data: { videos: [{
      id: "<redacted-personal>",
      title: "<redacted-personal>",
      future_identity: "<redacted-string>",
      view_count: 42,
    }] },
  });
});

test("field inventory preserves array item paths", () => {
  const inventory = fieldInventory({
    data: { videos: [{ id: "1", view_count: 10 }, { id: "2", view_count: null }, { id: "3" }] },
  });
  const metric = inventory.find((item) => item.path === "$.data.videos[].view_count");
  assert.deepEqual(metric?.types, ["null", "number"]);
  assert.equal(metric?.type, "union");
  assert.equal(metric?.presence_count, 2);
  assert.equal(metric?.parent_observation_count, 3);
});

test("missing scopes are explicit", () => {
  assert.deepEqual(missingRequiredScopes(["user.info.basic"]), ["video.list"]);
});

test("chunks enforce TikTok query batch size helpers", () => {
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.throws(() => chunks([1], 0));
});

test("OAuth probe queries all 18 listed videos in one supported batch", () => {
  const response = {
    data: { videos: Array.from({ length: 18 }, (_, index) => ({ id: `video-${index + 1}` })) },
  };
  const batches = videoIdBatchesFromResponse(response);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 18);
  assert.equal(new Set(batches[0]).size, 18);
});

test("live video/query fields normalize without inventing Studio metrics", () => {
  const videos = normalizeTikTokVideos({
    data: {
      videos: [{
        id: "video-1",
        title: "Title",
        video_description: "Description",
        width: 720,
        height: 1280,
        duration: 10,
        share_url: "https://example.com/share",
        embed_html: "<blockquote></blockquote>",
        embed_link: "https://example.com/embed",
        like_count: 12,
        view_count: 345,
        create_time: 1_720_000_000,
        share_count: 4,
        comment_count: 3,
        cover_image_url: "https://example.com/cover.jpg",
      }],
    },
  });
  assert.equal(videos.length, 1);
  assert.deepEqual(videos[0], {
    tiktok_video_id: "video-1",
    published_at: new Date(1_720_000_000 * 1000).toISOString(),
    title: "Title",
    description: "Description",
    duration_seconds: 10,
    width: 720,
    height: 1280,
    share_url: "https://example.com/share",
    embed_link: "https://example.com/embed",
    cover_image_url: "https://example.com/cover.jpg",
    views: 345,
    likes: 12,
    comments: 3,
    shares: 4,
  });
  assert.equal(Object.hasOwn(videos[0], "saves"), false);
  assert.equal(Object.hasOwn(videos[0], "retention"), false);
  assert.equal(Object.hasOwn(videos[0], "embed_html"), false);
});

test("normalization remains closed until every observed schema fingerprint is approved", () => {
  const observed = [
    { endpoint: "/v2/video/list/", fingerprint: "list" },
    { endpoint: "/v2/video/query/", fingerprint: "query" },
  ];
  assert.equal(schemaGateAllowsNormalization("fixture_captured", {
    "/v2/video/list/": ["list"], "/v2/video/query/": ["query"],
  }, observed), false);
  assert.equal(schemaGateAllowsNormalization("verified", {
    "/v2/video/list/": ["list"], "/v2/video/query/": ["other"],
  }, observed), false);
  assert.equal(schemaGateAllowsNormalization("verified", {
    "/v2/video/list/": ["list"], "/v2/video/query/": ["query"],
  }, observed), true);
});

test("scheduled sync accepts exact service key or gateway-validated service_role JWT", async () => {
  const exact = new Request("https://example.com", {
    headers: { Authorization: "Bearer service-secret" },
  });
  const payload = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
  const gatewayJwt = new Request("https://example.com", {
    headers: { Authorization: `Bearer header.${payload}.signature` },
  });
  const anonPayload = Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url");
  const anonJwt = new Request("https://example.com", {
    headers: { Authorization: `Bearer header.${anonPayload}.signature` },
  });
  assert.equal(await callerIsServiceRole(exact, "service-secret"), true);
  assert.equal(await callerIsServiceRole(gatewayJwt, "service-secret"), true);
  assert.equal(await callerIsServiceRole(anonJwt, "service-secret"), false);
  assert.equal(await callerIsServiceRole(new Request("https://example.com"), "service-secret"), false);
});

test("raw video idempotency preserves endpoint provenance", () => {
  const callback = fs.readFileSync(new URL("../tiktok-oauth-callback/index.ts", import.meta.url), "utf8");
  const sync = fs.readFileSync(new URL("../tiktok-sync/index.ts", import.meta.url), "utf8");
  const migration = fs.readFileSync(new URL(
    "../../migrations/20260815000004_tiktok_normalized_videos.sql",
    import.meta.url,
  ), "utf8");
  for (const source of [callback, sync]) {
    assert.match(source, /onConflict:\s*"sync_run_id,endpoint,payload_sha256"/);
  }
  assert.match(migration, /unique \(sync_run_id, endpoint, payload_sha256\)/i);
});

test("TikTok v2 error envelope keeps status, code and log_id", async () => {
  const response = new Response(JSON.stringify({
    error: { code: "rate_limit_exceeded", message: "slow down", log_id: "log-1" },
  }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "3" } });
  await assert.rejects(() => parseTikTokResponse(response), (error) => {
    assert.ok(error instanceof TikTokApiError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "rate_limit_exceeded");
    assert.equal(error.logId, "log-1");
    assert.equal(error.retryAfterSeconds, 3);
    return true;
  });
});

test("SHA-256 helper is deterministic", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("refresh flow persists the newly returned refresh token shape", async () => {
  const token = await refreshAccessToken({
    clientKey: "client-key",
    clientSecret: "client-secret",
    refreshToken: "old-refresh",
    fetchImpl: async (_url, init) => {
      const form = init?.body as URLSearchParams;
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "old-refresh");
      return new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "rotated-refresh",
        open_id: "open-id",
        scope: "user.info.basic,video.list",
        expires_in: 86400,
        refresh_expires_in: 31536000,
        token_type: "Bearer",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(token.refresh_token, "rotated-refresh");
});

test("token refresh is not blindly retried after an ambiguous failure", async () => {
  let calls = 0;
  await assert.rejects(() => refreshAccessToken({
    clientKey: "client-key",
    clientSecret: "client-secret",
    refreshToken: "old-refresh",
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({
        error: "server_error",
        error_description: "ambiguous",
      }), { status: 500, headers: { "Content-Type": "application/json" } });
    },
  }));
  assert.equal(calls, 1);
});

test("disconnect uses the official revoke endpoint with the access token", async () => {
  let capturedUrl = "";
  await revokeAccess({
    clientKey: "client-key",
    clientSecret: "client-secret",
    accessToken: "access-token",
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      const form = init?.body as URLSearchParams;
      assert.equal(form.get("client_key"), "client-key");
      assert.equal(form.get("token"), "access-token");
      return new Response("", { status: 200 });
    },
  });
  assert.equal(capturedUrl, "https://open.tiktokapis.com/v2/oauth/revoke/");
});
