import { describe, expect, it, vi } from "vitest";
import { copyAllBookTitles } from "../features/curator/pages/Books.js";
import { loadIntegrationStatus, loadServerDirectory } from "./settingsCapabilities.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("restored primary UI capabilities", () => {
  it("encodes server paths and accepts the filesystem browser payload", async () => {
    const request = vi.fn(async () => jsonResponse({
      success: true,
      currentPath: "C:\\library",
      parentPath: "C:\\",
      directories: ["Audiobooks", "Incoming"],
    }));

    await expect(loadServerDirectory("C:\\library", request)).resolves.toEqual({
      currentPath: "C:\\library",
      parentPath: "C:\\",
      directories: ["Audiobooks", "Incoming"],
    });
    expect(request).toHaveBeenCalledWith("/api/system/fs?path=C%3A%5Clibrary");
  });

  it("surfaces path browser failures without returning an invalid directory", async () => {
    const request = vi.fn(async () => jsonResponse({ error: "Path does not exist" }, 400));
    await expect(loadServerDirectory("/missing", request)).rejects.toThrow("Path does not exist");
  });

  it("loads the complete integration status envelope", async () => {
    const status = {
      audiobookbay: { activeDomain: "https://example.test", lastScrapeTime: null, knownMirrors: 2 },
      qbittorrent: { connected: true, activeDownloads: 1, completedTorrents: 4, importedTorrents: 3 },
      audiobookshelf: { connected: true, libraries: 1, books: 25 },
      proxy: { enabled: true, working: true, ip: "192.0.2.1", location: "Test City" },
    };
    const request = vi.fn(async () => jsonResponse({ success: true, data: status }));
    await expect(loadIntegrationStatus(request)).resolves.toEqual(status);
    expect(request).toHaveBeenCalledWith("/api/librarian/status");
  });

  it("copies every title as a newline-delimited list", async () => {
    const loadTitles = vi.fn(async () => ["Book One", "Book Two"]);
    const writeText = vi.fn(async () => undefined);
    await expect(copyAllBookTitles(loadTitles, writeText)).resolves.toBe(2);
    expect(writeText).toHaveBeenCalledWith("Book One\nBook Two");
  });
});
