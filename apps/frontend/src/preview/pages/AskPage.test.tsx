/* @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import { AskPage } from "./AskPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

it("offers a pure Something new link while loading shelf history without generating", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ conversations: [], nextCursor: null }), { headers: { "content-type": "application/json" } }));
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  await act(async () => root?.render(<MemoryRouter initialEntries={["/ask"]}><AskPage /></MemoryRouter>));
  await act(async () => undefined);
  const discovery = Array.from(element.querySelectorAll("a")).find((link) => link.textContent === "Something new");
  expect(discovery?.getAttribute("href")).toBe("/discover/for-you");
  expect(element.textContent).toContain("From my library");
  expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/chat"))).toBe(false);
  expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/recommendations"))).toBe(false);
});
