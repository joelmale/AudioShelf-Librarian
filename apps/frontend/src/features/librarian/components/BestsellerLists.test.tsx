/* @vitest-environment jsdom */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BestsellerLists,
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

const successfulResponse = {
  ok: true,
  json: async () => ({
    results: { audible: [audibleBook], audiobooksnow: [abnBook] },
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

  it("renders both source lists and an empty state when a source has no books", async () => {
    fetchMock.mockResolvedValueOnce({
      ...successfulResponse,
      json: async () => ({
        results: { audible: [audibleBook], audiobooksnow: [] },
      }),
    });

    await renderComponent();
    await flushEffects();

    expect(container.textContent).toContain("Audible Bestsellers");
    expect(container.textContent).toContain("The Bright Sea: A Novel");
    expect(container.textContent).toContain("AudiobooksNow Bestsellers");
    expect(container.textContent).toContain(
      "No titles are currently available from this source.",
    );
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
