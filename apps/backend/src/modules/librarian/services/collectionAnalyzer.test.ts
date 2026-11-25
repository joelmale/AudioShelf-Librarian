import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBlob } from "music-metadata";
import { analyzeCollection, hasCollectionLayout } from "./collectionAnalyzer.js";

vi.mock("music-metadata", () => ({ parseBlob: vi.fn() }));

let root: string;
type Tags = {
  title?: string;
  album?: string;
  artist?: string;
  track?: { no: number; of?: number };
};

function write(file: string, contents: Tags | string = {}): string {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof contents === "string" ? contents : JSON.stringify(contents));
  return target;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "asl-collection-"));
  vi.mocked(parseBlob).mockReset();
  vi.mocked(parseBlob).mockImplementation(async blob => {
    const contents = new TextDecoder().decode(await blob.slice().arrayBuffer());
    return { common: JSON.parse(contents), format: { duration: 10, trackInfo: [], tagTypes: [] }, native: {}, quality: { warnings: [] } };
  });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("collection analyzer", () => {
  it.each([
    ["Nursery Crime", ["01 - The Big Over Easy", "02 - The Fourth Bear"]],
    ["Thursday Next", [
      "01 - The Eyre Affair", "02 - Lost in a Good Book", "03 - The Well of Lost Plots",
      "04 - Something Rotten", "05 - First Among Sequels", "06 - One of Our Thursdays Is Missing",
      "07 - The Woman Who Died a Lot",
    ]],
    ["The Last Dragonslayer", [
      "01 - The Last Dragonslayer", "02 - The Song of the Quarkbeast", "03 - The Eye of Zoltar",
    ]],
  ])("proposes one candidate per title within %s", async (series, titles) => {
    for (const book of titles) {
      const folder = series + "/" + book;
      for (const track of ["10", "02", "01"]) {
        write(folder + "/Tracks/" + track + " Chapter.mp3", { artist: "Jasper Fforde" });
      }
      write(folder + "/metadata.json");
      write(folder + "/cover.jpg");
    }
    const preview = await analyzeCollection(root);
    expect(preview.candidates).toHaveLength(titles.length);
    expect(preview.unassigned).toEqual([]);
    expect(preview.candidates.map(book => book.title)).toEqual(titles.map(title => title.slice(5)));
    for (const book of preview.candidates) {
      expect(book).toMatchObject({ author: "Jasper Fforde", duration: 30 });
      expect(book.files.map(file => path.basename(file))).toEqual(["01 Chapter.mp3", "02 Chapter.mp3", "10 Chapter.mp3"]);
      expect(book.extras.map(file => path.basename(file))).toEqual(["cover.jpg", "metadata.json"]);
    }
  });

  it("finds standalone MP3 books and leaves excerpts and multipart tracks unassigned", async () => {
    vi.mocked(parseBlob).mockImplementation(async blob => {
      const common = JSON.parse(new TextDecoder().decode(await blob.slice().arrayBuffer()));
      return { common, format: { duration: common.album === "Preview" ? 300 : 14_400, tagTypes: [], trackInfo: [] }, native: {}, quality: { warnings: [] } };
    });
    write("Kurt Vonnegut - Timequake (Unabridged).mp3", { title: "Timequake (Unabridged)", artist: "Kurt Vonnegut" });
    write("Charles J. Shields - And So It Goes Kurt Vonnegut A Life.mp3",
      { album: "And So It Goes (Unabridged)", title: "And So It Goes: Kurt Vonnegut: A Life", artist: "Charles J. Shields" });
    write("Kurt Vonnegut - Preview.mp3", { album: "Preview", artist: "Kurt Vonnegut" });
    write("Kurt Vonnegut - Multipart.mp3", { album: "Multipart", artist: "Kurt Vonnegut", track: { no: 1, of: 2 } });
    const result = await analyzeCollection(root);
    expect(result.candidates).toMatchObject([
      { title: "And So It Goes: Kurt Vonnegut: A Life", author: "Charles J. Shields", autoImportEligible: true },
      { title: "Timequake", author: "Kurt Vonnegut", autoImportEligible: true },
    ]);
    expect(result.unassigned).toEqual(["Kurt Vonnegut - Multipart.mp3", "Kurt Vonnegut - Preview.mp3"]);
  });

  it("requires matching album evidence and a gap-free sequence for folder auto-import", async () => {
    vi.mocked(parseBlob).mockImplementation(async blob => ({
      common: JSON.parse(new TextDecoder().decode(await blob.slice().arrayBuffer())),
      format: { duration: 1900, tagTypes: [], trackInfo: [] }, native: {}, quality: { warnings: [] },
    }));
    for (const track of [1, 2]) write("Good Book/" + track + ".mp3",
      { album: "Good Book", artist: "Author", track: { no: track, of: 2 } });
    for (const track of [1, 3]) write("Gap Book/" + track + ".mp3",
      { album: "Gap Book", artist: "Author", track: { no: track, of: 3 } });
    for (const track of [1, 2]) write("Unknown Total/" + track + ".mp3", { album: "Unknown Total", artist: "Author", track: { no: track } });
    const result = await analyzeCollection(root);
    expect(Object.fromEntries(result.candidates.map(book => [book.title, book.autoImportEligible])))
      .toEqual({ "Good Book": true, "Gap Book": false, "Unknown Total": false });
  });

  it("keeps all 55 separately named standalone recordings even when album tags match", async () => {
    const titles = ["Arcanum Unbounded", "The Emperor's Soul", "White Sand Volume One to Three",
      "Book A [Dramatized Adaptation]", "Book A",
      ...Array.from({ length: 50 }, (_, n) => "Novel " + (n + 10))];
    titles.forEach((title, n) => write((n % 2 ? "Series " + (n % 4) + "/" : "") + title + ".m4b",
      { album: n === 2 ? "White Sand Volume One" : "Arcanum Unbounded", title, artist: "Brandon Sanderson" }));
    write("book_asin_list.txt", Array.from({ length: 54 }, (_, n) => "Listing " + n).join("\n"));
    const preview = await analyzeCollection(root);

    expect(preview.candidates.map(book => book.title).sort()).toEqual(titles.sort());
    expect(preview.unassigned).toEqual([]);
    expect(preview.extras).toEqual(["book_asin_list.txt"]);
    expect(preview.candidates.find(book => book.title === "White Sand Volume One to Three")?.reviewReason).toBeTruthy();
    expect(new Set(preview.candidates.flatMap(book => book.files)).size).toBe(55);
  });

  it("keeps one book in numbered disc folders and orders disc before track", async () => {
    for (const disc of [10, 2]) {
      for (const track of [10, 2]) write("Novel/Disc " + disc + "/" + track + ".mp3");
    }
    const preview = await analyzeCollection(root);
    expect(preview.candidates).toMatchObject([{
      title: "Novel",
      files: ["Novel/Disc 2/2.mp3", "Novel/Disc 2/10.mp3", "Novel/Disc 10/2.mp3", "Novel/Disc 10/10.mp3"],
    }]);
  });

  it("leaves colliding cover and metadata filenames unassigned across discs", async () => {
    write("Novel/CD 1/01.mp3");
    write("Novel/CD 2/01.mp3");
    write("Novel/CD 1/Cover.jpg");
    write("Novel/CD 2/cover.jpg");
    write("Novel/CD 1/metadata.json");
    write("Novel/CD 2/metadata.json");
    write("Novel/front.png");
    const preview = await analyzeCollection(root);
    expect(preview.candidates).toMatchObject([{ title: "Novel", extras: ["Novel/front.png"] }]);
    expect(preview.extras).toEqual([
      "Novel/CD 1/Cover.jpg", "Novel/CD 1/metadata.json",
      "Novel/CD 2/cover.jpg", "Novel/CD 2/metadata.json",
    ]);
  });

  it("keeps matching M4B files in numbered disc folders together", async () => {
    const files = ["Novel/CD 2/Novel.m4b", "Novel/CD 1/Novel.m4b"].map(file => write(file));
    expect(hasCollectionLayout(files, root)).toBe(false);
    expect((await analyzeCollection(root)).candidates).toMatchObject([{
      title: "Novel", files: ["Novel/CD 1/Novel.m4b", "Novel/CD 2/Novel.m4b"],
    }]);
  });

  it("holds generic or conflicting flat tracks and groups corroborated audio tags", async () => {
    write("01.mp3");
    write("02.mp3", { album: "Unknown", artist: "Someone" });
    write("03.mp3", { album: "Separate Album", artist: "Other" });
    write("Novel_1.mp3", { album: "Great Novel", artist: "One Author", track: { no: 1 } });
    write("Novel_2.mp3", { album: "Great Novel", artist: "One Author", track: { no: 2 } });
    write("A-copy-1.mp3", { album: "Duplicate", artist: "Second Author", track: { no: 1 } });
    write("A-copy-2.mp3", { album: "Duplicate", artist: "Second Author", track: { no: 1 } });
    write("Other Title A.mp3", { album: "Same Album", artist: "One Author", track: { no: 1 } });
    write("Other Title B.mp3", { album: "Same Album", artist: "One Author", track: { no: 2 } });
    const preview = await analyzeCollection(root);
    expect(preview.candidates).toMatchObject([{ title: "Great Novel", files: ["Novel_1.mp3", "Novel_2.mp3"] }]);
    expect(preview.unassigned).toEqual(["01.mp3", "02.mp3", "03.mp3", "A-copy-1.mp3", "A-copy-2.mp3", "Other Title A.mp3", "Other Title B.mp3"]);
  });

  it("keeps explicit book parts together and distinguishes a recording from its edition", async () => {
    const paths = ["Novel Part 2 of 2.m4b", "Novel Part 1 of 2.m4b"].map(file => write(file));
    expect(hasCollectionLayout(paths, root)).toBe(false);
    const edition = write("Novel [Dramatized Adaptation].m4b");
    expect(hasCollectionLayout([...paths, edition], root)).toBe(true);
    const preview = await analyzeCollection(root);
    expect(preview.candidates).toMatchObject([
      { title: "Novel [Dramatized Adaptation]", files: ["Novel [Dramatized Adaptation].m4b"] },
      { title: "Novel", files: ["Novel Part 1 of 2.m4b", "Novel Part 2 of 2.m4b"] },
    ]);
  });

  it("does not read symlinks or include them in source fingerprints", async () => {
    const target = write("Title.m4b", { album: "Title" });
    fs.symlinkSync(target, path.join(root, "Link.m4b"), "file");
    const before = fs.statSync(target);
    const preview = await analyzeCollection(root);
    const after = fs.statSync(target);
    expect(preview.candidates).toMatchObject([{ files: ["Title.m4b"] }]);
    expect(preview.warnings).toEqual(["Skipped unsafe entry: Link.m4b"]);
    expect(preview.files).toHaveLength(1);
    expect(after).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs });
    write("Title.m4b", { album: "Different content" });
    expect((await analyzeCollection(root)).fingerprint).not.toBe(preview.fingerprint);
  });

  it("honors cancellation and bounds a metadata read without dropping a known filename", async () => {
    const totalBytes = 9 * 1024 * 1024;
    const target = write("Title.m4b");
    fs.truncateSync(target, totalBytes);
    const preview = await analyzeCollection(root);
    expect(preview.warnings).toEqual(["Could not read audio metadata: Title.m4b"]);
    expect(preview.candidates).toMatchObject([{ files: ["Title.m4b"] }]);
    const controller = new AbortController();
    controller.abort(new Error("Stopped"));
    await expect(analyzeCollection(root, { signal: controller.signal })).rejects.toThrow("Stopped");
  });
});
