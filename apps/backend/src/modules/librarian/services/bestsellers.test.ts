import { describe, expect, it } from "vitest";
import { nytTitleCase } from "./bestsellers.js";

describe("nytTitleCase", () => {
  it("humanizes the all-caps titles the NYT API returns", () => {
    expect(nytTitleCase("THE CALAMITY CLUB")).toBe("The Calamity Club");
  });

  it("capitalizes after punctuation boundaries, not just spaces", () => {
    expect(nytTitleCase("IRON FLAME (EMPYREAN, BOOK 2)")).toBe(
      "Iron Flame (Empyrean, Book 2)",
    );
    expect(nytTitleCase("HELLO BEAUTIFUL: A NOVEL")).toBe(
      "Hello Beautiful: A Novel",
    );
    expect(nytTitleCase("SELF-MADE DREAMS")).toBe("Self-Made Dreams");
  });
});
