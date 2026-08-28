import { describe, expect, it } from "vitest";
import {
  analyzeFolderPatterns,
  detectFolderPattern,
  FOLDER_PATTERN_MINIMUM_EVIDENCE,
  LEGACY_SERIES_FOLDER_TEMPLATE,
  LEGACY_STANDALONE_FOLDER_TEMPLATE,
  renderFolderPattern,
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
    [{ ...standalone, author: "Name/Other" }, "author"],
    [{ ...standalone, title: "Title\\Other" }, "title"],
    [{ ...standalone, narrator: "Voice\u0000Name" }, "narrator"],
  ] as const)("rejects separators and control characters in metadata", (metadata, field) => {
    const rendered = renderFolderPattern(
      "{author}/{year} - {title} - {{{narrator}}}",
      metadata,
    );
    expect(rendered.eligible).toBe(false);
    expect(rendered.issues).toContain(`${field} contains a path separator or control character`);
  });

  it("rejects rendered traversal", () => {
    expect(renderFolderPattern("{author}/{title}", { author: "Writer", title: ".." }))
      .toEqual({
        eligible: false,
        missingMetadata: [],
        issues: ["Rendered path contains an unsafe path segment"],
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
