import { describe, expect, it } from "vitest";
import { parseLibraryHealth, parseRealignExecution, parseRealignPlan } from "./api.js";

describe("realignment runtime response contracts", () => {
  it("rejects the obsolete results-only scan response", () => expect(() => parseRealignPlan({ success: true, results: [] })).toThrow(/Invalid realignment plan/));
  it("rejects an incomplete execution response", () => expect(() => parseRealignExecution({ success: true, moved: 1, failed: 0 })).toThrow(/Invalid realignment execution/));
  it("rejects health responses that substitute a score for measurement fields", () => expect(() => parseLibraryHealth({ success: true, overallScore: 100, health: { metadata: { score: 100, status: "Great" }, files: { score: 100, status: "Great" }, structure: { score: 100, status: "Great" }, duplicates: { score: 0, status: "Great" } }, totals: { books: 1, completeMetadata: 1, m4b: 1, structureIssues: 0, duplicates: 0 }, unmeasured: [], generatedAt: 1 })).toThrow(/Invalid library health/));
});
