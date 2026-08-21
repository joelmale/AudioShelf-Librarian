/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendAccessToken,
  clearAccessToken,
  getAccessToken,
  onAccessTokenChange,
  resetAccessTokenCache,
  setAccessToken,
  withAuthHeaders,
} from "./session.js";
import { installAuthFetch, isAppRequest } from "./installAuthFetch.js";

beforeEach(() => {
  sessionStorage.clear();
  resetAccessTokenCache();
});

afterEach(() => {
  sessionStorage.clear();
  resetAccessTokenCache();
});

describe("access token storage", () => {
  it("round-trips a token through sessionStorage", () => {
    setAccessToken("jwt-abc");
    resetAccessTokenCache();

    expect(getAccessToken()).toBe("jwt-abc");
  });

  it("treats blank input as no token", () => {
    setAccessToken("   ");
    expect(getAccessToken()).toBeNull();
  });

  it("notifies listeners on set and clear", () => {
    const seen: (string | null)[] = [];
    const stop = onAccessTokenChange((token) => seen.push(token));

    setAccessToken("one");
    clearAccessToken();
    stop();
    setAccessToken("ignored-after-unsubscribe");

    expect(seen).toEqual(["one", null]);
  });

  it("does not notify when the value is unchanged", () => {
    setAccessToken("same");
    const listener = vi.fn();
    onAccessTokenChange(listener);

    setAccessToken("same");

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("withAuthHeaders", () => {
  it("adds a bearer header when a token is held", () => {
    setAccessToken("jwt-abc");
    expect(withAuthHeaders({ "Content-Type": "application/json" })).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer jwt-abc",
    });
  });

  it("leaves headers untouched when signed out", () => {
    expect(withAuthHeaders({ "Content-Type": "application/json" })).toEqual({
      "Content-Type": "application/json",
    });
  });
});

describe("appendAccessToken", () => {
  it("puts the token in the query string, since a browser cannot set WS headers", () => {
    setAccessToken("jwt abc/+=");
    expect(appendAccessToken("wss://host/api")).toBe("wss://host/api?access_token=jwt%20abc%2F%2B%3D");
  });

  it("appends with & when the url already has a query", () => {
    setAccessToken("t");
    expect(appendAccessToken("wss://host/api?x=1")).toBe("wss://host/api?x=1&access_token=t");
  });

  it("returns the url unchanged when signed out", () => {
    expect(appendAccessToken("wss://host/api")).toBe("wss://host/api");
  });
});

describe("isAppRequest", () => {
  const origin = "https://audioshelf.example.test";

  it.each(["/api/system/settings", "/api", "/health", "https://audioshelf.example.test/api/books"])(
    "treats %s as an application request",
    (url) => {
      expect(isAppRequest(url, origin)).toBe(true);
    },
  );

  it.each([
    "https://itunes.apple.com/search?term=x",
    "https://audiobookbay.is/",
    "/apiary/not-ours",
    "/healthcheck-external",
  ])("does not treat %s as an application request", (url) => {
    expect(isAppRequest(url, origin)).toBe(false);
  });
});

describe("installAuthFetch", () => {
  function harness(status = 200) {
    const calls: { url: string; auth: string | null }[] = [];
    const target = {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(input), auth: headers.get("Authorization") });
        return new Response(null, { status });
      }) as typeof fetch,
    };
    const restore = installAuthFetch(target);
    return { target, calls, restore };
  }

  it("attaches the token to our own API calls", async () => {
    setAccessToken("jwt-abc");
    const { target, calls, restore } = harness();

    await target.fetch("/api/librarian/jobs");

    expect(calls[0].auth).toBe("Bearer jwt-abc");
    restore();
  });

  it("never sends the token to a third party", async () => {
    // The frontend calls the iTunes Search API directly for metadata; leaking a
    // homelab credential to an external host would be a real breach.
    setAccessToken("jwt-abc");
    const { target, calls, restore } = harness();

    await target.fetch("https://itunes.apple.com/search?term=dune");

    expect(calls[0].auth).toBeNull();
    restore();
  });

  it("clears a rejected token so the app stops retrying with it", async () => {
    setAccessToken("stale");
    const { target, restore } = harness(401);

    await target.fetch("/api/books");

    expect(getAccessToken()).toBeNull();
    restore();
  });

  it("leaves an explicitly supplied Authorization header alone", async () => {
    setAccessToken("jwt-abc");
    const { target, calls, restore } = harness();

    await target.fetch("/api/books", { headers: { Authorization: "Bearer explicit" } });

    expect(calls[0].auth).toBe("Bearer explicit");
    restore();
  });

  it("restores the original fetch when uninstalled", async () => {
    const { target, restore } = harness();
    const patched = target.fetch;
    restore();

    expect(target.fetch).not.toBe(patched);
  });
});
