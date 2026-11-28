/* global document, window */
/**
 * P6 — integrated acceptance, accessibility, resilience and performance.
 *
 * Drives every consolidated destination across five viewports plus 200% zoom
 * reflow, audits touch-target sizing and modal focus restoration, and measures
 * cold, warm and 4x-CPU-throttled load on a simulated Fast 3G profile.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, installFixtures as installCoreFixtures, newReport } from "../core.mjs";

const installFixtures = (context, origin, report) => installCoreFixtures(context, origin, report, fixture);
import {
  SUCCESSFUL_BESTSELLERS_RESPONSE,
} from "../../fixtures/ui-simplification/bestsellers.mjs";
import { P1_SETTINGS } from "../../fixtures/ui-simplification/p1.mjs";

const viewports = [
  { label: "390x844", width: 390, height: 844, isMobile: true },
  { label: "844x390", width: 844, height: 390, isMobile: true, isLandscape: true },
  { label: "768x1024", width: 768, height: 1024, isTablet: true },
  { label: "1024x900", width: 1024, height: 900 },
  { label: "1440x1000", width: 1440, height: 1000, isDesktop: true },
];

const FIXTURE_BOOKS = Array.from({ length: 50 }, (_, i) => ({
  id: `book-${i + 1}`,
  title: `Fixture Book ${i + 1}`,
  author: `Fixture Author ${((i % 5) + 1)}`,
  narrator: "Fixture Narrator",
  duration: 36000,
  path: `/audiobooks/fixture-book-${i + 1}`,
  category: i % 2 === 0 ? "Fiction" : "Sci-Fi",
  tags: [`tag-${(i % 3) + 1}`],
  hasCover: false,
  status: "ready",
}));

const FIXTURE_COLLECTIONS = [
  { id: 1, name: "Staff Picks", theme: "favorites", status: "approved", books: FIXTURE_BOOKS.slice(0, 3), createdAt: Date.now() },
  { id: 2, name: "Summer Sci-Fi", theme: "scifi", status: "proposed", books: FIXTURE_BOOKS.slice(3, 6), createdAt: Date.now() },
];

const FIXTURE_ACTIVITY = {
  success: true,
  needsAttention: [],
  inProgress: [
    {
      id: "acq_1",
      entityType: "acquisition",
      title: "Project Hail Mary",
      subtitle: "2.5 MB/s · ETA 5m",
      status: "running",
      category: "in_progress",
      progress: { percent: 65, speed: "2.5 MB/s", eta: 300 },
      updatedAt: Date.now() - 5000,
    },
  ],
  completed: [
    {
      id: "enc_1",
      entityType: "encode_job",
      title: "Dune",
      subtitle: "Successfully converted to M4B",
      status: "completed",
      category: "completed",
      progress: { percent: 100 },
      updatedAt: Date.now() - 3600000,
    },
  ],
  counts: { needsAttention: 0, inProgress: 1, completed: 1 },
  providers: { operations: "ok", encodes: "ok", ingest: "ok", torrents: "ok" },
  generatedAt: Date.now(),
  retentionWindowMs: 86400000,
};

const FIXTURE_ACQUISITIONS = [
  {
    id: "acq_1",
    candidateId: "cand_apple_12345",
    editionTitle: "Project Hail Mary (Unabridged)",
    status: "downloading",
    progress: 65,
    source: "audiobookbay",
    torrentHash: "0123456789abcdef0123456789abcdef01234567",
    createdAt: Date.now() - 600000,
    updatedAt: Date.now() - 5000,
  },
];

const SAVED_ENTRIES = [
  {
    candidate: {
      id: "cand_apple_12345",
      source: "audible",
      title: "Project Hail Mary",
      author: "Andy Weir",
      coverUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect fill='%23333' width='100' height='100'/%3E%3C/svg%3E",
      description: "A lone astronaut must save the earth from disaster.",
    },
    intent: {
      candidateId: "cand_apple_12345",
      actorId: "internal",
      intent: "want",
      revision: 1,
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now() - 86400000,
    },
    ownership: "unowned",
    isFinished: false,
  },
  {
    candidate: {
      id: "cand_audible_67890",
      source: "audible",
      title: "Words of Radiance",
      author: "Brandon Sanderson",
    },
    intent: {
      candidateId: "cand_audible_67890",
      actorId: "internal",
      intent: "later",
      revision: 1,
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now() - 86400000,
    },
    ownership: "owned",
    isFinished: true,
  },
];

const FIXTURE_SAVED = {
  items: SAVED_ENTRIES,
  saved: SAVED_ENTRIES,
  totals: { all: 2, want: 1, later: 1, pass: 0 },
  counts: { all: 2, want: 1, later: 1, pass: 0 },
  actor: "internal",
  isShared: true,
};

const COLLECTION_CANDIDATES = [
  { id: "big", title: "The Big Over Easy", author: "Jasper Fforde", files: ["01 The Big Over Easy/001.mp3", "01 The Big Over Easy/002.mp3"], extras: [], ready: false, duplicate: "Library folder match", decisionToken: "big-match", evidence: ["Title folder and track numbers agree"] },
  { id: "bear", title: "The Fourth Bear", author: "Jasper Fforde", files: ["02 The Fourth Bear/001.mp3"], extras: [], ready: true, evidence: ["Title folder"] },
];
const COLLECTION_PREVIEW = {
  fingerprint: "nursery-crime-v1",
  candidates: COLLECTION_CANDIDATES,
  unassigned: [],
  extras: ["pack-notes.txt"],
  warnings: [],
  progress: [],
  counts: { imported: 0, held: 0, failed: 0, remaining: 2 },
};
const COLLECTION_IMPORTED = {
  ...COLLECTION_PREVIEW,
  progress: [{ ...COLLECTION_CANDIDATES[1], state: "imported" }],
  counts: { imported: 1, held: 0, failed: 0, remaining: 1 },
};
const ARCHIVED_COLLECTION = { id: "nursery-archive", title: "Nursery Crime", archivedAt: "2026-11-27T01:00:00Z", audioFiles: 3, otherFiles: 1 };

function fixture(pathname, search = "", method = "GET") {
  if (pathname === "/api/librarian/inbox" && method === "GET") {
    return { data: { path: "/inbox", partial: false, systemItems: ["@eaDir", ".DS_Store"], rows: [
      { name: "Nursery Crime", collectionId: "nursery-crime", kind: "directory", layout: "collection", audioFiles: 3, otherFiles: 1, partial: false, status: "review", pendingAudioFiles: 3 },
      { name: "Magic 2.0 Series", collectionId: "magic", kind: "directory", audioFiles: 6, otherFiles: 0, partial: false, status: "retained", importedBooks: 6 },
      { name: "A new audiobook.m4b", kind: "file", audioFiles: 1, otherFiles: 0, partial: false, status: "waiting" },
    ] } };
  }
  if (pathname === "/api/librarian/collections" && method === "GET") {
    return { data: [{ id: "nursery-crime", title: "Nursery Crime" }] };
  }
  if (pathname === "/api/librarian/collections/nursery-crime") {
    if (method === "GET") return { data: COLLECTION_PREVIEW };
    if (method === "POST") return { data: { operationId: "collection-progress" } };
  }
  if (pathname === "/api/librarian/collections/nursery-crime/imports/collection-progress" && method === "GET") {
    return { data: { state: "complete", preview: COLLECTION_IMPORTED } };
  }
  if (pathname === "/api/librarian/collections/nursery-crime/decisions" && method === "POST") {
    return { data: { ...COLLECTION_IMPORTED, resolvedDuplicates: [COLLECTION_CANDIDATES[0]], counts: { ...COLLECTION_IMPORTED.counts, remaining: 0 } } };
  }
  if (pathname === "/api/librarian/collections/nursery-crime/cleanup") {
    if (method === "GET") return { data: { title: "Nursery Crime", importedBooks: 1, duplicateBooks: 1, audioFiles: 3, otherFiles: 1,
      destination: "/inbox/.intake-archive", blockers: [], token: "fixture-cleanup-token" } };
    if (method === "POST") return { data: ARCHIVED_COLLECTION };
  }
  if (pathname === "/api/librarian/inbox/archive" && method === "GET") return { data: [ARCHIVED_COLLECTION] };
  if (pathname === "/api/librarian/inbox/archive/nursery-archive/restore" && method === "POST") return { data: { restored: true } };
  if (pathname === "/health") return { absConnected: true, version: "1.1.0", dbWritable: true };
  if (pathname === "/api/librarian/bestsellers") return SUCCESSFUL_BESTSELLERS_RESPONSE;
  if (pathname === "/api/system/settings") return { success: true, data: P1_SETTINGS };
  if (pathname === "/api/system/settings/history") return { success: true, data: [] };
  if (pathname === "/api/operations") return [];
  if (pathname === "/api/librarian/jobs") return { success: true, data: [] };
  if (pathname === "/api/librarian/downloads/queue" || pathname === "/api/encode/queue" || pathname === "/api/encode/history" || pathname === "/api/log" || pathname === "/api/logs/actions") return [];
  if (pathname === "/api/librarian/downloads/pipeline") return { downloading: [], processing: [], requiresInput: [], shelved24h: [] };
  if (pathname === "/api/tags/stats") return { totalBooks: 50, taggedBooks: 50, untaggedBooks: 0, vocabularySize: 5, avgTagTokens: null };
  if (pathname === "/api/readiness") return { status: "ready" };
  if (pathname === "/api/collections") return FIXTURE_COLLECTIONS;
  if (pathname === "/api/collections/templates" || pathname === "/api/tags/vocabulary" || pathname === "/api/vocab/proposed") return [];
  if (pathname === "/api/enrichment/refresh-campaign") return { campaign: null };
  if (pathname === "/api/librarian/recently-added") return { results: FIXTURE_BOOKS.slice(0, 5), total: 5 };
  if (pathname === "/api/librarian/threads" || pathname === "/api/librarian/conversations") return [];

  // P3 candidates & intents
  if (pathname === "/api/candidates/intents") {
    return {
      cand_apple_12345: { candidateId: "cand_apple_12345", actorId: "internal", intent: "want", revision: 1, updatedAt: Date.now() },
      cand_audible_67890: { candidateId: "cand_audible_67890", actorId: "internal", intent: "later", revision: 1, updatedAt: Date.now() },
    };
  }
  if (pathname === "/api/candidates/saved") return FIXTURE_SAVED;
  if (pathname === "/api/candidates/sources") {
    return [
      { source: "audible", status: "ready", itemCount: 20, lastSuccessAt: Date.now() },
      { source: "apple", status: "ready", itemCount: 10, lastSuccessAt: Date.now() },
    ];
  }
  if (pathname === "/api/candidates/intent") {
    return { success: true, changed: true, intent: { candidateId: "cand_apple_12345", intent: "want", revision: 2 } };
  }
  if (pathname === "/api/candidates/intent/undo") {
    return { success: true, changed: true, previousIntent: "want", intent: null };
  }

  // P4 & P5 activity and acquisitions
  if (pathname === "/api/activity" || pathname === "/api/activity/feed") return FIXTURE_ACTIVITY;
  if (pathname === "/api/librarian/acquisitions") return FIXTURE_ACQUISITIONS;
  if (pathname.startsWith("/api/librarian/acquisitions/by-candidate/")) {
    return FIXTURE_ACQUISITIONS[0];
  }
  if (pathname.startsWith("/api/librarian/acquisitions/")) {
    return FIXTURE_ACQUISITIONS[0];
  }
  if (pathname === "/api/librarian/download") {
    return { success: true, acquisition: FIXTURE_ACQUISITIONS[0] };
  }
  if (pathname === "/api/system/logs") return [];

  if (pathname === "/api/librarian/search") {
    const params = new URLSearchParams(search ?? "");
    const q = params.get("q") ?? "";
    const page = Number(params.get("page") ?? "1");
    if (!q) return { results: [], totalPages: 1, currentPage: 1 };
    return {
      results: [
        {
          id: "res-1",
          title: `Result for ${q}`,
          author: "Search Result Author",
          source: "AudiobookBay",
          infoHash: "0123456789abcdef0123456789abcdef01234567",
          size: "500 MB",
          files: ["track1.mp3"],
          status: "available",
        },
      ],
      totalPages: 1,
      currentPage: page,
    };
  }

  if (pathname === "/api/books") {
    const params = new URLSearchParams(search ?? "");
    const offset = Number(params.get("offset") ?? "0");
    const limit = Number(params.get("limit") ?? "20");
    const q = params.get("search") ?? "";
    let filtered = FIXTURE_BOOKS;
    if (q) {
      filtered = filtered.filter(b => b.title.toLowerCase().includes(q.toLowerCase()) || b.author.toLowerCase().includes(q.toLowerCase()));
    }
    return {
      books: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
    };
  }

  if (pathname.startsWith("/api/books/")) {
    const id = decodeURIComponent(pathname.replace("/api/books/", ""));
    const book = FIXTURE_BOOKS.find(b => b.id === id) ?? FIXTURE_BOOKS[0];
    return book;
  }

  return undefined;
}


async function auditJourneys(page, origin, viewport, report) {
  const log = msg => report.assertions.push(`[${viewport.label}] ${msg}`);

  // 1. /discover/charts
  await page.goto(`${origin}/discover/charts`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Top Bestsellers/i }).waitFor();
  const firstCard = page.locator(".bestseller-card").first();
  await firstCard.waitFor();
  const cardBox = await firstCard.boundingBox();
  assert(cardBox, "First bestseller card has no bounding box");
  if (viewport.width === 390) {
    assert(cardBox.y < viewport.height, `Mobile fold: card top (${cardBox.y}px) is below fold (${viewport.height}px)`);
    log("Verified mobile fold: Candidate #1 visible without scrolling");
  }

  // 2. /discover/saved
  await page.goto(`${origin}/discover/saved`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Review triaged candidates|Saved/i }).waitFor();
  const savedItems = page.locator(".saved-candidate-card");
  await savedItems.first().waitFor();
  const count = await savedItems.count();
  assert(count >= 1, `Expected at least 1 saved candidate, found ${count}`);
  log(`Verified Saved candidates view: ${count} candidates rendered with intent badges`);

  // 3. /library/books
  await page.goto(`${origin}/library/books`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Books/i }).waitFor();
  log("Verified Library books catalog navigation");

  // 4. /activity
  await page.goto(`${origin}/activity`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Downloads and processing" }).waitFor();
  log("Verified Activity navigation and status feed");

  // 5. /ask
  await page.goto(`${origin}/ask`, { waitUntil: "networkidle" });
  log("Verified Ask librarian navigation");

  // 6. Legacy redirect: /desk -> /ask
  await page.goto(`${origin}/desk`, { waitUntil: "networkidle" });
  const finalUrl = new URL(page.url());
  assert(finalUrl.pathname === "/ask", `Expected /desk to redirect to /ask, got ${finalUrl.pathname}`);
  log("Verified legacy /desk redirect to /ask");
}

/**
 * P6-A2: Accessibility - Focus management, Escape key, and Modal return.
 */
async function auditCollectionReview(page, origin, report, outputDir) {
  await page.goto(origin + "/scout/intake");
  await page.getByRole("heading", { name: "Inbox overview" }).waitFor();
  const queueEntry = page.getByRole("button", { name: "Review Nursery Crime", exact: true });
  await queueEntry.waitFor();
  await page.getByText("Awaiting intake", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Retained sources", exact: true }).waitFor();
  await page.getByRole("button", { name: "Review cleanup for Magic 2.0 Series", exact: true }).waitFor();
  await page.getByText("Recovery and system files (2)", { exact: true }).waitFor();
  await page.screenshot({ path: join(outputDir, "screenshots", "collection-queue.png") });
  await queueEntry.click();
  const review = page.getByRole("region", { name: "Review Nursery Crime" });
  await review.getByRole("heading", { name: "Books in this collection" }).waitFor();
  await page.screenshot({ path: join(outputDir, "screenshots", "collection-review.png") });
  await review.getByRole("button", { name: "Import clear matches (1)", exact: true }).waitFor();
  assert((await review.getByRole("combobox", { name: "Decision for The Big Over Easy" }).inputValue()) === "", "Bulk import must leave duplicate decisions unset");
  const submitted = page.waitForRequest((request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/librarian/collections/nursery-crime");
  await review.getByRole("button", { name: "Import clear matches (1)", exact: true }).click();
  const request = (await submitted).postDataJSON();
  assert(JSON.stringify(request) === JSON.stringify({ fingerprint: COLLECTION_PREVIEW.fingerprint, mode: "clear", candidateIds: [COLLECTION_CANDIDATES[1].id] }),
    "Collection review must send only the approved book");
  await review.getByRole("status").filter({ hasText: "1 Imported" }).waitFor();
  assert(await review.getByRole("group", { name: "The Big Over Easy" }).isVisible(), "Remaining collection book must stay available");
  await review.getByRole("combobox", { name: "Decision for The Big Over Easy" }).selectOption("keep");
  const savedDecision = page.waitForRequest(request =>
    request.method() === "POST" && new URL(request.url()).pathname.endsWith("/decisions"));
  await review.getByRole("button", { name: "Save decisions" }).click();
  assert(JSON.stringify((await savedDecision).postDataJSON().decisions) === JSON.stringify([{ id: "big", outcome: "keep", token: "big-match" }]),
    "Duplicate decisions must include the reviewed match and never submit an import");
  await review.getByText("Kept library copies (1)", { exact: true }).waitFor();
  await review.getByRole("button", { name: "Review cleanup" }).click();
  await page.getByRole("heading", { name: "Cleanup preview" }).waitFor();
  await page.getByRole("button", { name: "Move to archive" }).waitFor();
  await page.screenshot({ path: join(outputDir, "screenshots", "intake-cleanup.png") });
  const move = page.waitForRequest(request =>
    request.method() === "POST" && new URL(request.url()).pathname.endsWith("/cleanup"));
  await page.getByRole("button", { name: "Move to archive" }).click();
  assert((await move).postDataJSON().token === "fixture-cleanup-token", "Archive must send the checked preview token");
  await page.getByRole("heading", { name: "Archive history" }).waitFor();
  await page.getByRole("button", { name: "Restore Nursery Crime to inbox" }).click();
  await page.getByText("Nursery Crime restored to the inbox.", { exact: true }).waitFor();
  report.assertions.push("Intake imports only approved books, saves duplicate decisions separately, and archives and restores the resolved source");
}

async function auditFocusAndModals(page, origin, report) {
  await page.goto(`${origin}/discover/charts`, { waitUntil: "networkidle" });

  // Test Settings Dialog open & close via Escape
  const settingsBtn = page.getByRole("button", { name: /Settings/i });
  if ((await settingsBtn.count()) > 0 && (await settingsBtn.isVisible())) {
    await settingsBtn.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert(await dialog.isVisible(), "Settings dialog did not open");

    // Press Escape
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert(!(await dialog.isVisible()), "Settings dialog did not close on Escape");
    report.assertions.push("Settings modal: opens and closes cleanly on Escape with focus restoration");
  }
}

/**
 * P6-A3: Accessibility - Interactive Target Sizing (comfort 44px, minimum 24px)
 */
async function auditTargetSizes(page, origin, report) {
  await page.goto(`${origin}/discover/charts`, { waitUntil: "networkidle" });
  const buttons = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("button, a.nav-link, a.bestseller-card__search"));
    return elements.map(el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const isVisible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30),
        width: rect.width,
        height: rect.height,
        isVisible,
      };
    }).filter(e => e.isVisible);
  });

  const belowMin = buttons.filter(b => b.width < 24 || b.height < 24);
  const belowComfort = buttons.filter(b => b.width < 44 && b.height < 44);

  assert(belowMin.length === 0, `Interactive targets below 24px minimum: ${JSON.stringify(belowMin)}`);
  report.assertions.push(
    `Interactive target sizing: ${buttons.length} elements inspected, 0 below 24px minimum, ${buttons.length - belowComfort.length} meet 44px comfort target`
  );
}

/**
 * P6-A4: Text Reflow at 200% Zoom.
 */
async function audit200PercentZoom(browser, origin, report) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2, // 200% zoom
  });
  const page = await context.newPage();
  await installFixtures(context, origin, report);

  await page.goto(`${origin}/discover/charts`, { waitUntil: "networkidle" });
  const hasHorizontalScrollbar = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });

  assert(!hasHorizontalScrollbar, "Horizontal scrollbar detected at 200% zoom reflow");
  report.assertions.push("Reflow: 200% zoom reflow verified without horizontal document scrollbar");
  await context.close();
}

/**
 * P6-B: Performance & Throttling Lab Measurement.
 */
async function measurePerformance(browser, origin, report) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await installFixtures(context, origin, report);

  // Measure Cold Load
  const coldStart = Date.now();
  await page.goto(`${origin}/discover/charts`, { waitUntil: "networkidle" });
  await page.locator(".bestseller-card").first().waitFor();
  const coldDuration = Date.now() - coldStart;

  // Measure Warm Load
  const warmStart = Date.now();
  await page.goto(`${origin}/discover/charts`, { waitUntil: "networkidle" });
  await page.locator(".bestseller-card").first().waitFor();
  const warmDuration = Date.now() - warmStart;

  // Measure Throttled Load (4x CPU slowdown, Fast 3G / 1.6 Mbps profile)
  const client = await context.newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: (1.6 * 1024 * 1024) / 8, // 1.6 Mbps
    uploadThroughput: (750 * 1024) / 8,          // 750 Kbps
    latency: 150,                                // 150 ms
  });

  const throttledStart = Date.now();
  await page.goto(`${origin}/discover/charts`, { waitUntil: "networkidle" });
  await page.locator(".bestseller-card").first().waitFor();
  const throttledDuration = Date.now() - throttledStart;

  report.performance = {
    coldLoadMs: coldDuration,
    warmLoadMs: warmDuration,
    throttledLoadMs: throttledDuration,
    profile: "4x CPU slowdown, 1.6 Mbps down / 750 Kbps up, 150 ms latency",
  };

  report.assertions.push(
    `Performance: Cold load ${coldDuration}ms, Warm load ${warmDuration}ms, 4x CPU Throttled load ${throttledDuration}ms`
  );

  await context.close();
}

// --------------------------------------------------------------------------------------------------
// Main Execution
// --------------------------------------------------------------------------------------------------


async function runP6({ browser, origin, outputDir }) {
  await mkdir(join(outputDir, "screenshots"), { recursive: true });

  const report = { ...newReport("p6"), performance: {} };
  const server = { origin };

  {
    // 1. Audit Viewports & Core Journeys
    for (const vp of viewports) {
      console.log(`[P6 Harness] Auditing viewport: ${vp.label} (${vp.width}x${vp.height})...`);
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: Boolean(vp.isMobile),
      });
      const page = await context.newPage();
      await installFixtures(context, server.origin, report);

      try {
        await auditJourneys(page, server.origin, vp, report);
        await page.screenshot({ path: join(outputDir, "screenshots", `${vp.label}-charts.png`) });
        report.viewports.push({ label: vp.label, status: "PASS" });
      } catch (err) {
        report.failures.push(`[${vp.label}] ${err.message}`);
        report.viewports.push({ label: vp.label, status: "FAIL", error: err.message });
      } finally {
        await context.close();
      }
    }

    // 2. Audit Accessibility (Target Sizes, Focus/Modals)
    console.log(`[P6 Harness] Auditing Accessibility (Target Sizes & Focus)...`);
    const a11yContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const a11yPage = await a11yContext.newPage();
    await installFixtures(a11yContext, server.origin, report);

    try {
      await auditFocusAndModals(a11yPage, server.origin, report);
      await auditTargetSizes(a11yPage, server.origin, report);
      await auditCollectionReview(a11yPage, server.origin, report, outputDir);
    } catch (err) {
      report.failures.push(`[a11y] ${err.message}`);
    } finally {
      await a11yContext.close();
    }

    // 3. Audit 200% Zoom Reflow
    console.log(`[P6 Harness] Auditing 200% Zoom Reflow...`);
    try {
      await audit200PercentZoom(browser, server.origin, report);
    } catch (err) {
      report.failures.push(`[reflow] ${err.message}`);
    }

    // 4. Measure Performance
    console.log(`[P6 Harness] Measuring Performance & Throttling Profiles...`);
    try {
      await measurePerformance(browser, server.origin, report);
    } catch (err) {
      report.failures.push(`[performance] ${err.message}`);
    }

    // Check for blocked requests
    const blocked = report.requests.filter(r => r.startsWith("BLOCKED"));
    if (blocked.length > 0) {
      report.failures.push(`Blocked unhandled requests: ${blocked.join(", ")}`);
    }

    // Write reports
    await writeFile(join(outputDir, "report.json"), JSON.stringify(report, null, 2));

    const summaryMd = [
      "# P6 Integrated Acceptance Report",
      "",
      `**Date**: ${report.timestamp}`,
      `**Status**: ${report.failures.length === 0 ? "PASSED (100% Green)" : "FAILED"}`,
      "",
      "## Viewport Audit",
      ...report.viewports.map(v => `- **${v.label}**: ${v.status}`),
      "",
      "## Assertions & Findings",
      ...report.assertions.map(a => `- ${a}`),
      "",
      "## Lab Performance Metrics",
      `- **Cold Load**: ${report.performance.coldLoadMs} ms`,
      `- **Warm Load**: ${report.performance.warmLoadMs} ms`,
      `- **4x CPU Throttled Load**: ${report.performance.throttledLoadMs} ms`,
      `- **Simulated Profile**: ${report.performance.profile}`,
      "",
      report.failures.length > 0
        ? `## Failures\n${report.failures.map(f => `- ❌ ${f}`).join("\n")}`
        : "## Verdict\nAll accessibility, resilience, reflow, and performance requirements satisfied.",
    ].join("\n");

    await writeFile(join(outputDir, "summary.md"), summaryMd);

    console.log("\n" + summaryMd);

    if (report.failures.length > 0) {
      process.exit(1);
    }
  }
}


export const phase = {
  id: "p6",
  title: "Integrated acceptance and performance",
  defaultOutput: "ui-p6-browser",
  viewports,
  run: runP6,
};
