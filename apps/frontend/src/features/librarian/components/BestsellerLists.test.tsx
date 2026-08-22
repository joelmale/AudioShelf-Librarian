/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aggregateBestsellers,
  BestsellerLists,
  consensusKey,
  type BestsellerBook,
} from "./BestsellerLists.js";

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
} as Response;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

const flushEffects = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const renderComponent = async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root.render(<BestsellerLists />);
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
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
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

  it("dispatches the existing search event from a native button", async () => {
    fetchMock.mockResolvedValueOnce(successfulResponse);
    const searchListener = vi.fn();
    window.addEventListener("trigger-audiobook-search", searchListener);

    await renderComponent();
    await flushEffects();

    const searchButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Search for The Bright Sea: A Novel by A. Reader"]',
    );
    expect(searchButton).not.toBeNull();

    await act(async () => searchButton?.click());

    expect(searchListener).toHaveBeenCalledOnce();
    const event = searchListener.mock.calls[0][0] as CustomEvent<{
      query: string;
    }>;
    expect(event.detail.query).toBe("The Bright Sea A. Reader");
    window.removeEventListener("trigger-audiobook-search", searchListener);
  });

  it("opens a touch-friendly description dialog as safe plain text", async () => {
    fetchMock.mockResolvedValueOnce(successfulResponse);

    await renderComponent();
    await flushEffects();

    const infoButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show description for The Bright Sea: A Novel"]',
    );
    expect(infoButton).not.toBeNull();

    await act(async () => infoButton?.click());

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("A hopeful voyage.");
    expect(dialog?.textContent).not.toContain("stealCookies");
    expect(infoButton?.getAttribute("aria-expanded")).toBe("true");
  });
});
