// @vitest-environment jsdom
import { PublicSystemSettingsSchema, type PublicSettingsResponse } from "@audioshelf/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(), loadSettingsHistory: vi.fn(), updateSettings: vi.fn(),
  restoreSettings: vi.fn(), clearSettingSecret: vi.fn(),
}));
vi.mock("../settingsClient.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../settingsClient.js")>()), ...mocks }));
vi.mock("../../features/curator/api.js", () => ({
  useHealth: () => ({ data: { absConnected: true, version: "test", dbWritable: true }, isLoading: false, refetch: vi.fn() }),
  useTagStats: () => ({ data: { totalBooks: 1, taggedBooks: 1 } }),
}));
vi.mock("../settingsCapabilities.js", () => ({ loadIntegrationStatus: vi.fn() }));
import { PreviewSettingsDialog } from "./PreviewSettingsDialog.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const baseSettings = PublicSystemSettingsSchema.parse({});
function response(patterns: PublicSettingsResponse["libraryFolderPatterns"] = []): PublicSettingsResponse { return { ...baseSettings, libraryFolderPatterns: patterns, secretStatus: { absTokenConfigured: false, qbitPassConfigured: false, anthropicApiKeyConfigured: false, nytApiKeyConfigured: false, proxyUrlConfigured: false }, managedByEnvironment: [] }; }
function mount(settings = response()) {
  mocks.loadSettings.mockResolvedValue(settings); mocks.loadSettingsHistory.mockResolvedValue([]); mocks.updateSettings.mockImplementation(async (patch: Partial<PublicSettingsResponse>) => ({ ...settings, ...patch }));
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element); act(() => root.render(<PreviewSettingsDialog open onClose={vi.fn()} />)); return { element, root };
}
function unmount(root: Root) { act(() => root.unmount()); document.body.replaceChildren(); }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function setInput(input: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
function button(element: HTMLElement, text: string) { return Array.from(element.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(text)) as HTMLButtonElement; }

afterEach(() => { vi.clearAllMocks(); document.body.replaceChildren(); });
describe("PreviewSettingsDialog folder conventions", () => {
  it("adds, edits, and explicitly saves a valid configured convention", async () => {
    const { element, root } = mount(); await settle(); await act(async () => button(element, "Add convention").click());
    await setInput(element.querySelector('[aria-label="Library ID 1"]') as HTMLInputElement, "library-1");
    await setInput(element.querySelector('[aria-label="Absolute root 1"]') as HTMLInputElement, "/audiobooks");
    await setInput(element.querySelector('[aria-label="Standalone template 1"]') as HTMLInputElement, "{author}/{year} - {title} - {{{narrator}}}");
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    await act(async () => button(element, "Save conventions").click()); await settle();
    expect(mocks.updateSettings).toHaveBeenCalledWith({ libraryFolderPatterns: [expect.objectContaining({ libraryId: "library-1", rootDir: "/audiobooks", standalone: "{author}/{year} - {title} - {{{narrator}}}", source: "configured" })] });
    expect(element.textContent).toContain("Saved"); unmount(root);
  });

  it("removes a convention only after explicit save", async () => {
    const existing = { libraryId: "library-1", rootDir: "/audiobooks", standalone: "{author}/{title}", series: "{author}/{series}/{title}", source: "configured" as const };
    const { element, root } = mount(response([existing])); await settle(); await act(async () => button(element, "Remove").click());
    expect(mocks.updateSettings).not.toHaveBeenCalled(); await act(async () => button(element, "Save conventions").click()); await settle();
    expect(mocks.updateSettings).toHaveBeenCalledWith({ libraryFolderPatterns: [] }); unmount(root);
  });

  it("does not claim an invalid convention was saved", async () => {
    const { element, root } = mount(); await settle(); await act(async () => button(element, "Add convention").click());
    await setInput(element.querySelector('[aria-label="Library ID 1"]') as HTMLInputElement, "library-1");
    await setInput(element.querySelector('[aria-label="Absolute root 1"]') as HTMLInputElement, "relative/path");
    await act(async () => button(element, "Save conventions").click());
    expect(mocks.updateSettings).not.toHaveBeenCalled(); expect(element.querySelector('[role="alert"]')?.textContent).toContain("absolute"); expect(element.textContent).not.toContain("Saved"); unmount(root);
  });

  it("preserves a detected proposal until that row is explicitly confirmed", async () => {
    const detected = { libraryId: "library-1", rootDir: "/audiobooks", standalone: "{author}/{title}", series: "{author}/{series}/{title}", source: "detected" as const };
    const { element, root } = mount(response([detected])); await settle();
    expect(element.textContent).toContain("detected proposal · not confirmed");
    await act(async () => button(element, "Save conventions").click()); await settle();
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({ libraryFolderPatterns: [expect.objectContaining({ source: "detected" })] });
    await act(async () => button(element, "Confirm this convention").click());
    await act(async () => button(element, "Save conventions").click()); await settle();
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({ libraryFolderPatterns: [expect.objectContaining({ source: "configured" })] }); unmount(root);
  });
});
