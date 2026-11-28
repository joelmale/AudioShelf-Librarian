import fs from "node:fs/promises";
import path from "node:path";
import { assertContained } from "../../../security/paths.js";
import { AUDIO_EXTENSIONS } from "./audioLayout.js";

const MAX_ROOT_ENTRIES = 300;
const MAX_ENTRIES = 12_000;
const MAX_DEPTH = 10;

interface InboxEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  audioFiles: number;
  audioPaths: string[];
  otherFiles: number;
  partial: boolean;
}

const isAudio = (name: string) => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());

export async function inspectInbox(configured: string, signal?: AbortSignal) {
  const root = await fs.realpath(configured);
  const entries: InboxEntry[] = [];
  let scanned = 0;
  let omitted = false;
  const isVisible = (name: string) => !name.startsWith(".") && !name.startsWith("@");
  const system: string[] = [];
  const inspectDirectory = async (directory: string, entry: InboxEntry, depth: number) => {
    if (depth > MAX_DEPTH || scanned >= MAX_ENTRIES) { entry.partial = true; return; }
    try {
      const canonical = await assertContained(directory, root, { mustExist: true });
      if (path.relative(directory, canonical) || !(await fs.lstat(canonical)).isDirectory()) {
        entry.partial = true;
        return;
      }
      for await (const item of await fs.opendir(canonical)) {
        signal?.throwIfAborted();
        if (++scanned >= MAX_ENTRIES) { entry.partial = true; break; }
        if (!isVisible(item.name)) continue;
        if (item.isDirectory()) await inspectDirectory(path.join(canonical, item.name), entry, depth + 1);
        else if (!item.isFile()) entry.partial = true;
        else if (isAudio(item.name)) {
          entry.audioFiles++;
          entry.audioPaths.push(path.relative(entry.path, path.join(canonical, item.name)).split(path.sep).join("/"));
        }
        else entry.otherFiles++;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      entry.partial = true;
    }
  };
  for await (const item of await fs.opendir(root)) {
    signal?.throwIfAborted();
    if (!isVisible(item.name)) {
      if (item.name.startsWith("@") || item.name === ".DS_Store" || /^\.(?:collection-review|import-recovery)-/.test(item.name)) {
        if (system.length < MAX_ROOT_ENTRIES) system.push(item.name);
        else omitted = true;
      }
      continue;
    }
    if (entries.length >= MAX_ROOT_ENTRIES) { omitted = true; break; }
    if (!item.isFile() && !item.isDirectory()) { omitted = true; continue; }
    const entry: InboxEntry = {
      name: item.name, path: path.join(root, item.name),
      kind: item.isDirectory() ? "directory" : "file", audioFiles: 0, audioPaths: [], otherFiles: 0, partial: false,
    };
    if (entry.kind === "directory") await inspectDirectory(entry.path, entry, 1);
    else if (isAudio(entry.name)) entry.audioFiles = 1;
    else entry.otherFiles = 1;
    entries.push(entry);
  }
  return { root, entries, omitted, system };
}
