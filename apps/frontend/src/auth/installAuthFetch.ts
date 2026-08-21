import { clearAccessToken, getAccessToken } from "./session.js";

/**
 * Attach the access token to this application's own API calls.
 *
 * Installed once as a `fetch` wrapper rather than threaded through every call
 * site: the UI makes around twenty-five direct `fetch("/api/...")` calls spread
 * across components, and a rule that has to be remembered at each of them is a
 * rule that will be missed by the next one added.
 *
 * The token is attached ONLY to same-origin application endpoints. The frontend
 * also talks to third parties (the iTunes Search API for metadata enrichment),
 * and sending a homelab bearer token to an external host would be a credential
 * leak, so anything that is not our own /api or /health is passed through
 * untouched.
 */

const APP_PREFIXES = ["/api", "/health"];

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** True only for this origin's application endpoints. */
export function isAppRequest(rawUrl: string, origin: string = window.location.origin): boolean {
  let pathname: string;
  try {
    // Resolves both relative ("/api/x") and absolute same-origin URLs.
    const resolved = new URL(rawUrl, origin);
    if (resolved.origin !== origin) return false;
    pathname = resolved.pathname;
  } catch {
    return false;
  }
  return APP_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function installAuthFetch(target: { fetch: typeof fetch } = globalThis): () => void {
  const original = target.fetch.bind(target);

  target.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isAppRequest(requestUrl(input))) return original(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const token = getAccessToken();
    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);

    const response = await original(input, { ...init, headers });

    // A rejected token must be dropped, or every subsequent request retries with
    // the same dead credential and the UI never recovers.
    if (response.status === 401) clearAccessToken();

    return response;
  };

  return () => {
    target.fetch = original;
  };
}
