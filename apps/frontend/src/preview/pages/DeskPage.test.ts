import { describe, expect, it } from "vitest";
import type { RealignPlan } from "../../features/curator/api.js";
import { realignSummary } from "./DeskPage.js";

const plan = (status: "Great" | "Unknown", candidates = 0): RealignPlan => ({
  planId: "plan", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1_000).toISOString(),
  libraries: [{ libraryId: "library", name: "Library", status, score: 100, total: status === "Unknown" ? null : 1, observed: 1, configuredObserved: status === "Unknown" ? 0 : 1, eligible: status === "Unknown" ? 0 : 1, matched: status === "Unknown" ? 0 : 1, issues: status === "Unknown" ? null : 0, coverage: status === "Unknown" ? 0 : 1 }],
  candidates: Array.from({ length: candidates }, (_, index) => ({ bookId: `book-${index}`, libraryId: "library", title: "Book", author: "Author", currentPath: "/old", proposedPath: "/new" })),
});

describe("Desk realignment summary", () => {
  it("uses candidates from the new plan contract", () => expect(realignSummary(plan("Great", 2)).heading).toBe("2 realignment candidates"));
  it("distinguishes Unknown libraries from a clean measurement", () => expect(realignSummary(plan("Unknown")).heading).toBe("0 candidates · 1 unmeasured library"));
  it("does not turn missing scan data into zero issues", () => expect(realignSummary(undefined).heading).toBe("Structure not scanned"));
});
