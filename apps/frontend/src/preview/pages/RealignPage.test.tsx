// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../features/curator/toast.js";
import { RealignPage } from "./RealignPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const measured = { libraryId: "lib-1", name: "Fiction", status: "Good", score: 90, total: 10, observed: 12, configuredObserved: 12, eligible: 10, matched: 9, issues: 1, coverage: 10 / 12 };
const candidate = { bookId: "book-1", libraryId: "lib-1", title: "A Book", author: "An Author", currentPath: "/library/old", proposedPath: "/library/new" };
function plan(overrides: Record<string, unknown> = {}) { return { planId: "plan-1", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), libraries: [measured], candidates: [candidate], ...overrides }; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function mount() {
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element); const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={client}><ToastProvider><RealignPage /></ToastProvider></QueryClientProvider>));
  return { element, root };
}
function unmount(root: Root) { act(() => root.unmount()); document.body.replaceChildren(); }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("RealignPage", () => {
  it("renders measured state, selects by stable ID, and sends no preview paths", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(plan()))
      .mockResolvedValueOnce(json({ success: true, moved: 1, failed: 0, errors: [], scanErrors: [], historyBatchId: "history" }))
      .mockResolvedValueOnce(json(plan({ planId: "plan-2", candidates: [] })));
    const { element, root } = mount(); await settle();
    expect(element.textContent).toContain("Configured · Good · 90%");
    expect(element.textContent).toContain("10/12 eligible (83% coverage)");
    expect((Array.from(element.querySelectorAll("button")).find((button) => button.textContent?.includes("Execute 0 moves")) as HTMLButtonElement).disabled).toBe(true);
    const checkbox = element.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox.click());
    const execute = Array.from(element.querySelectorAll("button")).find((button) => button.textContent?.includes("Execute 1 move")) as HTMLButtonElement;
    expect(execute.disabled).toBe(false); await act(async () => execute.click()); await settle();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({ planId: "plan-1", bookIds: ["book-1"] });
    expect(post?.[1]?.body).not.toContain("currentPath"); expect(post?.[1]?.body).not.toContain("proposedPath");
    expect(element.textContent).toContain("Last execution: 1 moved, 0 failed"); unmount(root);
  });

  it("distinguishes Unknown from clean and coverage-gates execution", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(plan({ libraries: [{ ...measured, status: "Unknown", score: 100, total: null, eligible: 0, matched: 0, issues: null, coverage: 0 }], candidates: [] })));
    const { element, root } = mount(); await settle();
    expect(element.textContent).toContain("Unknown / not measured");
    expect(element.textContent).toContain("not an “all clean” result");
    expect(element.textContent).not.toContain("Measured and aligned");
    expect(Array.from(element.querySelectorAll("button")).find((button) => button.textContent?.includes("Execute"))?.hasAttribute("disabled")).toBe(true); unmount(root);
  });

  it("disables an expired plan and tells the user to rescan", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(plan({ expiresAt: new Date(Date.now() - 1_000).toISOString() })));
    const { element, root } = mount(); await settle();
    expect(element.textContent).toContain("review plan expired");
    expect((element.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true); unmount(root);
  });

  it("reports stale-plan execution errors visibly", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(plan())).mockResolvedValueOnce(json({ error: "Realignment plan is unknown or expired" }, 500));
    const { element, root } = mount(); await settle();
    await act(async () => (element.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    const execute = Array.from(element.querySelectorAll("button")).find((button) => button.textContent?.includes("Execute 1 move")) as HTMLButtonElement;
    await act(async () => execute.click()); await settle();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("unknown or expired"); unmount(root);
  });

  it("gates a below-threshold library even if a candidate is returned", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(plan({ libraries: [{ ...measured, coverage: 0.74 }]})));
    const { element, root } = mount(); await settle();
    expect(element.textContent).toContain("below 75% measurement coverage");
    expect((element.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0); unmount(root);
  });

  it("clears selection and disables the stale plan while a rescan is pending", async () => {
    const nextScan = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(plan())).mockImplementationOnce(() => nextScan.promise);
    const { element, root } = mount(); await settle(); const checkbox = element.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox.click()); expect(checkbox.checked).toBe(true);
    await act(async () => Array.from(element.querySelectorAll("button")).find((button) => button.textContent?.includes("Rescan"))!.click());
    expect((element.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    expect((element.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
    expect((Array.from(element.querySelectorAll("button")).find((button) => button.textContent?.includes("Execute 0 moves")) as HTMLButtonElement).disabled).toBe(true);
    nextScan.resolve(json(plan({ planId: "plan-2" }))); await settle(); unmount(root);
  });
});
