import { createHash } from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { parseBlob } from "music-metadata";
import pLimit from "p-limit";
import { assertContained } from "../../../security/paths.js";
import { AUDIO_EXTENSIONS, isPartFolder } from "./audioLayout.js";

const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 16;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const METADATA_CONCURRENCY = 4;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]);
const metadataLimit = pLimit(METADATA_CONCURRENCY);
const naturalOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export interface CollectionFile {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

export interface CollectionCandidate {
  id: string;
  title: string;
  author: string;
  files: string[];
  extras: string[];
  evidence: string[];
  reviewReason?: string;
  duration?: number;
  narrator?: string;
  series?: string;
  seriesNumber?: number;
}

export interface CollectionPreview {
  candidates: CollectionCandidate[];
  unassigned: string[];
  extras: string[];
  warnings: string[];
  fingerprint: string;
  files: CollectionFile[];
  mixedTrackAlbums: boolean;
  incompleteInventory: boolean;
}

type AudioTags = {
  title?: string;
  album?: string;
  artist?: string;
  narrator?: string;
  track?: number;
  disc?: number;
  duration?: number;
};

interface AudioFile {
  path: string;
  tags: AudioTags;
}

function compare(a: string, b: string): number {
  return naturalOrder.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function stem(file: string): string {
  return path.posix.basename(file, path.posix.extname(file));
}

function normalized(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function isAudio(file: string): boolean {
  return AUDIO_EXTENSIONS.has(path.posix.extname(file).toLowerCase());
}

function chapterNumber(file: string): number | undefined {
  const match = /^(?:(?:chapter|ch|track)\s+)?(\d{1,3})(?:[\s._-]|$)/i.exec(stem(file));
  return match ? Number(match[1]) : undefined;
}

function explicitPart(file: string) {
  const match = /^(.+?)[\s._-]+(?:cd|disc|disk|part|pt)[\s._-]*(\d{1,3})(?:\s*of\s*(\d{1,3}))?$/i.exec(stem(file));
  return match ? { title: match[1], number: Number(match[2]), total: match[3] ? Number(match[3]) : undefined } : undefined;
}

function logicalDirectory(relative: string): string {
  return relative.split("/").slice(0, -1).filter(part => !isPartFolder(part)).join("/");
}

function discFolderNumber(file: string): number | undefined {
  const folder = file.split("/").slice(0, -1).find(isPartFolder);
  const ordinal = folder?.match(/\d+/)?.[0];
  return ordinal ? Number(ordinal) : undefined;
}

function isNamedDiscSet(files: readonly string[]): boolean {
  const discs = files.map(discFolderNumber);
  return files.length > 1 && discs.every(disc => disc !== undefined) && new Set(discs).size === files.length
    && new Set(files.map(file => normalized(path.posix.basename(file)))).size === 1;
}

function isBookContainer(file: string): boolean {
  return path.posix.extname(file).toLowerCase() === ".m4b";
}

/** Spot unsafe directory-level imports with already discovered audio paths. */
export function hasCollectionLayout(audioPaths: readonly string[], root: string): boolean {
  const relative = audioPaths.map(file => path.relative(root, file).split(path.sep).join("/"));
  if (new Set(relative.map(logicalDirectory)).size > 1) return true;
  if (relative.length < 2 || isNamedDiscSet(relative)) return false;
  const parts = relative.map(explicitPart);
  if (parts.every(part => part !== undefined)) {
    const keys = new Set(relative.map((file, index) =>
      normalized(parts[index].title) + path.posix.extname(file).toLowerCase()));
    return keys.size !== 1 || new Set(parts.map(part => part.number)).size !== parts.length;
  }
  // A book container is normally one complete recording. Numbered MP3
  // chapters and disc folders remain eligible for the normal single-book flow.
  return relative.some(isBookContainer);
}

function identity(file: string, stat: fs.Stats): CollectionFile {
  return { path: file, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino };
}

function sameIdentity(file: CollectionFile, stat: fs.Stats): boolean {
  return file.size === stat.size && file.mtimeMs === stat.mtimeMs && file.ctimeMs === stat.ctimeMs
    && file.dev === stat.dev && file.ino === stat.ino;
}

function checkPortableName(entry: string): boolean {
  return !/[\\:]/.test(entry) && Array.from(entry).every(character => character.charCodeAt(0) >= 32);
}

async function inventory(root: string, warnings: string[], signal?: AbortSignal): Promise<CollectionFile[]> {
  const files: CollectionFile[] = [];
  let entries = 0;

  async function walk(relative: string, depth: number): Promise<void> {
    signal?.throwIfAborted();
    if (depth > MAX_DEPTH) throw new Error("Collection folders are nested too deeply");
    const absolute = path.join(root, relative);
    try {
      if (path.relative(absolute, await assertContained(absolute, root, { mustExist: true, allowRoot: true }))) {
        warnings.push("Skipped linked directory: " + relative);
        return;
      }
      const stat = await fs.promises.lstat(absolute);
      if (!stat.isDirectory()) {
        warnings.push("Skipped changed directory: " + relative);
        return;
      }
      for await (const item of await fs.promises.opendir(absolute)) {
        signal?.throwIfAborted();
        if (++entries > MAX_ENTRIES) throw new Error("Collection has too many entries");
        if (item.name.startsWith(".") || item.name.startsWith("@")) continue;
        const child = relative ? relative + "/" + item.name : item.name;
        if (!checkPortableName(item.name) || item.isSymbolicLink()) {
          warnings.push("Skipped unsafe entry: " + child);
        } else if (item.isDirectory()) {
          await walk(child, depth + 1);
        } else if (item.isFile()) {
          try {
            const file = path.join(root, child);
            const current = await fs.promises.lstat(file);
            if (!current.isFile() || path.relative(file, await assertContained(file, root, { mustExist: true }))) {
              warnings.push("Skipped changed file: " + child);
              continue;
            }
            files.push(identity(child, current));
          } catch {
            warnings.push("Could not read file: " + child);
          }
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (!relative || !(error instanceof Error) || !("code" in error)) throw error;
      warnings.push("Could not read directory: " + relative);
    }
  }

  await walk("", 0);
  return files.sort((a, b) => compare(a.path, b.path));
}

/**
 * Give the metadata parser random access to an already-verified descriptor.
 * An M4B's metadata can be after its audio, so bounding prefix reads alone
 * would miss it. Slices share a byte budget and never reopen a pathname.
 */
class MetadataBlob extends Blob {
  constructor(
    private readonly handle: FileHandle,
    private readonly start: number,
    private readonly end: number,
    private readonly budget: { available: number },
    private readonly signal?: AbortSignal,
  ) {
    super();
  }

  override get size(): number {
    return this.end - this.start;
  }

  override slice(start = 0, end = this.size): Blob {
    const from = Math.min(this.size, Math.max(0, start < 0 ? this.size + start : start));
    const to = Math.min(this.size, Math.max(from, end < 0 ? this.size + end : end));
    return new MetadataBlob(this.handle, this.start + from, this.start + to, this.budget, this.signal);
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.signal?.throwIfAborted();
    if (this.size > this.budget.available) throw new Error("Metadata read limit reached");
    this.budget.available -= this.size;
    const buffer = new ArrayBuffer(this.size);
    let read = 0;
    while (read < this.size) {
      const result = await this.handle.read(new Uint8Array(buffer, read), 0, this.size - read, this.start + read);
      if (result.bytesRead === 0) throw new Error("Audio file changed while reading metadata");
      read += result.bytesRead;
      this.signal?.throwIfAborted();
    }
    return buffer;
  }
}

function tagText(value: string | undefined): string | undefined {
  return value && Array.from(value, character => character.charCodeAt(0) < 32 ? " " : character)
    .join("").trim().slice(0, 256) || undefined;
}

async function readTags(root: string, file: CollectionFile, signal?: AbortSignal): Promise<AudioTags> {
  signal?.throwIfAborted();
  const absolute = path.join(root, file.path);
  const validated = await assertContained(absolute, root, { mustExist: true });
  const named = await fs.promises.lstat(absolute);
  if (path.relative(absolute, validated) || !named.isFile() || !sameIdentity(file, named)) {
    throw new Error("Audio file changed");
  }
  const handle = await fs.promises.open(absolute, fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(file, opened)) throw new Error("Audio file changed");
    const { common, format } = await parseBlob(
      new MetadataBlob(handle, 0, file.size, { available: MAX_METADATA_BYTES }, signal),
      { skipCovers: true },
    );
    if (!sameIdentity(file, await handle.stat())) throw new Error("Audio file changed");
    return {
      title: tagText(common.title),
      album: tagText(common.album),
      artist: tagText(common.albumartist || common.artist),
      narrator: tagText(common.composer?.join(", ")),
      track: common.track?.no ?? undefined,
      disc: common.disk?.no ?? undefined,
      duration: format.duration && Number.isFinite(format.duration) ? format.duration : undefined,
    };
  } finally {
    await handle.close();
  }
}

function rank(file: AudioFile): number[] {
  return [
    discFolderNumber(file.path) ?? file.tags.disc ?? 0,
    explicitPart(file.path)?.number ?? file.tags.track ?? chapterNumber(file.path) ?? 0,
  ];
}

function trackOrder(a: AudioFile, b: AudioFile): number {
  const [aDisc, aTrack] = rank(a);
  const [bDisc, bTrack] = rank(b);
  return aDisc - bDisc || aTrack - bTrack || compare(a.path, b.path);
}

function hasUniqueTrackNumbers(files: readonly AudioFile[]): boolean {
  const positions = files.map(file => rank(file));
  return positions.every(([, track]) => track > 0)
    && new Set(positions.map(position => position.join("/"))).size === positions.length;
}

function meaningfulAlbum(album: string | undefined): album is string {
  if (!album) return false;
  return !/^(?:audiobook|unknown|unknown album|untitled|chapters?|tracks?|disc|cd|part|book)(?: \d+)?$/.test(normalized(album))
    && !/\b(?:collection|complete works|box\s*set)\b/i.test(album) && /\p{L}/u.test(album);
}

function hasRelatedTrackNames(files: readonly AudioFile[]): boolean {
  const names = files.map(({ path }) => {
    if (chapterNumber(path) !== undefined) return "";
    const namedTrack = /^(.+?)[\s._-]+(?:ch(?:apter)?[\s._-]*)?\d{1,3}(?:\s*of\s*\d{1,3})?$/i.exec(stem(path));
    return namedTrack ? normalized(namedTrack[1]) : undefined;
  });
  return names.every(name => name !== undefined) && new Set(names).size === 1;
}

function audioIdentity(file: AudioFile): string {
  const { album, artist } = file.tags;
  return meaningfulAlbum(album) && artist ? normalized(album) + "\0" + normalized(artist) : "";
}

function distinct<T>(values: readonly (T | undefined)[]): T[] {
  return [...new Set(values.filter((value): value is T => value !== undefined))];
}

interface Group {
  files: AudioFile[];
  directory: string;
  method: "folder" | "container" | "parts" | "discs" | "tags" | "single";
  reviewReason?: string;
}

function groupsForDirectory(directory: string, files: AudioFile[], unassigned: string[]): Group[] {
  if (files.every(file => isBookContainer(file.path)) && isNamedDiscSet(files.map(file => file.path))) {
    const identities = distinct(files.map(file => audioIdentity(file) || undefined));
    return [{ files, directory, method: "discs",
      reviewReason: identities.length > 1 ? "The disc filenames match, but audio tags disagree." : undefined }];
  }
  const groups: Group[] = [];
  const parts = new Map<string, AudioFile[]>();
  for (const file of files) {
    const part = explicitPart(file.path);
    if (!part) continue;
    // Different encodes of the same work can coexist in one download.
    const key = normalized(part.title) + path.posix.extname(file.path).toLowerCase();
    parts.set(key, [...(parts.get(key) ?? []), file]);
  }
  const assigned = new Set<AudioFile>();
  for (const files of parts.values()) {
    const numbered = files.map(file => explicitPart(file.path)!);
    const indices = new Set(numbered.map(part => part.number));
    const declared = distinct(numbered.map(part => part.total));
    const total = declared[0] ?? files.length;
    const complete = declared.length <= 1 && indices.size === files.length && total === files.length
      && numbered.every(part => part.number > 0 && part.number <= total);
    groups.push({ files, directory, method: "parts",
      reviewReason: complete && files.length > 1 ? undefined : "Check the recording's part numbers for missing or duplicate files." });
    files.forEach(file => assigned.add(file));
  }
  const remaining = files.filter(file => !assigned.has(file));
  const containers = remaining.filter(file => isBookContainer(file.path));
  for (const file of containers) {
    if (chapterNumber(file.path) !== undefined && !meaningfulAlbum(file.tags.album)
      && /^\d+$/.test(stem(file.path))) {
      unassigned.push(file.path);
    } else {
      groups.push({ files: [file], directory, method: "container" });
    }
  }
  const tracks = remaining.filter(file => !isBookContainer(file.path));
  if (!tracks.length) return groups;
  const tagGroups = new Map<string, AudioFile[]>();
  for (const file of tracks) {
    const key = audioIdentity(file);
    tagGroups.set(key, [...(tagGroups.get(key) ?? []), file]);
  }
  const groupAlbums = distinct(tracks.map(file => meaningfulAlbum(file.tags.album) ? normalized(file.tags.album) : undefined));
  const groupArtists = distinct(tracks.map(file => file.tags.artist && normalized(file.tags.artist)));
  const groupedTracks = tracks.length > 1
    && (tracks.every(file => Number.isFinite(chapterNumber(file.path)))
      || hasUniqueTrackNumbers(tracks)
      || tracks.every(file => file.path.split("/").some(isPartFolder)));
  const dedicated = directory && !groups.length && groupAlbums.length <= 1 && groupArtists.length <= 1;
  if (dedicated && (tracks.length === 1 || groupedTracks)) {
    groups.push({ files: tracks, directory, method: "folder",
      reviewReason: tracks.length > 1 && !hasUniqueTrackNumbers(tracks) ? "Check the proposed track order." : undefined });
    return groups;
  }

  for (const [key, files] of tagGroups) {
    if (key && files.length > 1 && hasUniqueTrackNumbers(files) && hasRelatedTrackNames(files)) {
      groups.push({ files, directory, method: "tags" });
    } else if (tracks.length === 1 && chapterNumber(files[0].path) === undefined) {
      groups.push({ files, directory, method: "single" });
    } else {
      unassigned.push(...files.map(file => file.path));
    }
  }
  return groups;
}

function metadataFor(group: Group, ordered: AudioFile[]) {
  const first = ordered[0];
  const titles = distinct(ordered.map(file => file.tags.title));
  const albums = distinct(ordered.map(file => file.tags.album).filter(meaningfulAlbum));
  const authors = distinct(ordered.map(file => file.tags.artist));
  const narrators = distinct(ordered.map(file => file.tags.narrator));
  const author = authors[0] ?? "";
  let bookDirectory = group.directory;
  if (/^(?:tracks?|audio|files|audiobook)$/i.test(path.posix.basename(bookDirectory))) {
    bookDirectory = path.posix.dirname(bookDirectory);
  }
  const folder = path.posix.basename(bookDirectory);
  const name = group.method === "folder" && folder !== "." ? folder
    : group.method === "parts" ? explicitPart(first.path)!.title : stem(first.path);
  const prefixed = /^(\d{1,3}(?:\.\d+)?)\s*[-._]\s*(.+)$/.exec(name);
  const suffixed = /^(.+?)\s+-\s+(.+?),\s+(?:book|vol\.?)\s+(\d+(?:\.\d+)?)$/i.exec(name);
  let title = suffixed?.[1] ?? prefixed?.[2] ?? name;
  if (author && normalized(title.split(" - ")[0]) === normalized(author)) {
    title = title.split(" - ").slice(1).join(" - ") || title;
  }
  if (group.method === "tags" && albums.length === 1) title = albums[0];
  const evidence = [
    "folder" === group.method ? "Audio tracks share a dedicated folder."
      : "parts" === group.method ? "Filenames identify numbered parts with the same base title."
        : "discs" === group.method ? "Matching filenames appear in distinct numbered disc folders."
        : "tags" === group.method ? "Audio tracks share an album and author, and their filenames support the track numbering."
          : "One standalone audio file.",
    "Path title: " + name,
    ...albums.slice(0, 3).map(album => "Album tag: " + album),
    ...titles.slice(0, 2).map(title => "Title tag: " + title),
    ...authors.slice(0, 2).map(artist => "Artist tag: " + artist),
    ...narrators.slice(0, 2).map(narrator => "Narrator tag: " + narrator),
  ];
  const conflictingContainer = group.method === "container" && albums.some(album => {
    const albumKey = normalized(album);
    const titleKey = normalized(title);
    if (albumKey === titleKey) return false;
    if (/\b(vol(?:ume)?s?|books?)\b/i.test(album + " " + title)) return true;
    return !titleKey.includes(albumKey) && !albumKey.includes(titleKey);
  });
  const duration = ordered.every(file => file.tags.duration !== undefined)
    ? ordered.reduce((sum, file) => sum + (file.tags.duration ?? 0), 0) : undefined;
  const series = suffixed?.[2] || (group.method === "folder" && prefixed
    ? path.posix.basename(path.posix.dirname(bookDirectory)) : undefined);
  return { title, author, evidence, duration, narrator: narrators[0], series: series === "." ? undefined : series,
    seriesNumber: (suffixed || prefixed) ? Number(suffixed?.[3] ?? prefixed?.[1]) : undefined,
    reviewReason: group.reviewReason ?? (conflictingContainer
      ? "The filename and album tag disagree. Confirm the title and whether this is a combined recording." : undefined) };
}

function ownExtras(candidates: CollectionCandidate[], groups: Group[], extras: string[], unassigned: string[]): string[] {
  const leftovers: string[] = [];
  for (const extra of extras) {
    const extension = path.posix.extname(extra).toLowerCase();
    const artwork = IMAGE_EXTENSIONS.has(extension);
    const metadata = extension === ".json";
    if (!artwork && !metadata) {
      leftovers.push(extra);
      continue;
    }
    const directory = logicalDirectory(extra);
    const matching = groups.map((group, index) => ({ group, index })).filter(({ group }) =>
      group.files.some(file => path.posix.dirname(file.path) === path.posix.dirname(extra)
        && normalized(stem(file.path)) === normalized(stem(extra))));
    const structural = groups.map((group, index) => ({ group, index })).filter(({ group }) =>
      directory && (group.directory === directory || group.directory.startsWith(directory + "/")));
    const relatedUnassigned = unassigned.some(file => logicalDirectory(file) === directory
      || logicalDirectory(file).startsWith(directory + "/"));
    const owner = matching.length === 1 ? matching[0]
      : !relatedUnassigned && structural.length === 1 ? structural[0] : undefined;
    if (owner && (artwork || path.posix.basename(extra).toLowerCase() === "metadata.json" || matching.length === 1)) {
      candidates[owner.index].extras.push(extra);
    } else {
      leftovers.push(extra);
    }
  }
  for (const candidate of candidates) {
    const counts = new Map<string, number>();
    for (const extra of candidate.extras) {
      const name = path.posix.basename(extra).toLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    candidate.extras = candidate.extras.filter(extra => {
      if (counts.get(path.posix.basename(extra).toLowerCase()) === 1) return true;
      leftovers.push(extra);
      return false;
    });
  }
  return leftovers.sort(compare);
}

export async function analyzeCollection(input: string, options: { signal?: AbortSignal } = {}): Promise<CollectionPreview> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (!(await fs.promises.lstat(input)).isDirectory()) throw new Error("Collection must be a directory");
  const root = await fs.promises.realpath(input);
  const warnings: string[] = [];
  const files = await inventory(root, warnings, signal);
  const incompleteInventory = warnings.length > 0;
  const audio = files.filter(file => isAudio(file.path));
  const taggedAudio = await Promise.all(audio.map(file => metadataLimit(async (): Promise<AudioFile> => {
    signal?.throwIfAborted();
    try {
      return { path: file.path, tags: await readTags(root, file, signal) };
    } catch {
      signal?.throwIfAborted();
      warnings.push("Could not read audio metadata: " + file.path);
      return { path: file.path, tags: {} };
    }
  })));
  const directories = new Map<string, AudioFile[]>();
  for (const file of taggedAudio) {
    const directory = logicalDirectory(file.path);
    const group = directories.get(directory);
    if (group) group.push(file);
    else directories.set(directory, [file]);
  }
  const mixedTrackAlbums = [...directories.values()].some(group => {
    const albums = group.flatMap(file => {
      const album = file.tags.album;
      if (isBookContainer(file.path) || !meaningfulAlbum(album)) return [];
      return [normalized(album).replace(/\s+(?:disc|cd|disk|part|pt)\s*\d+(?:\s+of\s+\d+)?$/, "")];
    });
    return new Set(albums).size > 1;
  });
  const unassigned: string[] = [];
  const groups = [...directories].flatMap(([directory, files]) => groupsForDirectory(directory, files, unassigned));
  const candidates = groups.map((group): CollectionCandidate => {
    const ordered = group.files.sort(trackOrder);
    const paths = ordered.map(file => file.path);
    return {
      id: createHash("sha256").update(JSON.stringify([...paths].sort(compare))).digest("hex"),
      files: paths,
      extras: [],
      ...metadataFor(group, ordered),
    };
  });
  const extras = ownExtras(candidates, groups, files.filter(file => !isAudio(file.path)).map(file => file.path), unassigned);
  return {
    candidates: candidates.sort((a, b) => compare(a.files[0], b.files[0])),
    unassigned: unassigned.sort(compare),
    extras,
    warnings: warnings.sort(compare),
    fingerprint: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files,
    mixedTrackAlbums,
    incompleteInventory,
  };
}
