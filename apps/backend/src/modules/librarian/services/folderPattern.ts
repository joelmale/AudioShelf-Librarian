import type {
  FolderPatternToken,
  LibraryFolderPattern,
} from "@audioshelf/shared";
import {
  FolderPatternTemplateSchema,
  LibraryFolderPatternSchema,
} from "@audioshelf/shared";

export const LEGACY_STANDALONE_FOLDER_TEMPLATE = "{author}/{title}";
export const LEGACY_SERIES_FOLDER_TEMPLATE = "{author}/{series}/{series_number} - {title}";

export const FOLDER_PATTERN_MINIMUM_EVIDENCE = 3;
export const FOLDER_PATTERN_MINIMUM_CONFIDENCE = 0.75;
export const FOLDER_PATTERN_WINNER_MARGIN = 0.15;

export interface FolderPatternMetadata {
  author?: string | null;
  title?: string | null;
  series?: string | null;
  series_number?: string | number | null;
  year?: string | number | null;
  narrator?: string | null;
}

export type FolderPatternRenderResult =
  | { eligible: true; relativePath: string; missingMetadata: []; issues: [] }
  | { eligible: false; missingMetadata: FolderPatternToken[]; issues: string[] };

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function tokensIn(template: string): FolderPatternToken[] {
  const tokens: FolderPatternToken[] = [];
  for (let index = 0; index < template.length;) {
    if (template.startsWith("{{", index) || template.startsWith("}}", index)) {
      index += 2;
      continue;
    }
    if (template[index] !== "{") {
      index += 1;
      continue;
    }
    const close = template.indexOf("}", index + 1);
    const token = template.slice(index + 1, close) as FolderPatternToken;
    if (!tokens.includes(token)) tokens.push(token);
    index = close + 1;
  }
  return tokens;
}

function metadataValue(metadata: FolderPatternMetadata, token: FolderPatternToken): string | undefined {
  const raw = metadata[token];
  if (raw === null || raw === undefined) return undefined;
  const value = String(raw).trim();
  return value || undefined;
}

/**
 * Characters that are legal on ext4 but illegal over SMB/CIFS, mapped to a
 * readable stand-in rather than deleted. Deletion merges words — `Face/Off`
 * becoming `FaceOff` — which quietly changes the name the user sees.
 */
const SEGMENT_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[/\\]/g, "-"],
  [/:/g, " -"],
  [/"/g, "'"],
  [/\*/g, "x"],
  [/</g, "("],
  [/>/g, ")"],
  [/[?|]/g, ""],
];

/** Windows/SMB reserved device names, which cannot be directory names at all. */
const RESERVED_SEGMENT_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Filesystems cap a single component at 255 bytes; 200 leaves headroom for
 *  the multi-byte characters a byte-blind slice would otherwise split. */
const MAX_SEGMENT_LENGTH = 200;

/**
 * Make one rendered token value safe to use as a directory name.
 *
 * WHY THIS EXISTS. `renderFolderPattern` used to only REJECT unsafe values,
 * and only checked for `/`, `\` and control characters. Everything else went
 * through untouched, so real library metadata produced target paths like
 * `…/1938 - #1 - Who Goes There?` and `A*B/S|T/2000 - #1 - Quote"Title`.
 * Those are legal on ext4 and illegal over SMB — which is how the audiobook
 * volume is actually mounted. Worse, an unsanitized proposal can never equal
 * the sanitized path already on disk, so those books were flagged as
 * misaligned forever AND failed whenever a move was attempted.
 *
 * Returns `null` when nothing usable survives, which the caller reports as an
 * issue rather than silently substituting a placeholder: a folder named
 * "Unknown" is not a correction, it is a different kind of wrong.
 *
 * ── Deliberately separate from `organizer.cleanDirectoryName` ──────────────
 * That one builds a whole folder NAME from a book and is on the legacy intake
 * path; changing it would move targets that flow is already producing. This
 * one sanitizes a single rendered SEGMENT and adds the segment-level rules
 * that one lacks (reserved device names, trailing dots and spaces). Merging
 * the two is worth doing, but it is a behaviour change to intake and belongs
 * in its own commit.
 */
export function sanitizePathSegment(value: string): string | null {
  let cleaned = value;
  for (const [pattern, replacement] of SEGMENT_REPLACEMENTS) cleaned = cleaned.replace(pattern, replacement);
  // A tab or newline is WHITESPACE that happens to be a control character.
  // Deleting it fuses the words either side ("Tab	Separated" -> "TabSeparated"),
  // the same damage that argued against deleting separators above — so those
  // become a space, and only the genuinely non-printing controls are dropped.
  cleaned = [...cleaned].map((character) => {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || code === 11 || code === 12 || code === 13) return " ";
    return code > 31 && code !== 127 ? character : "";
  }).join("");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  // Windows and SMB silently drop a trailing dot or space, so a name ending in
  // one never round-trips: what you created is not what you can later find.
  cleaned = cleaned.replace(/^[.\-_\s]+/, "").replace(/[.\-_\s]+$/, "");
  if (cleaned.length > MAX_SEGMENT_LENGTH) cleaned = cleaned.slice(0, MAX_SEGMENT_LENGTH).trim();
  if (!cleaned) return null;
  if (RESERVED_SEGMENT_NAMES.has(cleaned.toLowerCase())) cleaned = `${cleaned}_`;
  return cleaned;
}

/** Render only validated, complete metadata. No fallback directory names exist. */
export function renderFolderPattern(
  template: string,
  metadata: FolderPatternMetadata,
): FolderPatternRenderResult {
  FolderPatternTemplateSchema.parse(template);
  const tokens = tokensIn(template);
  const missingMetadata = tokens.filter((token) => metadataValue(metadata, token) === undefined);
  if (missingMetadata.length > 0) return { eligible: false, missingMetadata, issues: [] };

  // Sanitize rather than reject. Rejecting made a book with a `?` in its title
  // permanently unplaceable; the whole point of the pattern is to produce a
  // path that CAN exist on the target volume.
  const issues: string[] = [];
  const safeValues = new Map<FolderPatternToken, string>();
  for (const token of tokens) {
    const raw = metadataValue(metadata, token)!;
    const safe = sanitizePathSegment(raw);
    if (safe === null) {
      issues.push(`${token} has no usable characters for a folder name`);
      continue;
    }
    safeValues.set(token, safe);
  }
  if (issues.length > 0) return { eligible: false, missingMetadata: [], issues };

  let relativePath = "";
  for (let index = 0; index < template.length;) {
    if (template.startsWith("{{", index)) {
      relativePath += "{";
      index += 2;
    } else if (template.startsWith("}}", index)) {
      relativePath += "}";
      index += 2;
    } else if (template[index] === "{") {
      const close = template.indexOf("}", index + 1);
      const token = template.slice(index + 1, close) as FolderPatternToken;
      relativePath += safeValues.get(token)!;
      index = close + 1;
    } else {
      relativePath += template[index];
      index += 1;
    }
  }
  const segments = relativePath.split("/");
  if (
    relativePath.startsWith("/")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return {
      eligible: false,
      missingMetadata: [],
      issues: ["Rendered path contains an unsafe path segment"],
    };
  }
  return { eligible: true, relativePath, missingMetadata: [], issues: [] };
}

export interface FolderPatternCandidatePair {
  id: string;
  standalone: string;
  series: string;
}

/**
 * Detection deliberately considers only these documented pairs. It does not
 * synthesize arbitrary templates from paths, which keeps proposals explainable.
 */
export const FOLDER_PATTERN_CANDIDATES: readonly FolderPatternCandidatePair[] = [
  {
    id: "legacy",
    standalone: LEGACY_STANDALONE_FOLDER_TEMPLATE,
    series: LEGACY_SERIES_FOLDER_TEMPLATE,
  },
  {
    id: "year-and-braced-narrator",
    standalone: "{author}/{year} - {title} - {{{narrator}}}",
    series: "{author}/{series}/{year} - #{series_number} - {title} - {{{narrator}}}",
  },
  {
    id: "plan-rich-series",
    standalone: "{author}/{year} - {title} - {{{narrator}}}",
    series: "{author}/{series}/{year} - {title} - {{{narrator}}}",
  },
  {
    id: "year-and-narrator-flat-series",
    standalone: "{author}/{year} - {title} - {{{narrator}}}",
    series: "{author}/{year} - #{series_number} - {title} - {{{narrator}}}",
  },
  {
    // Some libraries encode series identity/sequence in the title itself and
    // therefore use no series directory or generated sequence prefix.
    id: "year-title-and-braced-narrator",
    standalone: "{author}/{year} - {title} - {{{narrator}}}",
    series: "{author}/{year} - {title} - {{{narrator}}}",
  },
  {
    id: "legacy-standalone-rich-series",
    standalone: LEGACY_STANDALONE_FOLDER_TEMPLATE,
    series: "{author}/{series}/{year} - #{series_number} - {title} - {{{narrator}}}",
  },
  {
    id: "rich-standalone-legacy-series",
    standalone: "{author}/{year} - {title} - {{{narrator}}}",
    series: LEGACY_SERIES_FOLDER_TEMPLATE,
  },
] as const;

export interface FolderPatternObservation {
  libraryId: string;
  relativePath: string;
  metadata: FolderPatternMetadata;
  isSeries?: boolean;
}

export interface FolderPatternCandidateScore extends FolderPatternCandidatePair {
  eligible: number;
  matched: number;
  confidence: number;
}

export interface FolderPatternAnalysis {
  libraryId: string;
  rootDir: string;
  observed: number;
  eligible: number;
  matched: number;
  issues: string[];
  confidence: number;
  ambiguity: boolean;
  candidates: FolderPatternCandidateScore[];
  proposal?: LibraryFolderPattern;
}

function safeObservedPath(relativePath: string): boolean {
  if (
    !relativePath
    || relativePath.startsWith("/")
    || /^[A-Za-z]:/.test(relativePath)
    || relativePath.includes("\\")
    || hasControlCharacters(relativePath)
  ) return false;
  return !relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

export function detectFolderPattern(
  library: Pick<LibraryFolderPattern, "libraryId" | "rootDir">,
  observations: readonly FolderPatternObservation[],
): FolderPatternAnalysis {
  const identity = LibraryFolderPatternSchema.pick({ libraryId: true, rootDir: true }).parse(library);
  const relevant = observations.filter((observation) => observation.libraryId === identity.libraryId);
  const valid: FolderPatternObservation[] = [];
  const issues: string[] = [];
  relevant.forEach((observation, index) => {
    if (!safeObservedPath(observation.relativePath)) {
      issues.push(`Observation ${index + 1} has an unsafe relative path`);
    } else {
      valid.push(observation);
    }
  });

  const candidates = FOLDER_PATTERN_CANDIDATES.map((candidate): FolderPatternCandidateScore => {
    let eligible = 0;
    let matched = 0;
    for (const observation of valid) {
      const series = observation.isSeries
        ?? Boolean(observation.metadata.series && observation.metadata.series_number !== null
          && observation.metadata.series_number !== undefined);
      const rendered = renderFolderPattern(
        series ? candidate.series : candidate.standalone,
        observation.metadata,
      );
      if (!rendered.eligible) continue;
      eligible += 1;
      if (rendered.relativePath === observation.relativePath) matched += 1;
    }
    return {
      ...candidate,
      eligible,
      matched,
      // Missing metadata lowers confidence instead of making a candidate look
      // perfect on a small convenient subset of the observations.
      confidence: valid.length === 0 ? 0 : matched / valid.length,
    };
  }).sort((left, right) =>
    right.confidence - left.confidence
      || right.matched - left.matched
      || right.eligible - left.eligible
      || left.id.localeCompare(right.id));

  const winner = candidates[0];
  const runnerUp = candidates[1];
  const ambiguity = Boolean(
    winner
    && runnerUp
    && winner.eligible >= FOLDER_PATTERN_MINIMUM_EVIDENCE
    && winner.confidence - runnerUp.confidence < FOLDER_PATTERN_WINNER_MARGIN,
  );
  const sufficientEvidence = Boolean(winner && winner.eligible >= FOLDER_PATTERN_MINIMUM_EVIDENCE);
  const sufficientConfidence = Boolean(winner && winner.confidence >= FOLDER_PATTERN_MINIMUM_CONFIDENCE);
  const proposal = winner && sufficientEvidence && sufficientConfidence && !ambiguity
    ? LibraryFolderPatternSchema.parse({
      libraryId: identity.libraryId,
      rootDir: identity.rootDir,
      standalone: winner.standalone,
      series: winner.series,
      source: "detected",
    })
    : undefined;

  return {
    ...identity,
    observed: relevant.length,
    eligible: winner?.eligible ?? 0,
    matched: winner?.matched ?? 0,
    issues,
    confidence: winner?.confidence ?? 0,
    ambiguity,
    candidates,
    proposal,
  };
}

/** Analyze each explicitly configured root independently; unknown libraries are ignored. */
export function analyzeFolderPatterns(
  libraries: ReadonlyArray<Pick<LibraryFolderPattern, "libraryId" | "rootDir">>,
  observations: readonly FolderPatternObservation[],
): FolderPatternAnalysis[] {
  return libraries.map((library) => detectFolderPattern(library, observations));
}
