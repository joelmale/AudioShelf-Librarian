/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudiobookSearch } from "./AudiobookSearch.js";

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

const flushEffects = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const renderComponent = async (initialEntries = ["/discover/search"]) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={initialEntries}>
        <AudiobookSearch />
      </MemoryRouter>,
    );
  });
};

const typeInput = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
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

describe("AudiobookSearch", () => {
  it("does not claim no results when query is unsubmitted", async () => {
    await renderComponent();
    await flushEffects();

    const input = container.querySelector<HTMLInputElement>("input[type='text']");
    expect(input).not.toBeNull();

    // Type query without submitting
    await act(async () => {
      input!.value = "Unsubmitted Query";
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.textContent).not.toContain("No results found");
  });

  it("shows empty state only after an actual search completes with 0 results", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], totalPages: 1, currentPage: 1 }),
    } as Response);

    await renderComponent();
    await flushEffects();

    const input = container.querySelector<HTMLInputElement>("input[type='text']");
    const form = container.querySelector<HTMLFormElement>("form");

    await act(async () => {
      typeInput(input!, "Empty Book");
    });

    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain('No results found for \u201cEmpty Book\u201d');
  });

  it("ensures response B arriving before response A leaves response B visible", async () => {
    let resolveA: ((val: unknown) => void) | undefined;
    const promiseA = new Promise((resolve) => {
      resolveA = resolve;
    });

    let resolveB: ((val: unknown) => void) | undefined;
    const promiseB = new Promise((resolve) => {
      resolveB = resolve;
    });

    fetchMock
      .mockImplementationOnce(() => promiseA)
      .mockImplementationOnce(() => promiseB);

    await renderComponent();
    await flushEffects();

    const input = container.querySelector<HTMLInputElement>("input[type='text']");
    const form = container.querySelector<HTMLFormElement>("form");

    // Submit Query A
    await act(async () => {
      typeInput(input!, "Query A");
    });
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    // Submit Query B
    await act(async () => {
      typeInput(input!, "Query B");
    });
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    // Resolve B FIRST with Result B
    resolveB!({
      ok: true,
      json: async () => ({
        results: [
          {
            id: "b",
            title: "Result Book B",
            url: "http://example.com/b",
            coverUrl: "",
            category: "Sci-Fi",
            size: "100MB",
            seeders: 5,
            added: "Today",
          },
        ],
        totalPages: 1,
        currentPage: 1,
      }),
    });
    await flushEffects();

    expect(container.textContent).toContain("Result Book B");

    // Later resolve A with Result A (stale response)
    resolveA!({
      ok: true,
      json: async () => ({
        results: [
          {
            id: "a",
            title: "Stale Result Book A",
            url: "http://example.com/a",
            coverUrl: "",
            category: "Fantasy",
            size: "200MB",
            seeders: 10,
            added: "Yesterday",
          },
        ],
        totalPages: 1,
        currentPage: 1,
      }),
    });
    await flushEffects();

    // Stale result A must NOT overwrite B
    expect(container.textContent).toContain("Result Book B");
    expect(container.textContent).not.toContain("Stale Result Book A");
  });

  it("renders safe return link for valid internal returnTo", async () => {
    await renderComponent([
      "/discover/search?q=test&returnTo=%2Fdiscover%2Fcharts%3Ftab%3Daudible%23bestseller-item-30",
    ]);
    await flushEffects();

    const returnLink = container.querySelector<HTMLAnchorElement>("a.glass-button");
    expect(returnLink).not.toBeNull();
    expect(returnLink?.getAttribute("href")).toBe(
      "/discover/charts?tab=audible#bestseller-item-30",
    );
    expect(returnLink?.textContent).toContain("Back to chart");
  });

  it("rejects untrusted external or malformed returnTo", async () => {
    // Attempt open redirect to evil.com
    await renderComponent([
      "/discover/search?q=test&returnTo=https%3A%2F%2Fevil.com%2Fsteal",
    ]);
    await flushEffects();

    const returnLink = container.querySelector<HTMLAnchorElement>("a.glass-button");
    expect(returnLink).toBeNull();
  });

  it("rejects protocol-relative and javascript: returnTo URLs", async () => {
    await renderComponent([
      "/discover/search?q=test&returnTo=%2F%2Fevil.com%2Fphish",
    ]);
    await flushEffects();
    expect(container.querySelector("a.glass-button")).toBeNull();

    await renderComponent([
      "/discover/search?q=test&returnTo=javascript%3Aalert(1)",
    ]);
    await flushEffects();
    expect(container.querySelector("a.glass-button")).toBeNull();
  });
});
