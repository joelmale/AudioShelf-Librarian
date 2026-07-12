import { describe, expect, it } from "vitest";
import { resolveLegacyRedirect } from "./legacyRedirects.js";

describe("legacy bookmark redirects", () => {
  it.each([
    ["/", "/preview/desk"],
    ["/curator", "/preview/desk"],
    ["/curator/", "/preview/desk"],
    ["/curator/books", "/preview/curate/review"],
    ["/curator/books/book-123", "/preview/curate/books/book-123"],
    ["/curator/books/book%2F123", "/preview/curate/books/book%2F123"],
    ["/curator/tag", "/preview/curate/tags"],
    ["/curator/collections", "/preview/curate/collections"],
    ["/curator/collections/collection-123", "/preview/curate/collections/collection-123"],
    ["/curator/encode", "/preview/curate/encode"],
    ["/curator/encode/jobs", "/preview/curate/encode/jobs"],
    ["/curator/unknown", "/preview/curate/review"],
    ["/logs", "/preview/activity"],
    ["/logs/operation-123", "/preview/activity"],
    ["/status", "/preview/settings"],
    ["/settings", "/preview/settings"],
    ["/unknown", "/preview/desk"],
  ])("maps %s to %s", (source, destination) => {
    expect(resolveLegacyRedirect(source)).toBe(destination);
  });
});
