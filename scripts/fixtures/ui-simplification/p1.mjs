/**
 * Deliberately synthetic P1 browser-fixture data. It is only served from the
 * local Playwright harness; it must never describe or contact a real library.
 */
export const SYNTHETIC_P1_LABEL = "Synthetic P1 fixture — no live library or provider";

export const P1_BOOK = {
  id: "fixture-book-1", title: "Harbor Fog", author: "M. Shore", narrator: "A. Reader",
  series: null, seriesSequence: null, durationSeconds: 28800, publishedYear: 2024,
  genres: ["Mystery"], description: "A synthetic shelf title.", coverPath: null,
  tags: [{ id: 1, bookId: "fixture-book-1", tag: "mystery", category: "genre", confidence: 1 }],
};

export const P1_COLLECTION = { id: 1, name: "Fixture collection", description: "Synthetic", theme: "coastal", status: "proposed", absCollectionId: null, createdAt: 1_725_000_000_000, pushedAt: null, books: [P1_BOOK] };
export const P1_PIPELINE = { downloading: [], processing: [], requiresInput: [], shelved24h: [] };
const measurement = { status: "Great", score: 100, total: 1, observed: 1, configuredObserved: 1, eligible: 1, matched: 1, issues: 0, coverage: 100 };
export const P1_LIBRARY_HEALTH = { success: true, health: { metadata: { score: 100, status: "Great" }, files: { score: 100, status: "Great" }, structure: measurement, duplicates: { score: 100, status: "Great" } }, overallScore: 100, totals: { books: 1, completeMetadata: 1, m4b: 1, structureIssues: 0, duplicates: 0 }, unmeasured: [], generatedAt: 1_725_000_000_000 };
export const P1_READINESS = { totalBooks: 1, metrics: [{ key: "embedded", label: "Embedded", pct: 100, covered: 1, unknown: 0, stale: 0, total: 1, status: "Great" }], unmeasured: [], disclosure: null, caveat: null, schemaVersion: 1, generatedAt: 1_725_000_000_000 };

export const P1_SETTINGS = {
  libraryDir: "/synthetic/library", inboxDir: "/synthetic/inbox", absUrl: "http://fixture.invalid",
  qbitUrl: "http://fixture.invalid", qbitUser: "fixture", ollamaUrl: "http://fixture.invalid",
  ollamaModel: "fixture", llmPriority: "local-first", recommendationScope: "discover",
  debugLogs: false, actionLogLevel: "info", useProxy: false, torrentTrackers: "",
  pathMappings: [], libraryFolderPatterns: [],
  secretStatus: { absTokenConfigured: false, qbitPassConfigured: false, anthropicApiKeyConfigured: false, nytApiKeyConfigured: false, proxyUrlConfigured: false },
  managedByEnvironment: [],
};

export const P1_CONVERSATION = {
  id: "fixture-conversation-1", createdAt: 1_725_000_000_000, updatedAt: 1_725_000_100_000,
  turnCount: 1, latestStatus: "answered", latestQuestion: "What is already on my shelf?",
};

export const P1_CHAT_EVENTS = [
  ["action", { tool: "librarySearch", label: "Searching your shelf", detail: "Synthetic fixture", resultSummary: "1 match" }],
  ["answer", { recommendations: [{ bookId: P1_BOOK.id, title: P1_BOOK.title, author: P1_BOOK.author, reason: "Synthetic evidence-backed shelf match.", durationSeconds: P1_BOOK.durationSeconds, matchedTags: ["mystery"] }] }],
  ["done", { status: "answered", rounds: 1, tokensUsed: { inputTokens: 1, outputTokens: 1 } }],
];

export const P1_FOLLOW_UP_EVENTS = [
  ["action", { tool: "librarySearch", label: "Following up on your shelf", detail: "Synthetic fixture", resultSummary: "1 match" }],
  ["answer", { recommendations: [{ bookId: P1_BOOK.id, title: P1_BOOK.title, author: P1_BOOK.author, reason: "Synthetic follow-up evidence.", durationSeconds: P1_BOOK.durationSeconds, matchedTags: ["mystery"] }] }],
  ["done", { status: "answered", rounds: 1, tokensUsed: { inputTokens: 2, outputTokens: 2 } }],
];

export function sse(events = P1_CHAT_EVENTS) {
  return events.map(([event, payload]) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`).join("");
}

/** Mirrors the local frontend API types enough to fail before a blank screen can hide fixture drift. */
export function assertP1FixtureContracts() {
  const require = (condition, message) => { if (!condition) throw new Error(`Invalid P1 fixture: ${message}`); };
  const requireKeys = (value, keys, message) => require(value && keys.every(key => key in value), message);
  const requireString = (value, message) => require(typeof value === "string", message);
  const requireNumber = (value, message) => require(typeof value === "number" && Number.isFinite(value), message);
  const requireBoolean = (value, message) => require(typeof value === "boolean", message);
  const requireNullableString = (value, message) => require(value === null || typeof value === "string", message);
  require(["id", "title", "author", "series", "seriesSequence", "durationSeconds", "publishedYear", "genres", "description", "coverPath"].every(key => key in P1_BOOK), "Book fields");
  requireString(P1_BOOK.id, "Book id");
  requireString(P1_BOOK.title, "Book title");
  requireString(P1_BOOK.author, "Book author");
  require(P1_BOOK.series === null || typeof P1_BOOK.series === "string", "Book series");
  require(P1_BOOK.seriesSequence === null || typeof P1_BOOK.seriesSequence === "number", "Book series sequence");
  requireNumber(P1_BOOK.durationSeconds, "Book duration");
  requireNumber(P1_BOOK.publishedYear, "Book year");
  require(Array.isArray(P1_BOOK.genres) && P1_BOOK.genres.every(item => typeof item === "string"), "Book genres");
  requireString(P1_BOOK.description, "Book description");
  requireNullableString(P1_BOOK.coverPath, "Book cover path");
  require(Array.isArray(P1_BOOK.tags) && P1_BOOK.tags.every(tag => typeof tag.id === "number" && tag.bookId === P1_BOOK.id && typeof tag.tag === "string" && typeof tag.category === "string" && typeof tag.confidence === "number"), "Book tags");
  require(["id", "name", "description", "theme", "status", "absCollectionId", "createdAt", "pushedAt", "books"].every(key => key in P1_COLLECTION), "Collection fields");
  requireNumber(P1_COLLECTION.id, "Collection id");
  requireString(P1_COLLECTION.name, "Collection name");
  require(["proposed", "pushed"].includes(P1_COLLECTION.status), "Collection status");
  require(Array.isArray(P1_COLLECTION.books) && P1_COLLECTION.books[0]?.id === P1_BOOK.id, "Collection books");
  require(["downloading", "processing", "requiresInput", "shelved24h"].every(key => Array.isArray(P1_PIPELINE[key])), "Acquisition pipeline fields");
  requireKeys(P1_LIBRARY_HEALTH, ["success", "health", "overallScore", "totals", "unmeasured", "generatedAt"], "Library health envelope");
  require(P1_LIBRARY_HEALTH.success === true && ["metadata", "files", "structure", "duplicates"].every(key => P1_LIBRARY_HEALTH.health[key]?.status), "Library health statuses");
  require(P1_LIBRARY_HEALTH.health.structure.total === 1 && P1_LIBRARY_HEALTH.totals.books === 1 && Array.isArray(P1_LIBRARY_HEALTH.unmeasured), "Library health totals");
  requireKeys(P1_READINESS, ["totalBooks", "metrics", "unmeasured", "disclosure", "caveat", "schemaVersion", "generatedAt"], "Readiness envelope");
  require(P1_READINESS.totalBooks === 1 && Array.isArray(P1_READINESS.metrics) && P1_READINESS.metrics[0]?.pct === 100, "Readiness fields");
  requireKeys(P1_SETTINGS, ["libraryDir", "inboxDir", "absUrl", "qbitUrl", "qbitUser", "ollamaUrl", "ollamaModel", "llmPriority", "recommendationScope", "debugLogs", "actionLogLevel", "useProxy", "torrentTrackers", "pathMappings", "libraryFolderPatterns", "secretStatus", "managedByEnvironment"], "Settings fields");
  for (const key of ["libraryDir", "inboxDir", "absUrl", "qbitUrl", "qbitUser", "ollamaUrl", "ollamaModel", "llmPriority", "recommendationScope", "actionLogLevel", "torrentTrackers"]) requireString(P1_SETTINGS[key], `Settings ${key}`);
  for (const key of ["debugLogs", "useProxy"]) requireBoolean(P1_SETTINGS[key], `Settings ${key}`);
  require(Array.isArray(P1_SETTINGS.pathMappings) && Array.isArray(P1_SETTINGS.libraryFolderPatterns) && Array.isArray(P1_SETTINGS.managedByEnvironment), "Settings arrays");
  requireKeys(P1_SETTINGS.secretStatus, ["absTokenConfigured", "qbitPassConfigured", "anthropicApiKeyConfigured", "nytApiKeyConfigured", "proxyUrlConfigured"], "Settings secret status");
  for (const value of Object.values(P1_SETTINGS.secretStatus)) requireBoolean(value, "Secret status values");
  requireKeys(P1_CONVERSATION, ["id", "createdAt", "updatedAt", "turnCount", "latestStatus", "latestQuestion"], "Conversation summary");
  requireString(P1_CONVERSATION.id, "Conversation id");
  requireNumber(P1_CONVERSATION.createdAt, "Conversation createdAt");
  requireNumber(P1_CONVERSATION.updatedAt, "Conversation updatedAt");
  requireNumber(P1_CONVERSATION.turnCount, "Conversation turn count");
  requireString(P1_CONVERSATION.latestStatus, "Conversation latestStatus");
  requireString(P1_CONVERSATION.latestQuestion, "Conversation latestQuestion");
  for (const [name, events] of [["chat", P1_CHAT_EVENTS], ["follow-up", P1_FOLLOW_UP_EVENTS]]) {
    require(Array.isArray(events) && events.length >= 2, `${name} events`);
    for (const [type, event] of events) {
      require(["action", "answer", "done"].includes(type), `${name} event type`);
      if (type === "action") requireKeys(event, ["tool", "label", "detail", "resultSummary"], `${name} action event`);
      if (type === "answer") require(Array.isArray(event.recommendations) && event.recommendations[0]?.bookId === P1_BOOK.id && typeof event.recommendations[0]?.reason === "string", `${name} answer event`);
      if (type === "done") require(event.status === "answered" && typeof event.rounds === "number" && typeof event.tokensUsed?.inputTokens === "number" && typeof event.tokensUsed?.outputTokens === "number", `${name} done event`);
    }
  }
}
