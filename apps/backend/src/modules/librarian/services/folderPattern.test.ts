import { describe, expect, it } from "vitest";
import {
  analyzeFolderPatterns,
  detectFolderPattern,
  FOLDER_PATTERN_MINIMUM_EVIDENCE,
  LEGACY_SERIES_FOLDER_TEMPLATE,
  LEGACY_STANDALONE_FOLDER_TEMPLATE,
  renderFolderPattern,
  sanitizePathSegment,
  type FolderPatternMetadata,
  type FolderPatternObservation,
} from "./folderPattern.js";

const standalone: FolderPatternMetadata = {
  author: "Ursula K. Le Guin",
  title: "The Dispossessed",
  year: 1974,
  narrator: "Don Leslie",
};
const series: FolderPatternMetadata = {
  author: "James S. A. Corey",
  title: "Leviathan Wakes",
  series: "The Expanse",
  series_number: 1,
  year: 2011,
  narrator: "Jefferson Mays",
};

function observation(
  relativePath: string,
  metadata: FolderPatternMetadata,
  isSeries = false,
  libraryId = "library-one",
): FolderPatternObservation {
  return { libraryId, relativePath, metadata, isSeries };
}

describe("renderFolderPattern", () => {
  it("renders rich standalone and series conventions with literal narrator braces", () => {
    expect(renderFolderPattern(
      "{author}/{year} - {title} - {{{narrator}}}",
      standalone,
    )).toEqual({
      eligible: true,
      relativePath: "Ursula K. Le Guin/1974 - The Dispossessed - {Don Leslie}",
      missingMetadata: [],
      issues: [],
    });
    expect(renderFolderPattern(
      "{author}/{series}/{year} - #{series_number} - {title} - {{{narrator}}}",
      series,
    )).toMatchObject({
      eligible: true,
      relativePath: "James S. A. Corey/The Expanse/2011 - #1 - Leviathan Wakes - {Jefferson Mays}",
    });
  });

  it("makes missing required metadata ineligible instead of inventing a fallback", () => {
    const rendered = renderFolderPattern("{author}/{year} - {title}", {
      author: "Octavia E. Butler",
      title: "Kindred",
    });
    expect(rendered).toEqual({ eligible: false, missingMetadata: ["year"], issues: [] });
    expect(JSON.stringify(rendered)).not.toContain("Unknown");
  });

  it.each([
    [{ ...standalone, author: "Name/Other" }, "Name-Other/1974 - The Dispossessed - {Don Leslie}"],
    [{ ...standalone, title: "Title\\Other" }, "Ursula K. Le Guin/1974 - Title-Other - {Don Leslie}"],
    [{ ...standalone, narrator: "Voice\u0000Name" }, "Ursula K. Le Guin/1974 - The Dispossessed - {VoiceName}"],
  ] as const)("neutralizes separators and control characters instead of rejecting the book", (metadata, expected) => {
    // These used to be REJECTED, which left the book permanently unplaceable:
    // its proposal could never be produced, so it stayed flagged as
    // misaligned and failed every attempted move. A separator inside a token
    // becomes a hyphen and never an extra directory level.
    const rendered = renderFolderPattern(
      "{author}/{year} - {title} - {{{narrator}}}",
      metadata,
    );
    expect(rendered).toMatchObject({ eligible: true, relativePath: expected });
  });

  it("rejects a traversal attempt at the token, before a path is ever assembled", () => {
    // Sanitization strips leading/trailing dots, so ".." reduces to nothing
    // and is refused as unusable metadata. The assembled-path check below is
    // kept as a backstop, but a traversal can no longer reach it from a token
    // value — which is the point of catching this earlier.
    expect(renderFolderPattern("{author}/{title}", { author: "Writer", title: ".." }))
      .toEqual({
        eligible: false,
        missingMetadata: [],
        issues: ["title has no usable characters for a folder name"],
      });
  });

  it.each([
    "/{author}/{title}",
    "{author}//{title}",
    "{author}/../{title}",
    "{author}/{missing}",
    "{author}/{title",
    "{author}/title}",
  ])("rejects invalid templates before rendering: %s", (template) => {
    expect(() => renderFolderPattern(template, standalone)).toThrow();
  });

  it("exports the exact legacy organizer folder conventions without activating them", () => {
    expect(LEGACY_STANDALONE_FOLDER_TEMPLATE).toBe("{author}/{title}");
    expect(LEGACY_SERIES_FOLDER_TEMPLATE).toBe("{author}/{series}/{series_number} - {title}");
  });
});

describe("sanitizePathSegment", () => {
  it("replaces characters that are legal on ext4 but illegal over SMB", () => {
    // The audiobook volume is a network share; a name that only works on the
    // container's own filesystem is not a name that works.
    expect(sanitizePathSegment("Who Goes There?")).toBe("Who Goes There");
    expect(sanitizePathSegment("Colonial Marines: Part One")).toBe("Colonial Marines - Part One");
    expect(sanitizePathSegment('Quote"Title')).toBe("Quote'Title");
    expect(sanitizePathSegment("A*B")).toBe("AxB");
    expect(sanitizePathSegment("S|T")).toBe("ST");
    expect(sanitizePathSegment("A<B>C")).toBe("A(B)C");
  });

  it("keeps a word boundary where a separator was, rather than fusing words", () => {
    // Deleting the slash would turn "Face/Off" into "FaceOff", quietly
    // changing the name a reader sees on disk.
    expect(sanitizePathSegment("Face/Off")).toBe("Face-Off");
    expect(sanitizePathSegment("Back\\Slash")).toBe("Back-Slash");
  });

  it("strips trailing dots and spaces, which SMB silently drops", () => {
    // A name ending in one never round-trips: what you create is not what you
    // can later find.
    expect(sanitizePathSegment("ends with dot.")).toBe("ends with dot");
    expect(sanitizePathSegment("ends with space ")).toBe("ends with space");
    expect(sanitizePathSegment("  padded  ")).toBe("padded");
  });

  it("suffixes reserved device names instead of emitting them", () => {
    expect(sanitizePathSegment("CON")).toBe("CON_");
    expect(sanitizePathSegment("con")).toBe("con_");
    expect(sanitizePathSegment("LPT1")).toBe("LPT1_");
    // Only the exact reserved word — a real title containing it is untouched.
    expect(sanitizePathSegment("Conquest")).toBe("Conquest");
  });

  it("removes control characters", () => {
    expect(sanitizePathSegment("Tab\tSeparated")).toBe("Tab Separated");
    expect(sanitizePathSegment("Null\u0000Byte")).toBe("NullByte");
  });

  it("collapses runs of whitespace", () => {
    expect(sanitizePathSegment("Too    many   spaces")).toBe("Too many spaces");
  });

  it("returns null when nothing usable survives", () => {
    // Reported as an issue by the caller rather than becoming "Unknown": a
    // folder named Unknown is not a correction, it is a different wrong.
    expect(sanitizePathSegment("   ")).toBeNull();
    expect(sanitizePathSegment("...")).toBeNull();
    expect(sanitizePathSegment("???")).toBeNull();
    expect(sanitizePathSegment("")).toBeNull();
  });

  it("caps a segment below the filesystem component limit", () => {
    const long = "x".repeat(500);
    expect(sanitizePathSegment(long)!.length).toBeLessThanOrEqual(200);
  });

  it("leaves an ordinary name completely alone", () => {
    // The common case must be a no-op, or every already-correct book would be
    // re-flagged as misaligned.
    for (const name of ["Piers Anthony", "Centaur Aisle", "1982 - #4 - Centaur Aisle", "J.R.R. Tolkien"]) {
      expect(sanitizePathSegment(name)).toBe(name);
    }
  });
});

describe("renderFolderPattern sanitization", () => {
  const series = "{author}/{series}/{year} - #{series_number} - {title}";

  it("produces a usable path for metadata that used to render illegal names", () => {
    const rendered = renderFolderPattern(series, {
      author: "John W. Campbell", series: "Who", year: 1938, series_number: 1, title: "Who Goes There?",
    });
    expect(rendered).toMatchObject({ eligible: true, relativePath: "John W. Campbell/Who/1938 - #1 - Who Goes There" });
  });

  it("sanitizes token values without touching the template's own separators", () => {
    const rendered = renderFolderPattern(series, {
      author: "Face/Off Dir", series: "S", year: 2000, series_number: 1, title: "A<B>C",
    });
    // Three segments still — the slash inside the AUTHOR became a hyphen, and
    // did not create a fourth directory level.
    expect(rendered.eligible).toBe(true);
    if (rendered.eligible) {
      expect(rendered.relativePath.split("/")).toEqual(["Face-Off Dir", "S", "2000 - #1 - A(B)C"]);
    }
  });

  it("reports which token was unusable rather than substituting a placeholder", () => {
    const rendered = renderFolderPattern(series, {
      author: "???", series: "S", year: 2000, series_number: 1, title: "T",
    });
    expect(rendered).toEqual({
      eligible: false,
      missingMetadata: [],
      issues: ["author has no usable characters for a folder name"],
    });
  });

  it("is idempotent: rendering an already-sanitized name changes nothing", () => {
    // Load-bearing for realign. If sanitizing a clean library shifted paths,
    // every correctly-placed book would be proposed for a pointless move.
    const metadata = { author: "Piers Anthony", series: "Xanth", year: 1982, series_number: 4, title: "Centaur Aisle" };
    const first = renderFolderPattern(series, metadata);
    expect(first.eligible).toBe(true);
    if (!first.eligible) return;
    const segments = first.relativePath.split("/");
    for (const segment of segments) expect(sanitizePathSegment(segment)).toBe(segment);
  });
});

describe("folder-pattern detection", () => {
  const richObservations = [
    observation(
      "Ursula K. Le Guin/1974 - The Dispossessed - {Don Leslie}",
      standalone,
    ),
    observation(
      "Octavia E. Butler/1979 - Kindred - {Kim Staunton}",
      { author: "Octavia E. Butler", title: "Kindred", year: 1979, narrator: "Kim Staunton" },
    ),
    observation(
      "James S. A. Corey/The Expanse/2011 - #1 - Leviathan Wakes - {Jefferson Mays}",
      series,
      true,
    ),
  ];

  it("proposes a clear rich mixed standalone/series winner", () => {
    const result = detectFolderPattern(
      { libraryId: "library-one", rootDir: "/audiobooks" },
      richObservations,
    );
    expect(result).toMatchObject({
      observed: 3,
      eligible: 3,
      matched: 3,
      confidence: 1,
      ambiguity: false,
      proposal: {
        libraryId: "library-one",
        rootDir: "/audiobooks",
        source: "detected",
      },
    });
    expect(result.proposal?.standalone).toContain("{{{narrator}}}");
    expect(result.proposal?.series).toContain("{series}");
  });

  it("detects the documented Larry Correia convention with its series directory", () => {
    const observations = [
      observation(
        "Larry Correia/The Adventures of Tom Stranger, Interdimensional Insurance Agent/2019 - #1 in Customer Service- The Complete Adventures of Tom Stranger - {Adam Baldwin, Larry Correia}",
        {
          author: "Larry Correia",
          title: "#1 in Customer Service- The Complete Adventures of Tom Stranger",
          series: "The Adventures of Tom Stranger, Interdimensional Insurance Agent",
          series_number: 1,
          year: 2019,
          narrator: "Adam Baldwin, Larry Correia",
        },
        true,
      ),
      observation(
        "Author Two/Series Two/2020 - Series-title Two - {Narrator Two}",
        { author: "Author Two", title: "Series-title Two", series: "Series Two", series_number: 2, year: 2020, narrator: "Narrator Two" },
        true,
      ),
      observation(
        "Author Three/Series Three/2021 - Series-title Three - {Narrator Three}",
        { author: "Author Three", title: "Series-title Three", series: "Series Three", series_number: 3, year: 2021, narrator: "Narrator Three" },
        true,
      ),
    ];

    const result = detectFolderPattern(
      { libraryId: "library-one", rootDir: "/audiobooks" },
      observations,
    );
    expect(result).toMatchObject({ matched: 3, confidence: 1, ambiguity: false });
    expect(result.proposal).toMatchObject({
      standalone: "{author}/{year} - {title} - {{{narrator}}}",
      series: "{author}/{series}/{year} - {title} - {{{narrator}}}",
    });
  });

  it("withholds a proposal for a tie", () => {
    const tied = Array.from({ length: FOLDER_PATTERN_MINIMUM_EVIDENCE }, (_, index) =>
      observation(
        `Writer/${2000 + index} - Title ${index} - {Narrator}`,
        { author: "Writer", title: `Title ${index}`, year: 2000 + index, narrator: "Narrator" },
      ));
    const result = detectFolderPattern(
      { libraryId: "library-one", rootDir: "/audiobooks" },
      tied,
    );
    expect(result.ambiguity).toBe(true);
    expect(result.proposal).toBeUndefined();
  });

  it("withholds a proposal below the evidence threshold", () => {
    const result = detectFolderPattern(
      { libraryId: "library-one", rootDir: "/audiobooks" },
      richObservations.slice(0, FOLDER_PATTERN_MINIMUM_EVIDENCE - 1),
    );
    expect(result.confidence).toBe(1);
    expect(result.ambiguity).toBe(false);
    expect(result.proposal).toBeUndefined();
  });

  it("counts incomplete metadata in the confidence denominator", () => {
    const observations = [
      ...richObservations,
      observation("Incomplete Writer/Unmatched One", { author: "Incomplete Writer" }),
      observation("Incomplete Writer/Unmatched Two", { author: "Incomplete Writer" }),
    ];
    const result = detectFolderPattern(
      { libraryId: "library-one", rootDir: "/audiobooks" },
      observations,
    );
    expect(result).toMatchObject({ observed: 5, eligible: 3, matched: 3, confidence: 0.6 });
    expect(result.proposal).toBeUndefined();
  });

  it("reports invalid observations without allowing them into evidence", () => {
    const result = detectFolderPattern(
      { libraryId: "library-one", rootDir: "/audiobooks" },
      [...richObservations, observation("../outside", standalone)],
    );
    expect(result.observed).toBe(4);
    expect(result.eligible).toBe(3);
    expect(result.issues).toEqual(["Observation 4 has an unsafe relative path"]);
  });

  it.each([
    "/absolute/path",
    "C:/absolute/path",
    "C:drive-relative/path",
    "\\\\server\\share\\path",
    "author\\book",
    "author//book",
    "author/./book",
    "author/../book",
    "author/control\u0000book",
  ])("rejects unsafe observed path %s", (relativePath) => {
    const result = detectFolderPattern(
      { libraryId: "library-one", rootDir: "/audiobooks" },
      [observation(relativePath, standalone)],
    );
    expect(result).toMatchObject({ observed: 1, eligible: 0, matched: 0, confidence: 0 });
    expect(result.issues).toHaveLength(1);
  });

  it("isolates observations by explicitly configured library root", () => {
    const analyses = analyzeFolderPatterns(
      [
        { libraryId: "library-one", rootDir: "/audiobooks/one" },
        { libraryId: "library-two", rootDir: "/audiobooks/two" },
      ],
      [
        ...richObservations,
        observation("Other Writer/Other Title", { author: "Other Writer", title: "Other Title" }, false, "library-two"),
        observation("Other Writer/Another Title", { author: "Other Writer", title: "Another Title" }, false, "library-two"),
        observation("Other Writer/Third Title", { author: "Other Writer", title: "Third Title" }, false, "library-two"),
        observation(
          "Other Writer/A Series/1 - Series Title",
          { author: "Other Writer", title: "Series Title", series: "A Series", series_number: 1 },
          true,
          "library-two",
        ),
        observation("Ignored/Unknown", { author: "Ignored", title: "Unknown" }, false, "unknown-library"),
      ],
    );
    expect(analyses[0]).toMatchObject({ rootDir: "/audiobooks/one", observed: 3, confidence: 1 });
    expect(analyses[0].proposal?.source).toBe("detected");
    expect(analyses[1]).toMatchObject({ rootDir: "/audiobooks/two", observed: 4, confidence: 1 });
    expect(analyses[1].proposal).toMatchObject({
      standalone: LEGACY_STANDALONE_FOLDER_TEMPLATE,
      series: LEGACY_SERIES_FOLDER_TEMPLATE,
    });
  });
});
