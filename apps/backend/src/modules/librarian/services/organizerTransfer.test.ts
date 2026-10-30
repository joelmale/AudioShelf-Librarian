import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OrganizationAction } from "@audioshelf/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../../../config/settings.js";
import { AudiobookOrganizer, findInterruptedTransfers, STAGING_DIR_NAME } from "./organizer.js";
import { INBOX_INCOMING_PREFIX, moveIntoInbox } from "./torrentMonitor.js";

function exdev(): NodeJS.ErrnoException {
  return Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
}

describe("filesystem transfers", () => {
  let dir: string;
  let inbox: string;
  let library: string;
  let source: string;
  let target: string;
  let previousStore: SettingsStore | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-transfer-"));
    inbox = path.join(dir, "inbox");
    library = path.join(dir, "library");
    source = path.join(inbox, "Book");
    target = path.join(library, "Author", "Book");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(library, { recursive: true });
    fs.writeFileSync(path.join(source, "track.mp3"), "audio bytes");

    previousStore = (SettingsStore as unknown as { instance?: SettingsStore }).instance;
    const store = new SettingsStore(dir);
    store.updateSettings({ inboxDir: inbox, libraryDir: library });
    (SettingsStore as unknown as { instance: SettingsStore }).instance = store;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (SettingsStore as unknown as { instance?: SettingsStore }).instance = previousStore;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const moveAction = (): OrganizationAction => ({
    book: { title: "Book", authors: ["Author"], source_path: source, audio_files: [], metadata_source: "filename", confidence_score: 1, is_series: false, needs_processing: true },
    action_type: "move",
    source_path: source,
    target_path: target,
    reason: "test",
    executed: false,
    success: false,
  });

  describe("AudiobookOrganizer.executeAction", () => {
    it("moves in one rename on the same filesystem and leaves no staging folder", async () => {
      const action = moveAction();
      await new AudiobookOrganizer({ PORT: 3050 }).executeAction(action);
      expect(action.success).toBe(true);
      expect(fs.readFileSync(path.join(target, "track.mp3"), "utf-8")).toBe("audio bytes");
      expect(fs.existsSync(source)).toBe(false);
      expect(fs.existsSync(path.join(library, "Author", STAGING_DIR_NAME))).toBe(false);
    });

    it("keeps the inbox copy and removes the staged copy when a cross-device move fails at the last step", async () => {
      const realRename = fs.promises.rename.bind(fs.promises);
      vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
        if (String(from) === source) throw exdev();
        if (String(from).includes(STAGING_DIR_NAME)) throw new Error("disk vanished");
        return realRename(from, to);
      });

      const action = moveAction();
      await expect(new AudiobookOrganizer({ PORT: 3050 }).executeAction(action)).rejects.toThrow("disk vanished");
      expect(action.success).toBe(false);
      expect(fs.readFileSync(path.join(source, "track.mp3"), "utf-8")).toBe("audio bytes");
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.existsSync(path.join(library, "Author", STAGING_DIR_NAME))).toBe(false);
    });

    it("completes a cross-device move and removes the source only afterwards", async () => {
      const realRename = fs.promises.rename.bind(fs.promises);
      vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
        if (String(from) === source) throw exdev();
        return realRename(from, to);
      });

      const action = moveAction();
      await new AudiobookOrganizer({ PORT: 3050 }).executeAction(action);
      expect(fs.readFileSync(path.join(target, "track.mp3"), "utf-8")).toBe("audio bytes");
      expect(fs.existsSync(source)).toBe(false);
      expect(fs.existsSync(path.join(library, "Author", STAGING_DIR_NAME))).toBe(false);
    });
  });

  describe("moveIntoInbox", () => {
    it("copies under a hidden name and renames into place, so the poller never sees a partial book", async () => {
      const downloads = path.join(dir, "downloads", "Book");
      fs.mkdirSync(downloads, { recursive: true });
      fs.writeFileSync(path.join(downloads, "track.mp3"), "download");
      const destination = path.join(inbox, "Downloaded");
      const realRename = fs.promises.rename.bind(fs.promises);
      const renames: string[] = [];
      vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
        if (String(from) === downloads) throw exdev();
        renames.push(path.basename(String(from)));
        return realRename(from, to);
      });

      await expect(moveIntoInbox(downloads, destination)).resolves.toBe("copied-and-removed");
      expect(renames).toHaveLength(1);
      expect(renames[0].startsWith(INBOX_INCOMING_PREFIX)).toBe(true);
      expect(fs.readFileSync(path.join(destination, "track.mp3"), "utf-8")).toBe("download");
      expect(fs.readdirSync(inbox).filter((name) => name.startsWith(INBOX_INCOMING_PREFIX))).toEqual([]);
    });

    it("leaves no partial copy behind when the copy fails", async () => {
      const downloads = path.join(dir, "downloads", "Book");
      fs.mkdirSync(downloads, { recursive: true });
      fs.writeFileSync(path.join(downloads, "track.mp3"), "download");
      vi.spyOn(fs.promises, "rename").mockRejectedValue(exdev());
      vi.spyOn(fs.promises, "cp").mockImplementation(async (_from, to) => {
        fs.mkdirSync(String(to), { recursive: true });
        fs.writeFileSync(path.join(String(to), "partial.mp3"), "half");
        throw new Error("No space left on device");
      });

      await expect(moveIntoInbox(downloads, path.join(inbox, "Downloaded"))).rejects.toThrow("No space left");
      expect(fs.readdirSync(inbox).filter((name) => name !== "Book")).toEqual([]);
    });
  });

  it("reports leftovers from interrupted transfers without deleting them", async () => {
    const staged = path.join(library, "Author", STAGING_DIR_NAME, "abc");
    fs.mkdirSync(staged, { recursive: true });
    const incoming = path.join(inbox, `${INBOX_INCOMING_PREFIX}xyz`);
    fs.mkdirSync(incoming);

    const found = await findInterruptedTransfers(library, inbox, INBOX_INCOMING_PREFIX);
    expect(found.sort()).toEqual([incoming, staged].sort());
    expect(fs.existsSync(staged)).toBe(true);
  });
});
