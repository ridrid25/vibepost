// Общие куски OAuth-потока YouTube-публикатора.
// Клиент — Web application «vibepost-youtube-publisher» в проекте vibefin.

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  // Полное право управления: снять расписание, скрыть, удалить дубль.
  // youtube.upload позволяет только заливать — 28.08 не смогли отменить
  // publishAt через API и застряли в UI студии.
  "https://www.googleapis.com/auth/youtube",
  // Чтение аналитики канала (возраст, пол, география, источники) — для
  // разбора аудитории по её просьбе 07.09.
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

export function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", YOUTUBE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  // Без prompt=consent Google не выдаёт refresh_token при повторной авторизации.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", options.state);
  return url.toString();
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export async function exchangeAuthorizationCode(options: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      grant_type: "authorization_code",
      redirect_uri: options.redirectUri,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`token exchange failed: ${body.error ?? response.status} ${body.error_description ?? ""}`.trim());
  }
  return body as GoogleTokenResponse;
}

export async function refreshAccessToken(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<GoogleTokenResponse> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      refresh_token: options.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`token refresh failed: ${body.error ?? response.status} ${body.error_description ?? ""}`.trim());
  }
  return body as GoogleTokenResponse;
}

export async function fetchOwnChannel(accessToken: string): Promise<{ id: string; title: string } | null> {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("mine", "true");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`channels.list failed: ${body.error?.message ?? response.status}`);
  }
  const item = Array.isArray(body.items) ? body.items[0] : null;
  if (!item) return null;
  return { id: item.id, title: item.snippet?.title ?? "" };
}
