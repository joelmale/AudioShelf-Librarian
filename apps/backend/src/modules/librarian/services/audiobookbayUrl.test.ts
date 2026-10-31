import { describe, expect, it } from "vitest";
import { isAudiobookBayUrl } from "./audiobookbay.js";

describe("isAudiobookBayUrl", () => {
  it.each([
    "https://audiobookbay.is/audio-books/mistborn/",
    "http://audiobookbay.lu/abss/book/",
    "https://www.audiobookbay.fi/audio-books/x/",
  ])("accepts %s", (url) => expect(isAudiobookBayUrl(url)).toBe(true));

  it.each([
    "http://192.168.1.1/admin",
    "http://localhost:3050/api/system/logs",
    "http://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
    "https://evil.example.com/audiobookbay",
    "https://audiobookbay.is@evil.example.com/",
    "not a url",
    undefined,
  ])("rejects %s", (url) => expect(isAudiobookBayUrl(url)).toBe(false));
});
