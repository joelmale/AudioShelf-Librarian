/**
 * Access-token holder for the browser session.
 *
 * The backend has enforced OIDC roles since it was written, but the frontend
 * never attached a token to anything — so `AUTH_ENABLED=true` returned 401 on
 * every REST call and closed the WebSocket with 1008 on a three-second loop.
 * This module is the single place a token lives, so REST and the socket cannot
 * drift apart again.
 *
 * Storage is `sessionStorage`, not `localStorage`: the token dies with the tab
 * rather than persisting on a shared machine.
 */

const STORAGE_KEY = "audioshelf.accessToken";

type Listener = (token: string | null) => void;

const listeners = new Set<Listener>();
let cached: string | null | undefined;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Private-mode or blocked storage: hold the token in memory only.
    return null;
  }
}

export function getAccessToken(): string | null {
  if (cached !== undefined) return cached;
  cached = storage()?.getItem(STORAGE_KEY) ?? null;
  return cached;
}

export function setAccessToken(token: string | null): void {
  const next = token && token.trim() ? token.trim() : null;
  if (next === getAccessToken()) return;
  cached = next;
  const store = storage();
  if (store) {
    if (next) store.setItem(STORAGE_KEY, next);
    else store.removeItem(STORAGE_KEY);
  }
  for (const listener of listeners) listener(next);
}

export function clearAccessToken(): void {
  setAccessToken(null);
}

/** Notified whenever the token is set or cleared, e.g. to reconnect the socket. */
export function onAccessTokenChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Merge the Authorization header into an existing set, when a token is held. */
export function withAuthHeaders(headers: HeadersInit = {}): HeadersInit {
  const token = getAccessToken();
  if (!token) return headers;
  return { ...headers, Authorization: `Bearer ${token}` };
}

/**
 * Browsers cannot set headers on a WebSocket handshake, so the token goes in the
 * query string — which is what `websocket/index.ts` reads on the server.
 */
export function appendAccessToken(url: string): string {
  const token = getAccessToken();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
}

/** Reset in-memory state. Test seam only. */
export function resetAccessTokenCache(): void {
  cached = undefined;
}
