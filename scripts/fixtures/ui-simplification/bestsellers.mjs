/**
 * Synthetic browser-fixture data for the P0 UI baseline. This data must never
 * be confused with a provider response or used to make an acquisition choice.
 */

export const SYNTHETIC_BESTSELLER_LABEL = "Synthetic UI fixture — no live provider data";

export const BESTSELLER_FIXTURE_SOURCES = [
  "audible",
  "audiobooksnow",
  "apple",
  "nyt-fiction",
  "nyt-nonfiction",
];

const responseKeyBySource = {
  audible: "audible",
  audiobooksnow: "audiobooksnow",
  apple: "apple",
  "nyt-fiction": "nytFiction",
  "nyt-nonfiction": "nytNonfiction",
};

const specialBooks = {
  1: {
    title: "The Signal: A Novel (Unabridged)",
    author: "A. Fixture",
    description: "<p>A deliberately synthetic signal crosses five charts.</p>",
  },
  2: {
    title: "A Title With Punctuation — Again?!",
    author: "Zoë Fixture-Smith",
    description: "A long punctuation case; it is synthetic, repeatable, and safe for browser captures.",
  },
  3: {
    title: "星の航路: Synthetic Edition",
    author: "Keiko Tanaka",
    description: "架空のチャート項目です。Synthetic non-Latin text verifies that baseline captures keep it readable.",
  },
  4: {
    title: "The Very Long Fixture Title Designed to Exercise Two-Line Card Layouts Without Referring to Any Real Publication",
    author: "A. Deliberately Long Fixture Author Name",
    description: "A deliberately long synthetic description. ".repeat(12),
  },
  5: {
    title: "Coverless Fixture",
    author: "M. Placeholder",
    description: "This synthetic book intentionally has no cover.",
    coverUrl: "",
  },
  6: {
    title: "Descriptionless Fixture",
    author: "N. Empty",
    description: "",
  },
};

function fixtureBook(id, source) {
  const special = specialBooks[id] ?? {};
  const sourceSuffix = id === 1 && source === "apple" ? "The Signal" : special.title;
  const title = sourceSuffix ?? `Synthetic Candidate ${String(id).padStart(2, "0")}: Baseline Chart Entry`;
  const author = special.author ?? `Fixture Author ${String(id).padStart(2, "0")}`;

  return {
    title,
    author,
    coverUrl: special.coverUrl ?? `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect width="80" height="80" fill="#356f72"/><text x="40" y="45" text-anchor="middle" fill="white" font-family="sans-serif" font-size="20">${id}</text></svg>`)}`,
    description: special.description ?? `Synthetic description for candidate ${id}; it exists only for deterministic UI baseline captures.`,
    source,
  };
}

function list(source, ids) {
  return ids.map((id) => fixtureBook(id, source));
}

/**
 * Forty distinct consensus candidates, represented by 48 source appearances.
 * IDs 1–4 intentionally appear in multiple source lists to exercise badges.
 */
export const SUCCESSFUL_BESTSELLERS_RESPONSE = Object.freeze({
  fixture: SYNTHETIC_BESTSELLER_LABEL,
  results: {
    audible: list("audible", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    audiobooksnow: list("audiobooksnow", [1, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]),
    apple: list("apple", [1, 2, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33]),
    nytFiction: list("nyt-fiction", [1, 3, 34, 35, 36, 37, 38, 39]),
    nytNonfiction: list("nyt-nonfiction", [2, 3, 4, 40]),
  },
});

export const EMPTY_BESTSELLERS_RESPONSE = Object.freeze({
  fixture: SYNTHETIC_BESTSELLER_LABEL,
  results: Object.fromEntries(
    Object.values(responseKeyBySource).map((responseKey) => [responseKey, []]),
  ),
});

export const ERROR_BESTSELLERS_RESPONSE = Object.freeze({
  fixture: SYNTHETIC_BESTSELLER_LABEL,
  error: "Synthetic bestseller endpoint failure",
});

/**
 * The P0 component only reads `results`; it currently renders this 200 error
 * envelope as an empty chart. Keep this explicit so that P3 source-status work
 * can demonstrate the behavior changed, rather than hiding it in test data.
 */
export const SUCCESS_FALSE_BESTSELLERS_RESPONSE = Object.freeze({
  success: false,
  fixture: SYNTHETIC_BESTSELLER_LABEL,
  error: "Synthetic provider failure returned with HTTP 200",
  results: EMPTY_BESTSELLERS_RESPONSE.results,
});

export const BESTSELLER_FIXTURE_SCENARIOS = Object.freeze({
  success: { status: 200, body: SUCCESSFUL_BESTSELLERS_RESPONSE, expectedCards: 40 },
  empty: { status: 200, body: EMPTY_BESTSELLERS_RESPONSE, expectedCards: 0 },
  error: { status: 503, body: ERROR_BESTSELLERS_RESPONSE, expectedCards: 0 },
  "success-false-200": { status: 200, body: SUCCESS_FALSE_BESTSELLERS_RESPONSE, expectedCards: 0 },
});
