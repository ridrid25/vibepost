export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
export const TIKTOK_REVOKE_URL = "https://open.tiktokapis.com/v2/oauth/revoke/";
export const TIKTOK_USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/";
export const TIKTOK_VIDEO_LIST_URL = "https://open.tiktokapis.com/v2/video/list/";
export const TIKTOK_VIDEO_QUERY_URL = "https://open.tiktokapis.com/v2/video/query/";

export const REQUIRED_SCOPES = ["user.info.basic", "video.list"] as const;

// Observed in the live VibePost account on 2026-08-15. Normalized writes are
// still guarded by the reviewed fixture fingerprints stored per account.
export const DOCUMENTED_VIDEO_FIELDS = [
  "id",
  "create_time",
  "cover_image_url",
  "share_url",
  "video_description",
  "duration",
  "height",
  "width",
  "title",
  "embed_html",
  "embed_link",
  "like_count",
  "comment_count",
  "share_count",
  "view_count",
] as const;

export type NormalizedTikTokVideo = {
  tiktok_video_id: string;
  published_at: string | null;
  title: string | null;
  description: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  share_url: string | null;
  embed_link: string | null;
  cover_image_url: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

export type TikTokTokenResponse = {
  access_token: string;
  refresh_token: string;
  open_id: string;
  scope: string;
  expires_in: number;
  refresh_expires_in: number;
  token_type?: string;
};

export type TokenBundle = {
  access_token: string;
  refresh_token: string;
};

export class TikTokApiError extends Error {
  status: number;
  code: string;
  logId: string | null;
  retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      logId?: string | null;
      retryAfterSeconds?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "TikTokApiError";
    this.status = options.status ?? 500;
    this.code = options.code ?? "unknown_error";
    this.logId = options.logId ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

const textEncoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomState(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildAuthorizeUrl(options: {
  clientKey: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
  disableAutoAuth?: boolean;
}): string {
  const url = new URL(TIKTOK_AUTHORIZE_URL);
  url.searchParams.set("client_key", options.clientKey);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (options.scopes ?? REQUIRED_SCOPES).join(","));
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  if (options.disableAutoAuth) url.searchParams.set("disable_auto_auth", "1");
  return url.toString();
}

export function parseScopes(scope: string | null | undefined): string[] {
  return [...new Set(String(scope ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
}

export function missingRequiredScopes(scopes: readonly string[]): string[] {
  const granted = new Set(scopes);
  return REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
}

const SECRET_KEY = /(access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie|code_verifier)/i;
const PRIVATE_VALUE_KEY = /(^|_)(open_id|union_id|id|username|nickname|display_name|title|video_description|bio_description|avatar_url|profile_deep_link|share_url|cover_image_url|embed_link|embed_html|create_time)$/i;

/**
 * Remove secrets and account/video-identifying values while preserving JSON
 * shape and metric values for schema review. Raw video items are stored in a
 * separate service-role-only table.
 */
export function sanitizeForFixture(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "<redacted-secret>";
  if (PRIVATE_VALUE_KEY.test(key)) {
    if (/url|link|html/i.test(key)) return "<redacted-url>";
    return "<redacted-personal>";
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForFixture(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, child]) => [childKey, sanitizeForFixture(child, childKey)]),
    );
  }
  // Field names/types live in field_inventory. Redacting unknown strings by
  // default prevents a newly introduced TikTok identity field from leaking
  // through a denylist gap while numeric/boolean metrics remain reviewable.
  if (typeof value === "string") return "<redacted-string>";
  return value;
}

export function fieldInventory(value: unknown): Array<{
  path: string;
  type: string;
  types: string[];
  presence_count: number;
  parent_observation_count: number | null;
}> {
  const found = new Map<string, Map<string, number>>();
  const record = (path: string, type: string) => {
    const counts = found.get(path) ?? new Map<string, number>();
    counts.set(type, (counts.get(type) ?? 0) + 1);
    found.set(path, counts);
  };
  const visit = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      record(path, "array");
      for (const item of node) visit(item, `${path}[]`);
      return;
    }
    if (node === null) {
      record(path, "null");
      return;
    }
    if (typeof node === "object") {
      record(path, "object");
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        visit(child, path === "$" ? `$.${key}` : `${path}.${key}`);
      }
      return;
    }
    record(path, typeof node);
  };
  visit(value, "$");
  const observationCount = (counts: Map<string, number> | undefined) =>
    counts ? [...counts.values()].reduce((sum, count) => sum + count, 0) : null;
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([path, counts]) => {
      const types = [...counts.keys()].sort();
      const lastDot = path.lastIndexOf(".");
      const parentPath = lastDot > 0 ? path.slice(0, lastDot) : null;
      return {
        path,
        type: types.length === 1 ? types[0] : "union",
        types,
        presence_count: observationCount(counts) ?? 0,
        parent_observation_count: parentPath ? observationCount(found.get(parentPath)) : null,
      };
    });
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("chunk size must be a positive integer");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded));
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Accept the exact service key or a gateway-validated JWT with service_role.
 * The JWT fallback is safe only on Edge Functions with verify_jwt=true.
 */
export async function callerIsServiceRole(req: Request, serviceKey: string): Promise<boolean> {
  const bearer = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!bearer || !serviceKey) return false;
  if (await sha256Hex(bearer) === await sha256Hex(serviceKey)) return true;
  return decodeJwtPayload(bearer)?.role === "service_role";
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function publishedAtFromCreateTime(value: unknown): string | null {
  const seconds = optionalNonNegativeInteger(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Normalize only fields observed in the reviewed live video/query response.
 * Studio-only retention, completion, traffic and saves are intentionally not
 * present and therefore cannot be manufactured by this path.
 */
export function normalizeTikTokVideo(value: unknown): NormalizedTikTokVideo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const video = value as Record<string, unknown>;
  const id = optionalString(video.id);
  if (!id) return null;
  return {
    tiktok_video_id: id,
    published_at: publishedAtFromCreateTime(video.create_time),
    title: optionalString(video.title),
    description: optionalString(video.video_description),
    duration_seconds: optionalNonNegativeInteger(video.duration),
    width: optionalNonNegativeInteger(video.width),
    height: optionalNonNegativeInteger(video.height),
    share_url: optionalString(video.share_url),
    embed_link: optionalString(video.embed_link),
    cover_image_url: optionalString(video.cover_image_url),
    views: optionalNonNegativeInteger(video.view_count),
    likes: optionalNonNegativeInteger(video.like_count),
    comments: optionalNonNegativeInteger(video.comment_count),
    shares: optionalNonNegativeInteger(video.share_count),
  };
}

export function normalizeTikTokVideos(
  response: Record<string, unknown>,
): NormalizedTikTokVideo[] {
  return videosFromResponse(response)
    .map(normalizeTikTokVideo)
    .filter((video): video is NormalizedTikTokVideo => video !== null);
}

export function videoIdBatchesFromResponse(
  response: Record<string, unknown>,
  size = 20,
): string[][] {
  const ids = [...new Set(videosFromResponse(response)
    .map((video) => video.id)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
  return chunks(ids, size);
}

export function schemaGateAllowsNormalization(
  schemaStatus: string,
  approvedByEndpoint: Record<string, readonly string[]>,
  observed: ReadonlyArray<{ endpoint: string; fingerprint: string }>,
): boolean {
  if (schemaStatus !== "verified" || observed.length === 0) return false;
  return observed.every(({ endpoint, fingerprint }) =>
    new Set(approvedByEndpoint[endpoint] ?? []).has(fingerprint)
  );
}

function retryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export async function parseTikTokResponse(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const envelope = body.error && typeof body.error === "object"
    ? body.error as Record<string, unknown>
    : body;
  const code = String(envelope.code ?? envelope.error ?? (response.ok ? "ok" : "http_error"));
  if (!response.ok || (code !== "ok" && code !== "undefined")) {
    throw new TikTokApiError(
      String(envelope.message ?? envelope.error_description ?? `TikTok HTTP ${response.status}`),
      {
        status: response.status,
        code,
        logId: envelope.log_id ? String(envelope.log_id) : null,
        retryAfterSeconds: retryAfter(response.headers),
      },
    );
  }
  return body;
}

type FetchLike = typeof fetch;
type SleepLike = (milliseconds: number) => Promise<void>;

const defaultSleep: SleepLike = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function request(
  url: string,
  init: RequestInit,
  options: { fetchImpl?: FetchLike; sleep?: SleepLike; retries?: number } = {},
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(10_000),
      });
      return await parseTikTokResponse(response);
    } catch (error) {
      lastError = error;
      const apiError = error instanceof TikTokApiError ? error : null;
      const retryable = !apiError || apiError.status === 429 || apiError.status >= 500;
      if (!retryable || attempt === retries) throw error;
      const seconds = Math.min(apiError?.retryAfterSeconds ?? 2 ** attempt, 30);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(seconds * 1000 + jitter);
    }
  }
  throw lastError;
}

async function tokenRequest(
  init: RequestInit,
  fetchImpl?: FetchLike,
): Promise<TikTokTokenResponse> {
  try {
    return await request(TIKTOK_TOKEN_URL, init, { fetchImpl, retries: 0 }) as TikTokTokenResponse;
  } catch (error) {
    const apiError = error instanceof TikTokApiError ? error : null;
    if (apiError && apiError.status < 500) throw error;
    throw new TikTokApiError(
      "TikTok token response was ambiguous; a new OAuth authorization is required",
      {
        status: apiError?.status ?? 502,
        code: "token_endpoint_ambiguous",
        logId: apiError?.logId ?? null,
      },
    );
  }
}

export async function exchangeAuthorizationCode(options: {
  clientKey: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
}): Promise<TikTokTokenResponse> {
  const body = new URLSearchParams({
    client_key: options.clientKey,
    client_secret: options.clientSecret,
    code: options.code,
    grant_type: "authorization_code",
    redirect_uri: options.redirectUri,
  });
  return await tokenRequest({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  // Authorization codes are one-time credentials. A lost successful response
  // cannot be made safe by blindly replaying the code.
  }, options.fetchImpl);
}

export async function refreshAccessToken(options: {
  clientKey: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: FetchLike;
}): Promise<TikTokTokenResponse> {
  const body = new URLSearchParams({
    client_key: options.clientKey,
    client_secret: options.clientSecret,
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
  });
  return await tokenRequest({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  // TikTok may rotate refresh tokens. Never replay a token request after an
  // ambiguous network/5xx outcome; surface it and reconcile via re-auth.
  }, options.fetchImpl);
}

export async function revokeAccess(options: {
  clientKey: string;
  clientSecret: string;
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const body = new URLSearchParams({
    client_key: options.clientKey,
    client_secret: options.clientSecret,
    token: options.accessToken,
  });
  // Revoke is intentionally single-shot. On an ambiguous failure the account
  // remains revoked_pending locally and a later explicit disconnect can retry.
  await request(TIKTOK_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }, { fetchImpl: options.fetchImpl, retries: 0 });
}

async function bearerPost(
  baseUrl: string,
  accessToken: string,
  fields: readonly string[],
  body: unknown,
  fetchImpl?: FetchLike,
): Promise<Record<string, unknown>> {
  const url = new URL(baseUrl);
  url.searchParams.set("fields", fields.join(","));
  return await request(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, { fetchImpl }) as Record<string, unknown>;
}

export function getUserInfo(accessToken: string, fetchImpl?: FetchLike) {
  const url = new URL(TIKTOK_USER_INFO_URL);
  url.searchParams.set("fields", "open_id,display_name,avatar_url");
  return request(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  }, { fetchImpl }) as Promise<Record<string, unknown>>;
}

export function listVideos(
  accessToken: string,
  cursor?: number | null,
  fetchImpl?: FetchLike,
): Promise<Record<string, unknown>> {
  return bearerPost(
    TIKTOK_VIDEO_LIST_URL,
    accessToken,
    DOCUMENTED_VIDEO_FIELDS,
    { max_count: 20, ...(cursor ? { cursor } : {}) },
    fetchImpl,
  );
}

export function queryVideos(
  accessToken: string,
  videoIds: readonly string[],
  fetchImpl?: FetchLike,
): Promise<Record<string, unknown>> {
  if (videoIds.length < 1 || videoIds.length > 20) {
    throw new Error("video/query requires 1..20 IDs");
  }
  return bearerPost(
    TIKTOK_VIDEO_QUERY_URL,
    accessToken,
    DOCUMENTED_VIDEO_FIELDS,
    { filters: { video_ids: videoIds } },
    fetchImpl,
  );
}

export function videosFromResponse(response: Record<string, unknown>): Record<string, unknown>[] {
  const data = response.data as Record<string, unknown> | undefined;
  return Array.isArray(data?.videos)
    ? data.videos.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];
}

export function cursorFromResponse(response: Record<string, unknown>): number | null {
  const data = response.data as Record<string, unknown> | undefined;
  return typeof data?.cursor === "number" ? data.cursor : null;
}

export function hasMoreFromResponse(response: Record<string, unknown>): boolean {
  const data = response.data as Record<string, unknown> | undefined;
  return data?.has_more === true;
}
