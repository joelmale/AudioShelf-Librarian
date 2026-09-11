/* global document, window, PopStateEvent */
/**
 * P1 — Ask route, Library foundations and the shared shell.
 *
 * Covers redirect/state preservation, real pointer focus and typing in the Ask
 * and Desk composers, the topbar acquisition-search field repaired in P1-R1,
 * navigation, and contrast compositing.
 *
 * STATUS: this is a faithful port of the accepted P1 harness, and it currently
 * FAILS against the post-P4 build. Its journeys assert a Desk that still hosts
 * its own composer and library-health summary; P4 retired Desk into an /ask
 * redirect. The assertions are left exactly as reviewed rather than quietly
 * relaxed — refreshing them against the current IA is a deliberate P1 re-baseline,
 * not a cleanup. p0, p2 and p6 pass. See docs/ui-simplification-status.md.
 */

import { P1_BOOK, P1_CHAT_EVENTS, P1_COLLECTION, P1_CONVERSATION, P1_FOLLOW_UP_EVENTS, P1_LIBRARY_HEALTH, P1_PIPELINE, P1_READINESS, P1_SETTINGS, SYNTHETIC_P1_LABEL, sse } from "../../fixtures/ui-simplification/p1.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assert,
  json,
  verifyRequestSafety,
  waitRoute,
} from "../core.mjs";

const viewports = [{ label: "390x844", width: 390, height: 844 }, { label: "768x1024", width: 768, height: 1024 }, { label: "1440x1000", width: 1440, height: 1000 }];

function conversationDetail(includeFollowUp = false) {
  const turns = [{ id: "fixture-turn-1", threadId: P1_CONVERSATION.id, question: P1_CONVERSATION.latestQuestion, turnIndex: 0, status: "answered", startedAt: P1_CONVERSATION.createdAt, updatedAt: P1_CONVERSATION.updatedAt, events: P1_CHAT_EVENTS.map(([type, event], index) => ({ seq: index + 1, recordedAt: P1_CONVERSATION.updatedAt, event: { ...event, type } })) }];
  if (includeFollowUp) {
    turns.push({ id: "fixture-turn-2", threadId: P1_CONVERSATION.id, question: "Show another shelf match", turnIndex: 1, status: "answered", startedAt: P1_CONVERSATION.updatedAt + 1, updatedAt: P1_CONVERSATION.updatedAt + 2, events: P1_FOLLOW_UP_EVENTS.map(([type, event], index) => ({ seq: index + 1, recordedAt: P1_CONVERSATION.updatedAt + 2, event: { ...event, type } })) });
  }
  return { id: P1_CONVERSATION.id, createdAt: P1_CONVERSATION.createdAt, updatedAt: P1_CONVERSATION.updatedAt, nextCursor: null, turns };
}
function fixture(pathname, search = "") {
  if (pathname === "/health") return { absConnected: false, version: "synthetic", dbWritable: false };
  if (pathname === "/api/librarian/bestsellers") return { success: true, results: { audible: [], audiobooksnow: [], apple: [], nytFiction: [], nytNonfiction: [] } };
  if (pathname === "/api/librarian/search") return { results: [], totalPages: 1, currentPage: Number(new URLSearchParams(search ?? "").get("page") ?? "1") };
  if (pathname === "/api/librarian/jobs") return { success: true, data: [] };
  if (pathname === "/api/system/settings") return { success: true, data: P1_SETTINGS };
  if (pathname === "/api/system/settings/history") return { success: true, data: [] };
  if (pathname === "/api/enrichment/refresh-campaign") return { campaign: null };
  if (pathname === "/api/librarian/conversations") return { conversations: [P1_CONVERSATION], nextCursor: null };
  if (pathname === `/api/librarian/conversations/${P1_CONVERSATION.id}`) return conversationDetail();
  if (pathname === "/api/books") return { books: [P1_BOOK], total: 1, limit: 20, offset: 0 };
  if (pathname === `/api/books/${P1_BOOK.id}`) return P1_BOOK;
  if (pathname === "/api/books/titles") return [P1_BOOK.title];
  if (pathname === "/api/collections") return [P1_COLLECTION];
  if (pathname === "/api/collections/1") return P1_COLLECTION;
  if (pathname === "/api/operations") return [];
  if (pathname === "/api/librarian/realign/scan") return { planId: "fixture-plan", createdAt: "2026-01-02T00:00:00.000Z", expiresAt: "2999-01-02T00:00:00.000Z", libraries: [{ libraryId: "fixture-library", name: "Synthetic library", status: "Great", score: 100, total: 1, observed: 1, configuredObserved: 1, eligible: 1, matched: 1, issues: 0, coverage: 100 }], candidates: [] };
  if (pathname === "/api/librarian/scan/history") return { success: true, data: [] };
  if (pathname === "/api/librarian/downloads/queue" || pathname === "/api/encode/queue" || pathname === "/api/encode/history" || pathname === "/api/log" || pathname === "/api/logs/actions") return [];
  if (pathname === "/api/librarian/downloads/pipeline") return P1_PIPELINE;
  if (pathname === "/api/librarian/recently-added") return { results: [P1_BOOK], total: 1 };
  if (pathname === "/api/librarian/health/library") return P1_LIBRARY_HEALTH;
  if (pathname === "/api/tags/stats") return { totalBooks: 1, taggedBooks: 1, untaggedBooks: 0, vocabularySize: 1, avgTagTokens: null };
  if (pathname === "/api/readiness") return P1_READINESS;
  if (pathname === "/api/encode/libraries") return []; if (pathname === "/api/encode/config") return { enabled: false };
  if (pathname === "/api/collections/templates" || pathname === "/api/tags/vocabulary" || pathname === "/api/vocab/proposed") return [];
  return undefined;
}
async function installFixtures(context, origin, report) {
  const { requests } = report;
  await context.route("**/*", async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) { requests.push(`BLOCKED external ${request.method()} ${url.href}`); await route.abort(); return; }
    if (url.pathname === "/api/librarian/chat") {
      if (request.method() !== "POST") { requests.push(`BLOCKED chat ${request.method()} ${url.pathname}`); await route.abort(); return; }
      const payload = JSON.parse(request.postData() ?? "null");
      if (!payload || typeof payload.message !== "string") { requests.push(`BLOCKED malformed chat POST ${url.pathname}`); await route.abort(); return; }
      report.chatCalls.push(payload); const turn = report.chatCalls.length;
      requests.push(`FIXTURE POST ${url.pathname} turn=${turn}`);
      await route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "x-ui-fixture": "synthetic", "X-Conversation-Id": P1_CONVERSATION.id, "X-Conversation-Turn-Id": `fixture-turn-${turn + 1}` }, body: sse(turn === 1 ? P1_FOLLOW_UP_EVENTS : P1_CHAT_EVENTS) }); return;
    }
    if (url.pathname === `/api/librarian/conversations/${P1_CONVERSATION.id}` && request.method() === "GET") {
      requests.push(`FIXTURE GET ${url.pathname}`);
      await route.fulfill(json(conversationDetail(report.chatCalls.length > 0)));
      return;
    }
    const body = fixture(url.pathname, url.search);
    if (body !== undefined && request.method() === "GET") { requests.push(`FIXTURE GET ${url.pathname}`); await route.fulfill(json(body)); return; }
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") { requests.push(`BLOCKED API ${request.method()} ${url.pathname}`); await route.abort(); return; }
    if (request.method() !== "GET") { requests.push(`BLOCKED local ${request.method()} ${url.pathname}`); await route.abort(); return; }
    await route.continue();
  });
  await context.routeWebSocket("**/*", route => { const url = new URL(route.url()); if (url.hostname === new URL(origin).hostname && url.port === new URL(origin).port && url.pathname === "/api") requests.push(`EXPECTED websocket ${url.pathname}`); else requests.push(`BLOCKED websocket ${url.href}`); route.close(); });
}

async function pushRedirectWithState(page, origin, from, to, report) {
  const marker = `state-${from.replaceAll("/", "-") || "root"}`;
  await page.goto(`${origin}/desk`, { waitUntil: "networkidle" });
  await page.evaluate(({ from, marker }) => {
    window.history.pushState({ usr: { marker }, key: `fixture-${marker}`, idx: 1 }, "", `${from}?fixture=1#kept`);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, { from, marker });
  await waitRoute(page, to);
  const current = new URL(page.url());
  assert(current.search === "?fixture=1" && current.hash === "#kept", `${from} redirect did not preserve query/hash.`);
  const stateMarker = await page.evaluate(() => window.history.state?.usr?.marker);
  assert(stateMarker === marker, `${from} redirect did not preserve router state.`);
  report.assertions.push(`${from} redirects to ${to} with search/hash/state preserved.`);
}
async function redirectCompatibilityJourney(page, origin, report) {
  const redirects = [
    ["/discover", "/discover/charts"],
    ["/library", "/library/books"],
    ["/acquire/downloads", "/discover/search"],
    ["/acquire/intake", "/scout/intake"],
    ["/process/scan", "/scout/intake"],
    ["/process/review", "/scout/intake"],
    ["/process/organize", "/scout/intake"],
    ["/process/realign", "/library/manage/files"],
    ["/process/encode", "/library/manage/audio"],
    ["/process/encode/jobs", "/library/manage/audio/jobs"],
  ];
  for (const [from, to] of redirects) await pushRedirectWithState(page, origin, from, to, report);
}
async function control(page, name) { const candidate = page.getByRole("button", { name }); await candidate.first().waitFor(); return candidate.first(); }
async function chooseTextBox(page) { const box = page.locator(".v2-librarian-composer textarea").last(); await box.waitFor(); return box; }
async function clickAndTypeAskTextarea(page, origin, pathname, report) {
  await page.goto(`${origin}${pathname}`, { waitUntil: "networkidle" });
  const box = await chooseTextBox(page);
  await box.scrollIntoViewIfNeeded();
  const bounds = await box.boundingBox();
  assert(bounds, `${pathname} Ask textarea has no clickable box.`);
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + Math.min(24, bounds.height / 2));
  const focused = await box.evaluate(element => element === element.ownerDocument.activeElement);
  assert(focused, `${pathname} Ask textarea did not receive focus from a real pointer click.`);
  await page.keyboard.type("Fixture shelf question");
  assert(await box.inputValue() === "Fixture shelf question", `${pathname} Ask textarea did not accept typed input.`);
  assert(new URL(page.url()).pathname === pathname, `${pathname} Ask textarea click navigated to ${new URL(page.url()).pathname}.`);
  report.assertions.push(`${pathname} Ask textarea accepts real pointer focus and typing without acquisition-search navigation.`);
}
async function askJourney(page, origin, viewport, report) {
  await page.goto(`${origin}/ask`, { waitUntil: "networkidle" });
  if (viewport.width <= 800) {
    await page.locator(".v2-mobile-title strong").getByText("Ask", { exact: true }).waitFor();
  }
  await page.getByRole("link", { name: /something new/i }).click(); await waitRoute(page, "/discover/for-you");
  await page.goto(`${origin}/ask`, { waitUntil: "networkidle" });
  const history = page.getByRole("combobox", { name: /reopen a past conversation/i }); await history.waitFor();
  const beforeReopen = report.chatCalls.length;
  await history.selectOption(P1_CONVERSATION.id); await page.getByText(P1_BOOK.title, { exact: true }).first().waitFor();
  const afterReopen = report.chatCalls.length;
  assert(afterReopen === beforeReopen, "Reopening saved Ask history issued a chat POST.");
  assert(report.requests.some(line => line === `FIXTURE GET /api/librarian/conversations/${P1_CONVERSATION.id}`), "Reopening saved Ask history did not fetch its persisted detail.");
  const followUp = await chooseTextBox(page); await followUp.fill("Show another shelf match"); await page.getByRole("button", { name: /follow up|ask librarian/i }).click(); await page.getByText(P1_BOOK.title, { exact: true }).last().waitFor();
  assert(report.chatCalls.length === afterReopen + 1, "An explicit Ask follow-up must issue exactly one additional chat POST.");
  const followUpCall = report.chatCalls.at(-1); assert(followUpCall.message === "Show another shelf match" && followUpCall.conversationId === P1_CONVERSATION.id, "Ask follow-up did not preserve the typed message and reopened conversation ID.");
  await page.getByText("Synthetic follow-up evidence.").waitFor();
  assert(report.requests.some(line => line === "FIXTURE GET /api/librarian/conversations/fixture-conversation-1"), "Follow-up did not refresh its persisted transcript.");
  assert(await page.getByText("Synthetic follow-up evidence.").count() > 0, "Ask follow-up response did not render distinct follow-up evidence.");
  report.assertions.push("Ask reopen fetched persisted detail without a POST; typed follow-up preserved its conversation ID and received a distinct fixture turn.");
}
async function navigationJourney(page, origin, report) {
  await page.goto(`${origin}/discover/for-you`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Find what to add next/i }).waitFor();
  await page.goto(`${origin}/desk`, { waitUntil: "networkidle" }); await page.getByText(/library health/i).first().waitFor();
  const destinations = [
    ["/discover/charts", /Find what belongs next/i, "Discover"],
    ["/discover/search", /Search acquisition sources/i, "Discover"],
    ["/library/books", /Browse and manage your library/i, "Library"],
    ["/library/collections", /Browse and manage your library/i, "Library"],
    ["/library/manage", /Manage library/i, "Library"],
    ["/library/manage/metadata", /metadata pipeline|proposed vocabulary/i, "Library"],
    ["/library/manage/files", /Proposed moves|structure measurements/i, "Library"],
    ["/library/manage/audio", /M4B conversion|conversion/i, "Library"],
    ["/library/manage/audio/jobs", /Encode History|encode history|No encode history/i, "Library"],
    ["/library/manage/health", /library health/i, "Library"],
    ["/activity", /logs|activity|console|history/i, "Activity"],
    ["/curate/review", /Browse and manage your library/i, "Library"],
    ["/curate/collections", /Browse and manage your library/i, "Library"],
    ["/curate/tags", /metadata pipeline|proposed vocabulary/i, "Library"],
    ["/curate/encode", /M4B conversion|conversion/i, "Library"],
    ["/curate/encode/jobs", /Encode History|encode history|No encode history/i, "Library"],
    ["/curate/health", /library health/i, "Library"],
    ["/curate/realign", /Proposed moves|structure measurements/i, "Library"],
  ];
  for (const [path, pattern, selectedLabel] of destinations) {
    await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
    assert(new URL(page.url()).pathname === path, `${path} unexpectedly fell through to another route.`);
    await page.locator("main").getByText(pattern).first().waitFor().catch((error) => {
      throw new Error(`${path} did not render expected destination content: ${error instanceof Error ? error.message : String(error)}`);
    });
    const selected = page.getByRole("navigation", { name: /primary navigation/i }).locator('[aria-current="page"]');
    assert(await selected.count() === 1, `${path} did not expose one selected primary navigation item.`);
    assert((await selected.first().innerText()).includes(selectedLabel), `${path} selected ${await selected.first().innerText()} instead of ${selectedLabel}.`);
  }
  const encodedBookId = encodeURIComponent(P1_BOOK.id);
  for (const path of [`/library/books/${encodedBookId}?source=fixture#detail`, `/curate/books/${encodedBookId}?source=fixture#detail`]) {
    await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
    const current = new URL(page.url()); assert(current.search === "?source=fixture" && current.hash === "#detail", `${path} lost its query or hash.`);
    await page.getByRole("heading", { name: P1_BOOK.title }).waitFor(); await page.getByText(P1_BOOK.author, { exact: true }).waitFor();
  }
  await page.goto(`${origin}/library/collections/1?source=fixture#detail`, { waitUntil: "networkidle" }); await page.getByRole("heading", { name: P1_COLLECTION.name }).waitFor();
  report.assertions.push("Discover, Desk, canonical and legacy Library detail links retain encoded IDs, query/hash, and selected fixture content.");
}
async function shellJourney(page, origin, viewport, report) {
  await page.goto(`${origin}/library/books?view=fixture#synthetic`, { waitUntil: "networkidle" });
  if (viewport.width > 800) {
    const command = page.getByRole("search", { name: "Search acquisition sources" });
    const commandInput = command.getByRole("textbox", { name: "Search acquisition sources" });
    await commandInput.click();
    await commandInput.fill("cozy dragon mystery");
    assert(new URL(page.url()).pathname === "/library/books", "Topbar search field navigated before submit.");
    await commandInput.press("Enter");
    await waitRoute(page, "/discover/search");
    assert(new URL(page.url()).search === "?q=cozy%20dragon%20mystery", "Topbar search submit did not preserve the typed query.");
    await page.getByRole("heading", { name: /Search acquisition sources/i }).waitFor();
    report.assertions.push("Topbar search is a real text input and only navigates on submit.");
    await page.goto(`${origin}/library/books?view=fixture#synthetic`, { waitUntil: "networkidle" });
  }
  const settings = await control(page, /^Open settings$/); await settings.click(); await page.getByRole("dialog").waitFor();
  await (await control(page, /^Close settings$/)).click(); { const current = new URL(page.url()); assert(current.pathname === "/library/books" && current.search === "?view=fixture" && current.hash === "#synthetic", "Closing settings lost the current route, query, or hash."); }
  await page.goto(`${origin}/settings?chart=fixture#synthetic`, { waitUntil: "networkidle" }); await page.getByRole("dialog").waitFor(); await (await control(page, /^Close settings$/)).click(); await waitRoute(page, "/discover/charts"); { const current = new URL(page.url()); assert(current.search === "?chart=fixture" && current.hash === "#synthetic", "Settings fallback lost its query or hash."); }
   
  const task = await control(page, /^New task$/); await task.focus(); await task.click(); const dialog = page.getByRole("dialog", { name: /start a task|new task/i }); await dialog.waitFor(); assert(await dialog.evaluate(element => element.contains(document.activeElement)), "New task dialog did not transfer focus inside."); assert(await dialog.locator(".v2-task-grid button").count() === 4, "New task must expose all four operations."); await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" }); assert(await task.evaluate(element => element === document.activeElement), "New task did not return focus to its trigger.");
  const nav = page.getByRole("navigation", { name: /primary navigation/i }); const selected = nav.locator('[aria-current="page"]'); assert(await selected.count() === 1, "Primary navigation must expose exactly one selected item.");
  for (const name of ["Desk", "Discover", "Library", "Activity", "Ask"]) await page.getByRole("link", { name, exact: true }).first().waitFor();
  await page.getByRole("button", { name: "New task", exact: true }).first().waitFor(); await page.getByRole("button", { name: "Open settings", exact: true }).first().waitFor();
  if (viewport.width <= 800) {
    const hiddenTabbables = await page.locator('aside nav[aria-label="Primary navigation"]').evaluate(nav => [...nav.querySelectorAll('a, button, input, select, textarea, [tabindex]')].filter(element => element.tabIndex >= 0 && !element.hasAttribute('disabled')).map(element => element.textContent?.trim() || element.getAttribute('aria-label'))); assert(hiddenTabbables.length === 0, `Closed mobile navigation exposes tabbables: ${hiddenTabbables.join(", ")}`);
     
    const menu = await control(page, /^Open menu$/); assert(await menu.getAttribute("aria-expanded") === "false", "Closed mobile menu must expose aria-expanded=false."); assert(await menu.getAttribute("aria-controls") === "primary-navigation", "Mobile menu must identify the controlled navigation."); await menu.click(); const closeMenu = await control(page, /^Close menu$/); assert(await closeMenu.getAttribute("aria-expanded") === "true", "Open mobile menu must expose aria-expanded=true."); await page.getByRole("navigation", { name: /primary navigation/i }).getByRole("link").first().focus(); await page.keyboard.press("Escape"); await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open menu"); assert(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Open menu"), "Escape must close the mobile menu and return focus to its trigger."); assert(await (await control(page, /^Open menu$/)).getAttribute("aria-expanded") === "false", "Escape must restore the closed mobile menu state.");
  }
  report.assertions.push(`Shell state, settings route preservation, New task, selected navigation${viewport.width <= 800 ? ", and mobile focus" : ""} verified.`);
}
/* eslint-disable no-undef -- The following callback is serialized into the Playwright page. */
async function contrast(page, report) {
  const required = [{ role: "link", name: "Desk" }, { role: "link", name: "Discover" }, { role: "link", name: "Library" }, { role: "link", name: "Activity" }, { role: "link", name: "Ask" }, { role: "button", name: "New task" }, { role: "button", name: "Open settings" }];
  const result = [];
  for (const control of required) {
    const locator = page.getByRole(control.role, { name: control.name, exact: true }).first(); await locator.waitFor();
    result.push(await locator.evaluate(element => {
    const parse = value => { const match = value.match(/rgba?\(([^)]+)\)/); if (!match) return null; const values = match[1].trim().replace(/\s*\/\s*/, ' ').split(/[\s,]+/).filter(Boolean).map(part => part.endsWith('%') ? Number(part.slice(0, -1)) * 2.55 : Number(part)); return values.length >= 3 && values.slice(0, 3).every(Number.isFinite) ? values : null; };
    const parseColors = value => [...value.matchAll(/rgba?\([^)]+\)/g)].map(match => parse(match[0])).filter(Boolean);
    const composite = (foreground, background) => { const alpha = foreground[3] ?? 1; return foreground.slice(0, 3).map((value, index) => value * alpha + background[index] * (1 - alpha)); };
    const styleColors = style => [...parseColors(style.backgroundImage), parse(style.backgroundColor)].filter(Boolean);
    const backdrop = node => { const ancestors = []; for (let current = node.parentElement; current; current = current.parentElement) ancestors.unshift(current); return ancestors.reduce((color, current) => { const colors = styleColors(getComputedStyle(current)); return colors.reduce((next, value) => composite(value, next), color); }, [255, 255, 255]); };
    const luminance = rgb => rgb.slice(0, 3).map(value => { const c = value / 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, .7152, .0722][index], 0);
    const style = getComputedStyle(element); const foreground = parse(style.color); const colors = style.backgroundImage === 'none' ? [parse(style.backgroundColor)] : parseColors(style.backgroundImage);
    if (!foreground || colors.length === 0 || colors.some(color => !color)) return { name: element.getAttribute('aria-label') || element.textContent?.trim(), skipped: true, reason: 'unparseable CSS color' };
    const underlay = backdrop(element); const ratios = colors.map(color => { const background = composite(color, underlay); const text = composite(foreground, background); const a = luminance(text), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }); const fontSize = Number.parseFloat(style.fontSize); const large = fontSize >= 24 || (fontSize >= 18.66 && Number.parseInt(style.fontWeight, 10) >= 700); return { name: element.getAttribute('aria-label') || element.textContent?.trim(), ratio: Math.min(...ratios), threshold: large ? 3 : 4.5, sampledBackgroundStops: ratios.length };
    }));
  }
  assert(result.every(item => !item.skipped), `Could not calculate contrast for required controls: ${result.filter(item => item.skipped).map(item => item.name).join(", ")}.`); for (const item of result) assert(item.ratio >= item.threshold, `Insufficient control contrast for ${item.name}: ${item.ratio.toFixed(2)}:1 (needs ${item.threshold}:1).`); report.contrast = result;
}
/* eslint-enable no-undef */
async function capture(browser, origin, outputDir, viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: "block" }); const report = { label: SYNTHETIC_P1_LABEL, viewport, servedFrom: origin, requests: [], chatCalls: [], assertions: [], contrast: [] };
  try { await installFixtures(context, origin, report); const page = await context.newPage(); page.on("pageerror", error => report.requests.push(`PAGEERROR ${error.message}`)); page.on("requestfailed", request => report.requests.push(`REQUESTFAILED ${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? "unknown"}`)); await clickAndTypeAskTextarea(page, origin, "/ask", report); await clickAndTypeAskTextarea(page, origin, "/desk", report); await askJourney(page, origin, viewport, report); await navigationJourney(page, origin, report); await redirectCompatibilityJourney(page, origin, report); await shellJourney(page, origin, viewport, report); await contrast(page, report); await page.goto(`${origin}/ask`, { waitUntil: "networkidle" }); await page.screenshot({ path: join(outputDir, `p1-ask-${viewport.label}.png`) }); await page.goto(`${origin}/library/books`, { waitUntil: "networkidle" }); await page.screenshot({ path: join(outputDir, `p1-library-${viewport.label}.png`) }); verifyRequestSafety(report); await writeFile(join(outputDir, `p1-${viewport.label}.report.json`), `${JSON.stringify(report, null, 2)}\n`); console.log(`P1 ${viewport.label}: verified (${report.requests.filter(line => line.startsWith("FIXTURE")).length} fixtures, no blocked requests).`); }
  catch (error) { report.requests.push(`HARNESSERROR ${error instanceof Error ? error.message : String(error)}`); await writeFile(join(outputDir, `p1-${viewport.label}.failed.json`), `${JSON.stringify(report, null, 2)}\n`); throw error; }
  finally { await context.close(); }
}


export const phase = {
  id: "p1",
  title: "Ask, Library foundations and shared shell",
  defaultOutput: "ui-p1-browser",
  viewports,
  async run({ browser, origin, outputDir }) {
    for (const viewport of viewports) {
      await capture(browser, origin, outputDir, viewport);
    }
    console.log(`Captured synthetic P1 evidence in ${outputDir}`);
  },
};
