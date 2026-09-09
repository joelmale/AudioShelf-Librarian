/* @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const defaultHealth = () => ({ isPending: false, isError: false, data: { overallScore: 92 } });
  const defaultRecent = () => ({ isLoading: false, isError: false, data: { results: [{ id: "book/a", title: "New book", author: "Writer", coverUrl: "cover.jpg", addedAt: "2026-01-02T00:00:00.000Z" }] } });
  return { defaultHealth, defaultRecent, health: defaultHealth(), recent: defaultRecent() };
});

vi.mock("../../features/curator/api.js", () => ({
  useLibraryHealth: () => fixture.health,
  useRecentlyAdded: () => fixture.recent,
}));

import { LibraryHealthSummary, RecentlyAddedBooks } from "./LibrarySummary.js";

let element: HTMLDivElement | undefined;
afterEach(() => { element?.replaceChildren(); element?.remove(); element = undefined; fixture.health = fixture.defaultHealth(); fixture.recent = fixture.defaultRecent(); });

it("renders health and an encoded canonical recently-added book link", () => {
  element = document.createElement("div");
  const root = createRoot(element);
  act(() => root.render(<MemoryRouter><LibraryHealthSummary /><RecentlyAddedBooks /></MemoryRouter>));
  expect(element.textContent).toContain("92 overall score");
  expect(element.querySelector("a[href='/library/books/book%2Fa']")?.textContent).toBe("New book");
  expect(element.textContent).toContain("Writer");
  expect(element.querySelector("img")?.getAttribute("src")).toBe("cover.jpg");
  expect(element.querySelector("time")?.textContent).not.toBe("");
  root.unmount();
});

it("names loading states", () => {
  fixture.health = { isPending: true, isError: false, data: undefined } as never;
  fixture.recent = { isLoading: true, isError: false, data: undefined } as never;
  element = document.createElement("div"); const root = createRoot(element);
  act(() => root.render(<MemoryRouter><LibraryHealthSummary /><RecentlyAddedBooks /></MemoryRouter>));
  expect(element.textContent).toContain("Checking your library");
  expect(element.textContent).toContain("Loading recently added books");
  root.unmount();
});

it("names error and unknown-health states", () => {
  fixture.health = { isPending: false, isError: false, data: { overallScore: undefined } } as never;
  fixture.recent = { isLoading: false, isError: true, data: { results: [] } } as never;
  element = document.createElement("div"); const root = createRoot(element);
  act(() => root.render(<MemoryRouter><LibraryHealthSummary /><RecentlyAddedBooks /></MemoryRouter>));
  expect(element.textContent).toContain("Unknown overall score");
  expect(element.textContent).toContain("could not be loaded");
  root.unmount();
});

it("names health request failures", () => {
  fixture.health = { isPending: false, isError: true, data: undefined } as never;
  fixture.recent = { isLoading: false, isError: false, data: { results: [] } } as never;
  element = document.createElement("div"); const root = createRoot(element);
  act(() => root.render(<MemoryRouter><LibraryHealthSummary /><RecentlyAddedBooks /></MemoryRouter>));
  expect(element.textContent).toContain("Library health could not be read");
  root.unmount();
});
