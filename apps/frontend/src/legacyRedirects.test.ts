import { describe, expect, it } from "vitest";
import { resolveCompatibilityRedirect } from "./legacyRedirects.js";

describe("retired UI bookmark redirects", () => {
  it.each([
    ["/", "/desk"],
    ["/preview", "/desk"],
    ["/preview/desk", "/desk"],
    ["/preview/scout/search", "/scout/search"],
    ["/preview/acquire/downloads", "/scout/search"],
    ["/preview/acquire/intake", "/process/scan"],
    ["/preview/process/encode", "/curate/encode"],
    ["/preview/process/encode/jobs", "/curate/encode/jobs"],
    ["/classic", "/desk"],
    ["/classic/curator", "/desk"],
    ["/classic/curator/books/book-123", "/curate/books/book-123"],
    ["/classic/logs/operation-123", "/activity"],
    ["/classic/settings", "/settings"],
    ["/curator", "/desk"],
    ["/curator/", "/desk"],
    ["/curator/books", "/curate/review"],
    ["/curator/books/book%2F123", "/curate/books/book%2F123"],
    ["/curator/tag", "/curate/tags"],
    ["/curator/collections", "/curate/collections"],
    ["/curator/collections/collection-123", "/curate/collections/collection-123"],
    ["/curator/encode", "/curate/encode"],
    ["/curator/encode/jobs", "/curate/encode/jobs"],
    ["/curator/unknown", "/curate/review"],
    ["/logs", "/activity"],
    ["/logs/operation-123", "/activity"],
    ["/status", "/settings"],
    ["/settings", "/settings"],
    ["/activity/operation-123", "/activity/operation-123"],
    ["/unknown", "/desk"],
  ])("maps %s to %s", (source, destination) => {
    expect(resolveCompatibilityRedirect(source)).toBe(destination);
  });
});
