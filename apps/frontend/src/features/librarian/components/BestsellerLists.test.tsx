/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  aggregateBestsellers,
  BestsellerLists,
  consensusKey,
  type BestsellerBook,
} from "./BestsellerLists.js";
import { browseContext } from "../context/browseContext.js";

const audibleBook: BestsellerBook = {
  title: "The Bright Sea: A Novel",
  author: "A. Reader",
  coverUrl: "https://example.test/bright-sea.jpg",
  description:
    "<p>A <strong>hopeful</strong> voyage.</p><script>stealCookies()</script>",
  source: "audible",
};

const abnBook: BestsellerBook = {
  title: "Night Signals",
  author: "B. Listener",
  coverUrl: "",
  description: "A mystery told after dark.",
  source: "audiobooksnow",
};

// Same underlying book as audibleBook: subtitle dropped, author spelled out.
const appleBrightSea: BestsellerBook = {
  title: "The Bright Sea",
  author: "Alex Reader",
  coverUrl: "https://example.test/bright-sea-apple.jpg",
  description: "",
  source: "apple",
};

const appleOnlyBook: BestsellerBook = {
  title: "Solo Chart Appearance",
  author: "C. Narrator",
  coverUrl: "",
  description: "",
  source: "apple",
};

const successfulResponse = {
  ok: true,
  json: async () => ({
    results: {
      audible: [audibleBook],
      audiobooksnow: [abnBook],
      apple: [appleOnlyBook, appleBrightSea],
      nytFiction: [],
      nytNonfiction: [],
    },
  }),
};

let container: HTMLDivElement;
let root: Root | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

const flushEffects = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const renderComponent = async (
  props?: Parameters<typeof BestsellerLists>[0],
  initialEntries = ["/discover/charts"],
) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <BestsellerLists {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
};

const clickTab = async (label: string) => {
  const tab = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ].find((candidate) => candidate.textContent?.includes(label));
  expect(tab, `tab labelled ${label}`).not.toBeUndefined();
  await act(async () => tab?.click());
};

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  browseContext.clearBestsellersSnapshot();
  window.location.hash = "";
  fetchMock = vi.fn().mockImplementation(async (url: string | URL) => {
    const urlStr = String(url);
    if (urlStr.includes("/api/candidates/intents")) {
      return { ok: true, json: async () => ({ success: true, intents: {} }) };
    }
    if (urlStr.includes("/api/candidates/intent")) {
      return { ok: true, json: async () => ({ success: true, intent: { intent: "want", revision: 1 } }) };
    }
    return successfulResponse;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  browseContext.clearBestsellersSnapshot();
  window.location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("aggregateBestsellers", () => {
  it("matches the same book across sources despite subtitle and author drift", () => {
    expect(consensusKey(audibleBook)).toBe(consensusKey(appleBrightSea));
    expect(consensusKey(audibleBook)).not.toBe(consensusKey(abnBook));
    expect(
      consensusKey({ ...appleBrightSea, title: "The Bright Sea (Unabridged)" }),
    ).toBe(consensusKey(audibleBook));
  });

  it("ranks multi-chart titles first and records each appearance", () => {
    const aggregated = aggregateBestsellers({
      audible: [audibleBook],
      apple: [appleOnlyBook, appleBrightSea],
    });

    expect(aggregated[0].book.title).toBe("The Bright Sea: A Novel");
    expect(aggregated[0].appearances).toEqual([
      { source: "audible", rank: 1 },
      { source: "apple", rank: 2 },
    ]);
    expect(aggregated[1].book.title).toBe("Solo Chart Appearance");
  });

  it("keeps the first cover and backfills a missing one from a later source", () => {
    const coverless = { ...audibleBook, coverUrl: "" };
    const aggregated = aggregateBestsellers({
      audible: [coverless],
      apple: [appleBrightSea],
    });
    expect(aggregated[0].book.coverUrl).toBe(appleBrightSea.coverUrl);
  });
});

describe("BestsellerLists", () => {
  it("announces its loading and error states", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    await renderComponent();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading bestsellers",
    );

    resolveRequest?.({ ok: false } as Response);
    await flushEffects();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Failed to fetch bestsellers",
    );
  });

  it("defaults to a consensus view with source badges", async () => {
    fetchMock.mockResolvedValueOnce(successfulResponse);

    await renderComponent();
    await flushEffects();

    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(6);
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toContain("All charts");

    // The cross-chart book leads the consensus ranking with both badges.
    const firstCard = container.querySelector(".bestseller-card");
    expect(firstCard?.textContent).toContain("The Bright Sea: A Novel");
    expect(firstCard?.textContent).toContain("Audible #1");
    expect(firstCard?.textContent).toContain("Apple #2");
  });

  it("switches to a single source list when its tab is clicked", async () => {
    fetchMock.mockResolvedValueOnce(successfulResponse);

    await renderComponent();
    await flushEffects();

    await clickTab("AudiobooksNow");

    const panel = container.querySelector('[role="tabpanel"]');
    expect(panel?.textContent).toContain("Night Signals");
    expect(panel?.textContent).not.toContain("The Bright Sea");
  });

  it("points at settings when an NYT chart is empty", async () => {
    fetchMock.mockResolvedValueOnce(successfulResponse);

    await renderComponent();
    await flushEffects();

    await clickTab("NYT Fiction");

    expect(
      container.querySelector('[role="tabpanel"]')?.textContent,
    ).toContain("NYT charts need a Books API key");
  });

  it("dispatches search event and calls onSearch with returnTo", async () => {
    fetchMock.mockResolvedValueOnce(successfulResponse);
    const searchListener = vi.fn();
    const onSearchMock = vi.fn();
    window.addEventListener("trigger-audiobook-search", searchListener);

    await renderComponent({ onSearch: onSearchMock });
    await flushEffects();

    const searchButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Search for The Bright Sea: A Novel by A. Reader"]',
    );
    expect(searchButton).not.toBeNull();

    await act(async () => searchButton?.click());

    expect(searchListener).toHaveBeenCalledOnce();
    expect(onSearchMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "The Bright Sea: A Novel" }),
      "The Bright Sea A. Reader",
      "/discover/charts?tab=all#bestseller-item-1",
    );
    window.removeEventListener("trigger-audiobook-search", searchListener);
  });

  it("opens a touch-friendly description dialog as safe plain text and restores focus on close", async () => {
    fetchMock.mockResolvedValueOnce(successfulResponse);

    await renderComponent();
    await flushEffects();

    const infoButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show description for The Bright Sea: A Novel"]',
    );
    expect(infoButton).not.toBeNull();

    infoButton?.focus();
    await act(async () => infoButton?.click());

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("A hopeful voyage.");
    expect(dialog?.textContent).not.toContain("stealCookies");
    expect(infoButton?.getAttribute("aria-expanded")).toBe("true");

    const closeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close description"]',
    );
    expect(closeButton).not.toBeNull();

    await act(async () => closeButton?.click());

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(infoButton);
  });

  it("restores focus on Escape close", async () => {
    fetchMock.mockResolvedValueOnce(successfulResponse);

    await renderComponent();
    await flushEffects();

    const infoButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show description for The Bright Sea: A Novel"]',
    );
    infoButton?.focus();
    await act(async () => infoButton?.click());

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(infoButton);
  });

  it("allows retrying a transient description failure without caching failure permanently", async () => {
    fetchMock.mockResolvedValueOnce(successfulResponse);

    await renderComponent();
    await flushEffects();

    const infoButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show description for Solo Chart Appearance"]',
    );

    // First iTunes request fails
    fetchMock.mockRejectedValueOnce(new Error("Network error"));
    await act(async () => infoButton?.click());
    await flushEffects();

    expect(container.textContent).toContain("Failed to load description.");
    const retryButton = container.querySelector<HTMLButtonElement>(
      ".bestseller-description__retry",
    );
    expect(retryButton).not.toBeNull();

    // Second iTunes request succeeds
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [{ description: "Retried description successfully loaded." }],
      }),
    } as Response);

    await act(async () => retryButton?.click());
    await flushEffects();

    expect(container.textContent).toContain(
      "Retried description successfully loaded.",
    );
  });

  it("restores active tab and scrolls/focuses candidate 30 when returning with hash anchor", async () => {
    const thirtyBooks: BestsellerBook[] = Array.from({ length: 35 }, (_, i) => ({
      title: `Book Number ${i + 1}`,
      author: `Author ${i + 1}`,
      coverUrl: `https://example.test/cover-${i + 1}.jpg`,
      description: `Description ${i + 1}`,
      source: "audible",
    }));

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: {
          audible: thirtyBooks,
          audiobooksnow: [],
          apple: [],
          nytFiction: [],
          nytNonfiction: [],
        },
      }),
    } as Response);

    window.location.hash = "#bestseller-item-30";
    await renderComponent(undefined, ["/discover/charts?tab=audible#bestseller-item-30"]);
    await flushEffects();

    const candidate30 = container.querySelector("#bestseller-item-30");
    expect(candidate30).not.toBeNull();

    const searchButton30 = candidate30?.querySelector<HTMLButtonElement>(
      ".bestseller-card__search",
    );
    expect(document.activeElement).toBe(searchButton30);
  });

  it("falls back to placeholder if cover image triggers an error", async () => {
    fetchMock.mockResolvedValueOnce(successfulResponse);

    await renderComponent();
    await flushEffects();

    const img = container.querySelector<HTMLImageElement>(
      ".bestseller-card__cover[src]",
    );
    expect(img).not.toBeNull();

    await act(async () => {
      img?.dispatchEvent(new Event("error"));
    });

    const placeholder = container.querySelector(
      ".bestseller-card__cover--placeholder",
    );
    expect(placeholder).not.toBeNull();
  });

  it("displays triage buttons on candidate cards and allows selecting Want", async () => {
    await renderComponent();
    await flushEffects();

    const wantButtons = container.querySelectorAll(".bestseller-triage-btn");
    expect(wantButtons.length).toBeGreaterThan(0);

    const firstWant = [
      ...container.querySelectorAll<HTMLButtonElement>(".bestseller-triage-btn"),
    ].find((btn) => btn.textContent?.includes("Want"));
    expect(firstWant).toBeDefined();

    await act(async () => {
      firstWant?.click();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/candidates/intent",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("shows source freshness banner when a source is stale", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/librarian/bestsellers")) {
        return {
          ok: true,
          json: async () => ({
            results: {
              audible: [audibleBook],
              audiobooksnow: [],
              apple: [],
              nytFiction: [],
              nytNonfiction: [],
            },
            sources: {
              audible: {
                source: "audible",
                status: "stale",
                errorMessage: "Audible 429 rate limited",
                lastSuccessAt: Date.now() - 3600000,
                lastAttemptAt: Date.now(),
                itemCount: 1,
              },
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ success: true, intents: {} }) };
    });

    await renderComponent(undefined, ["/discover/charts?tab=audible"]);
    await flushEffects();

    const notice = container.querySelector(".bestseller-source-notice--stale");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Audible 429 rate limited");
  });
});
