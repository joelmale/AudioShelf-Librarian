/* global document */
/**
 * P2 — Discover browsing continuity and source-search continuation.
 *
 * Verifies the mobile fold, the removal of the always-open source panel from
 * Charts, candidate handoff and anchor/tab restoration on Back, sanitizeReturnTo
 * rejecting hostile return targets, idle-vs-empty search states, description
 * overlay focus restoration, and book-list filter retention.
 */

import {
  SUCCESSFUL_BESTSELLERS_RESPONSE,
  SYNTHETIC_BESTSELLER_LABEL,
} from "../../fixtures/ui-simplification/bestsellers.mjs";
import { P1_SETTINGS } from "../../fixtures/ui-simplification/p1.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assert,
  json,
  verifyRequestSafety,
  waitRoute,
} from "../core.mjs";

const viewports = [
  { label: "390x844", width: 390, height: 844 },
  { label: "768x1024", width: 768, height: 1024 },
  { label: "1440x1000", width: 1440, height: 1000 },
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

function fixture(pathname, search = "") {
  if (pathname === "/health") return { absConnected: false, version: "synthetic", dbWritable: false };
  if (pathname === "/api/librarian/bestsellers") return SUCCESSFUL_BESTSELLERS_RESPONSE;
  if (pathname === "/api/system/settings") return { success: true, data: P1_SETTINGS };
  if (pathname === "/api/system/settings/history") return { success: true, data: [] };
  if (pathname === "/api/operations") return [];
  if (pathname === "/api/librarian/jobs") return { success: true, data: [] };
  if (pathname === "/api/librarian/downloads/queue" || pathname === "/api/encode/queue" || pathname === "/api/encode/history" || pathname === "/api/log" || pathname === "/api/logs/actions") return [];
  if (pathname === "/api/librarian/downloads/pipeline") return { activeDownloads: [], completedDownloads: [], failedDownloads: [] };
  if (pathname === "/api/tags/stats") return { totalBooks: 50, taggedBooks: 50, untaggedBooks: 0, vocabularySize: 5, avgTagTokens: null };
  if (pathname === "/api/readiness") return { status: "ready" };
  if (pathname === "/api/collections") return [];
  if (pathname === "/api/collections/templates" || pathname === "/api/tags/vocabulary" || pathname === "/api/vocab/proposed") return [];
  if (pathname === "/api/enrichment/refresh-campaign") return { campaign: null };
  if (pathname === "/api/librarian/recently-added") return { results: FIXTURE_BOOKS.slice(0, 5), total: 5 };

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

  // P3 added this endpoint after P0/P2 shipped; the shell requests it on every
  // Discover render, so both phases must answer it to stay fail-closed.
  if (pathname === "/api/candidates/intents") {
    return {};
  }

  return undefined;
}

async function installFixtures(context, origin, report) {
  const { requests } = report;
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      // Allow data: URLs
      if (url.protocol === "data:") {
        await route.continue();
        return;
      }
      requests.push(`BLOCKED external ${request.method()} ${url.href}`);
      await route.abort();
      return;
    }
    const body = fixture(url.pathname, url.search);
    if (body !== undefined && request.method() === "GET") {
      requests.push(`FIXTURE GET ${url.pathname}`);
      await route.fulfill(json(body));
      return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      requests.push(`BLOCKED API ${request.method()} ${url.pathname}`);
      await route.abort();
      return;
    }
    if (request.method() !== "GET") {
      requests.push(`BLOCKED local ${request.method()} ${url.pathname}`);
      await route.abort();
      return;
    }
    await route.continue();
  });

  await context.routeWebSocket("**/*", route => {
    const url = new URL(route.url());
    if (url.hostname === new URL(origin).hostname && url.port === new URL(origin).port && url.pathname === "/api") {
      requests.push(`EXPECTED websocket ${url.pathname}`);
    } else {
      requests.push(`BLOCKED websocket ${url.href}`);
    }
    route.close();
  });
}


async function verifyMobileFold(page, origin, viewport, report) {
  if (viewport.width !== 390) return;
  await page.goto(`${origin}/discover/charts`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Top Bestsellers/i }).waitFor();
  const firstCard = page.locator(".bestseller-card").first();
  await firstCard.waitFor();
  const bounds = await firstCard.boundingBox();
  assert(bounds, "Candidate #1 has no bounding box.");
  assert(
    bounds.y >= 0 && bounds.y < viewport.height,
    `Candidate #1 top (${bounds.y}px) is below the fold (${viewport.height}px) on ${viewport.label}.`,
  );
  report.assertions.push(`Candidate #1 is visible in initial viewport without scrolling at ${viewport.label} (top at ${bounds.y}px).`);
}

/**
 * Requirement 2: No page-top search panel on Charts.
 */
async function verifyNoTopSearchOnCharts(page, origin, report) {
  await page.goto(`${origin}/discover/charts`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Top Bestsellers/i }).waitFor();
  const searchSection = page.locator("#audiobook-search-section");
  assert((await searchSection.count()) === 0, "Charts page contains unexpected inline search panel.");
  report.assertions.push("Charts page (/discover/charts) does not render the inline search panel.");
}

/**
 * Requirement 3: Candidate navigation, search handoff, and Back restoration.
 */
async function verifyCandidateHandoffAndBack(page, origin, report) {
  await page.goto(`${origin}/discover/charts`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Top Bestsellers/i }).waitFor();

  // Find candidate 2 (or any candidate with index >= 2)
  const candidate2 = page.locator("#bestseller-item-2");
  await candidate2.waitFor();
  await candidate2.scrollIntoViewIfNeeded();

  const searchBtn = candidate2.locator(".bestseller-card__search");
  await searchBtn.waitFor();
  await searchBtn.click();

  await waitRoute(page, "/discover/search");
  const searchUrl = new URL(page.url());
  assert(searchUrl.pathname === "/discover/search", "Search link did not navigate to /discover/search.");
  assert(searchUrl.searchParams.has("q"), "Search URL missing query parameter ?q=.");
  assert(searchUrl.searchParams.has("returnTo"), "Search URL missing returnTo parameter.");

  // Click Back to chart
  const backLink = page.getByRole("link", { name: /Back to/i });
  await backLink.waitFor();
  await backLink.click();

  await waitRoute(page, "/discover/charts");
  const returnUrl = new URL(page.url());
  assert(returnUrl.pathname === "/discover/charts", "Back link did not return to /discover/charts.");
  assert(returnUrl.hash === "#bestseller-item-2", `Return URL hash was ${returnUrl.hash}, expected #bestseller-item-2.`);

  report.assertions.push("Candidate search handoff navigates to /discover/search and Back returns to chart with anchor restored.");
}

/**
 * Requirement 4: Malformed returnTo cannot navigate off-site.
 */
async function verifySafeReturnTo(page, origin, report) {
  // Test external URL - must NOT render back link
  await page.goto(`${origin}/discover/search?q=test&returnTo=https://evil.com/hack`, { waitUntil: "networkidle" });
  assert((await page.getByRole("link", { name: /Back to/i }).count()) === 0, "Untrusted external returnTo rendered a back link.");

  // Test protocol relative URL - must NOT render back link
  await page.goto(`${origin}/discover/search?q=test&returnTo=//evil.com/hack`, { waitUntil: "networkidle" });
  assert((await page.getByRole("link", { name: /Back to/i }).count()) === 0, "Protocol-relative returnTo rendered a back link.");

  report.assertions.push("Malformed external returnTo values are sanitized and cannot navigate off-site.");
}

/**
 * Requirement 5: Unsubmitted query does not claim no results.
 */
async function verifySearchUnsubmittedState(page, origin, report) {
  await page.goto(`${origin}/discover/search`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Search acquisition sources/i }).waitFor();

  // Search input is present with placeholder
  const input = page.locator('#audiobook-search-section input[type="text"]');
  await input.waitFor();
  assert(
    (await page.getByText(/No results found/i).count()) === 0,
    "Search page unexpectedly claimed no results found on idle state.",
  );

  // Type without submitting
  await input.fill("unfinished draft query");
  assert(
    (await page.getByText(/No results found/i).count()) === 0,
    "Typing in search input without submit prematurely showed empty results.",
  );

  report.assertions.push("Unsubmitted search query remains idle without claiming no results.");
}

/**
 * Requirement 6: Description preview modal / sheet and focus restoration.
 */
async function verifyDescriptionFocusRestoration(page, origin, report) {
  await page.goto(`${origin}/discover/charts`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Top Bestsellers/i }).waitFor();

  const infoBtn = page.locator(".bestseller-card__info").first();
  await infoBtn.waitFor();
  await infoBtn.scrollIntoViewIfNeeded();
  await infoBtn.click();

  const dialog = page.locator(".bestseller-description--pinned");
  await dialog.waitFor();
  assert(await dialog.isVisible(), "Description overlay did not open.");

  const closeBtn = page.getByRole("button", { name: /Close description/i });
  await closeBtn.waitFor();
  await closeBtn.click();

  await dialog.waitFor({ state: "detached" });
  // Verify focus returned to trigger button
  const focusedIsTrigger = await infoBtn.evaluate(el => document.activeElement === el);
  assert(focusedIsTrigger, "Closing description overlay did not restore focus to trigger button.");

  report.assertions.push("Description preview overlay opens, closes, and restores focus to the trigger button.");
}

/**
 * Requirement 7: Desktop book list retains filters/page on detail Back.
 */
async function verifyBookListFilterRetention(page, origin, report) {
  await page.goto(`${origin}/library/books?search=Fixture&page=1`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Books", exact: true }).waitFor();

  // Check search input has "Fixture"
  const searchInput = page.getByPlaceholder("title or author");
  await searchInput.waitFor();
  const val = await searchInput.inputValue();
  assert(val === "Fixture", `Books search input did not initialize from ?search, got: "${val}"`);

  // Click first book to view detail
  const bookLink = page.locator(".book-card").first();
  await bookLink.waitFor();
  await bookLink.click();

  await page.waitForURL(url => new URL(url).pathname.startsWith("/library/books/book-"), { timeout: 8_000 });
  const detailUrl = new URL(page.url());
  assert(detailUrl.pathname.startsWith("/library/books/"), "Did not navigate to book detail.");

  // Click back to books link
  const backToBooks = page.getByRole("link", { name: /← Books/i });
  await backToBooks.waitFor();
  await backToBooks.click();

  await waitRoute(page, "/library/books");
  const restoredUrl = new URL(page.url());
  assert(restoredUrl.searchParams.get("search") === "Fixture", "Search query was not preserved on Back.");
  assert(restoredUrl.searchParams.get("page") === "1", "Page number was not preserved on Back.");

  report.assertions.push("Desktop book list retains filters and pagination across book detail navigation and Back.");
}

async function capture(browser, origin, outputDir, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    serviceWorkers: "block",
  });
  const report = {
    label: SYNTHETIC_BESTSELLER_LABEL,
    viewport,
    servedFrom: origin,
    requests: [],
    assertions: [],
  };

  try {
    await installFixtures(context, origin, report);
    const page = await context.newPage();
    page.on("pageerror", error => report.requests.push(`PAGEERROR ${error.message}`));
    page.on("requestfailed", request =>
      report.requests.push(`REQUESTFAILED ${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? "unknown"}`),
    );

    // 1. Mobile fold
    await verifyMobileFold(page, origin, viewport, report);

    // 2. No top search on charts
    await verifyNoTopSearchOnCharts(page, origin, report);

    // 3. Candidate handoff & back
    await verifyCandidateHandoffAndBack(page, origin, report);

    // 4. Safe returnTo
    await verifySafeReturnTo(page, origin, report);

    // 5. Search unsubmitted state
    await verifySearchUnsubmittedState(page, origin, report);

    // 6. Description focus restoration
    await verifyDescriptionFocusRestoration(page, origin, report);

    // 7. Desktop book list filter retention
    await verifyBookListFilterRetention(page, origin, report);

    // Screenshots
    await page.goto(`${origin}/discover/charts`, { waitUntil: "networkidle" });
    await page.screenshot({ path: join(outputDir, `p2-charts-${viewport.label}.png`) });

    await page.goto(`${origin}/discover/search?q=test`, { waitUntil: "networkidle" });
    await page.screenshot({ path: join(outputDir, `p2-search-${viewport.label}.png`) });

    await page.goto(`${origin}/library/books?search=Fixture&page=1`, { waitUntil: "networkidle" });
    await page.screenshot({ path: join(outputDir, `p2-books-${viewport.label}.png`) });

    verifyRequestSafety(report);
    await writeFile(
      join(outputDir, `p2-${viewport.label}.report.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(
      `P2 ${viewport.label}: verified (${report.requests.filter(l => l.startsWith("FIXTURE")).length} fixtures, 0 blocked requests, ${report.assertions.length} assertions passed).`,
    );
  } catch (error) {
    report.requests.push(`HARNESSERROR ${error instanceof Error ? error.message : String(error)}`);
    await writeFile(
      join(outputDir, `p2-${viewport.label}.failed.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    throw error;
  } finally {
    await context.close();
  }
}

if (process.argv.includes("--help")) {
  process.exit(0);
}



export const phase = {
  id: "p2",
  title: "Discover continuity and source search",
  defaultOutput: "ui-p2-browser",
  viewports,
  async run({ browser, origin, outputDir }) {
    for (const viewport of viewports) {
      await capture(browser, origin, outputDir, viewport);
    }
    console.log(`Captured synthetic P2 evidence in ${outputDir}`);
  },
};
