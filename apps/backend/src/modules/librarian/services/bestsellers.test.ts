import { describe, expect, it, vi } from "vitest";
import { nytTitleCase, BestsellersService } from "./bestsellers.js";
import { request } from "undici";

vi.mock("undici", () => ({
  request: vi.fn(),
}));

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

  it("handles fetch errors gracefully in detailed fetchers without throwing", async () => {
    vi.mocked(request).mockRejectedValueOnce(new Error("Network timeout"));

    const service = new BestsellersService();
    const result = await service.fetchAudibleBestsellersDetailed();
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Network timeout");
    expect(result.books).toHaveLength(0);
  });

  it("assigns candidate IDs and sets status to ready on successful fetch", async () => {
    vi.mocked(request).mockResolvedValueOnce({
      statusCode: 200,
      body: {
        json: async () => ({
          feed: {
            results: [
              {
                id: "123456",
                name: "Test Book",
                artistName: "Test Author",
                artworkUrl100: "http://example.com/100x100.jpg",
                url: "https://books.apple.com/us/audiobook/test-book/id123456",
              },
            ],
          },
        }),
      },
    } as never);

    const service = new BestsellersService();
    const result = await service.fetchAppleBestsellersDetailed();
    expect(result.status).toBe("ready");
    expect(result.books).toHaveLength(1);
    expect(result.books[0].id).toMatch(/^cand_apple_/);
    expect(result.books[0].title).toBe("Test Book");
    expect(result.books[0].author).toBe("Test Author");
    expect(result.books[0].source).toBe("apple");
  });
});
