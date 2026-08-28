// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { useLibraryHealth } = vi.hoisted(() => ({ useLibraryHealth: vi.fn() }));
vi.mock("../../features/curator/api.js", () => ({ useLibraryHealth }));
import { HealthReportPage } from "./HealthReportPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function mount() { const element = document.createElement("div"); document.body.append(element); const root = createRoot(element); act(() => root.render(<MemoryRouter><HealthReportPage /></MemoryRouter>)); return { element, root }; }
function unmount(root: Root) { act(() => root.unmount()); document.body.replaceChildren(); }
const health = (status: "Great" | "Unknown", structureIssues: number | null, score = 100) => ({ isLoading: false, data: { overallScore: 100, health: { metadata: { score: 100, status: "Great" }, files: { score: 100, status: "Great" }, structure: { score, status }, duplicates: { score: 0, status: "Great" } }, totals: { structureIssues } } });

afterEach(() => { vi.clearAllMocks(); document.body.replaceChildren(); });
describe("HealthReportPage structure measurement", () => {
  it("uses the measured issue total rather than the structure score", () => { useLibraryHealth.mockReturnValue(health("Great", 3, 97)); const { element, root } = mount(); expect(element.textContent).toContain("3 issues"); expect(element.textContent).not.toContain("97 Issues"); unmount(root); });
  it("labels an unmeasured structure Unknown", () => { useLibraryHealth.mockReturnValue(health("Unknown", null)); const { element, root } = mount(); expect(element.textContent).toContain("Unknown · not measured"); expect(element.textContent).not.toContain("100 Issues"); unmount(root); });
});
