import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = (path: string) => readFileSync(resolve(__dirname, path), "utf8");

describe("sole primary UI contract", () => {
  it("mounts one lazy application and retains compatibility redirects only", () => {
    const app = src("../App.tsx");
    expect(app).toContain('const PrimaryApp = React.lazy(() => import("./preview/PreviewApp.js"))');
    expect(app).toContain('path="/*" element={<PrimarySurface />}');
    for (const route of ["/preview/*", "/classic/*", "/curator/*", "/logs/*", "/status"]) {
      expect(app).toContain(`path="${route}" element={<CompatibilityRedirect />}`);
    }
    expect(app).toContain("resolveCompatibilityRedirect(pathname)");
    expect(app).toContain("pathname, search, hash");
    expect(app).not.toContain("ClassicApp");
    expect(existsSync(resolve(__dirname, "../classic/ClassicApp.tsx"))).toBe(false);
    expect(existsSync(resolve(__dirname, "./pages/ProcessPage.tsx"))).toBe(false);
    expect(existsSync(resolve(__dirname, "../features/librarian/components/ProgressTracker.tsx"))).toBe(false);
  });

  it("publishes every canonical workflow destination", () => {
    const app = src("./PreviewApp.tsx");
    const routes = [
      "desk", "ask", "discover", "discover/charts", "discover/for-you", "discover/search",
      "scout/trends", "scout/search", "scout/recommendations", "scout/intake", "acquire/downloads", "acquire/intake",
      "library", "library/books", "library/books/:id", "library/collections", "library/collections/:id",
      "library/manage", "library/manage/metadata", "library/manage/files", "library/manage/audio",
      "library/manage/audio/jobs", "library/manage/health", "curate/review", "curate/books/:id",
      "curate/encode", "curate/encode/jobs", "curate/collections", "curate/collections/:id",
      "curate/tags", "curate/health", "curate/realign", "process/scan",
      "process/review", "process/organize", "process/encode", "process/encode/jobs",
      "activity", "activity/:id", "settings",
    ];
    routes.forEach((route) => expect(app).toContain(`path="${route}"`));
    expect(app).not.toContain("/preview/");
  });

  it("keeps the design system scoped and responsive", () => {
    const css = src("./preview.css");
    expect(css).toContain("#ui-v2-root");
    expect(css).toContain("@media(max-width:800px)");
    expect(css).toContain("prefers-reduced-motion:reduce");
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).not.toContain("v2-classic-access");
    expect(css).not.toMatch(/(^|\})\s*(body|html|:root)\s*\{/m);
  });

  it("defers non-Desk workflows and expensive Curate sections", () => {
    const app = src("./PreviewApp.tsx");
    const curate = src("./pages/CuratePage.tsx");
    for (const component of ["AskPage", "ScoutPage", "CuratePage", "UnifiedLogsPage", "PreviewSettingsDialog"]) {
      expect(app).toContain(`const ${component} = React.lazy`);
    }
    expect(app).not.toContain('import { UnifiedLogsPage }');
    expect(app).toContain("DeferredRoute");
    for (const component of ["Books", "Collections", "MetadataPipeline", "EncoderPage", "RealignPage"]) {
      expect(curate).toContain(`const ${component} = React.lazy`);
    }
  });

  it("wires live workflows rather than mock data", () => {
    const scout = src("./pages/ScoutPage.tsx");
    const intake = src("./components/IntakePanel.tsx");
    expect(scout).toContain("AudiobookSearch");
    expect(scout).toContain("BestsellerLists");
    expect(scout).toContain("Live filesystem");
    expect(intake).toContain("ScannerControl");
    expect(intake).toContain("ScanResultsReview");
  });

  it("keeps autosaving settings without a retired-UI escape", () => {
    const app = src("./PreviewApp.tsx");
    const dialog = src("./components/PreviewSettingsDialog.tsx");
    const client = src("./settingsClient.ts");
    const capabilities = src("./settingsCapabilities.ts");
    expect(app).toContain('aria-label="Open settings"');
    expect(app).toContain("SettingsDeepLink");
    expect(dialog).toContain("Edits are stored as you type");
    expect(dialog).toContain("Last 100 non-secret states");
    expect(dialog).toContain("Credentials are intentionally excluded");
    expect(dialog).toContain("flushBeforeLeaving");
    expect(dialog).not.toContain("classic UI");
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('aria-modal="true"');
    expect(client).toContain('method: "PATCH"');
    expect(client).toContain("SettingsAutosaveCoordinator");
    expect(dialog).toContain("ServerPathPicker");
    expect(dialog).toContain("refreshIntegrations");
    expect(capabilities).toContain("/api/system/fs?path=");
    expect(capabilities).toContain("/api/librarian/status");
  });

  it("uses canonical combined Scout and Curate routes", () => {
    const app = src("./PreviewApp.tsx");
    const curate = src("./pages/CuratePage.tsx");
    expect(app).toContain('"Discover"');
    expect(app).toContain('"Library"');
    expect(app).toContain('to="/ask"');
    expect(app).toContain('to="/discover/search"');
    expect(app).toContain('to="/library/manage/files"');
    expect(app).toContain('to="/library/manage/audio"');
    expect(app).toContain('PreserveRedirect');
    expect(curate).toContain('basePath="/library/books"');
    expect(curate).toContain('basePath="/library/collections"');
    expect(curate).toContain('jobHistoryPath="/library/manage/audio/jobs"');
    expect(app).toContain('backPath="/curate/encode"');
    expect(app).toContain('backPath="/library/manage/audio"');
    const books = src("../features/curator/pages/Books.tsx");
    const api = src("../features/curator/api.ts");
    expect(books).toContain("copyAllBookTitles");
    expect(books).toContain("Copy all titles");
    expect(api).toContain("bookTitles: () => http<string[]>('/books/titles')");
  });

  it("retires Process from primary navigation, keeping its routes as redirects only", () => {
    const app = src("./PreviewApp.tsx");
    const navBlock = app.slice(app.indexOf("const NAV = ["), app.indexOf("] as const;", app.indexOf("const NAV = [")));
    expect(navBlock).not.toMatch(/process/i);
    const bottomNavBlock = app.slice(app.indexOf('aria-label="Mobile navigation"'), app.indexOf('aria-label="Mobile navigation"') + 400);
    expect(bottomNavBlock).not.toMatch(/process/i);
    const processRoutes = [...app.matchAll(/<Route path="(process\/[^"]+)" element=\{([^}]+)\}\s*\/>/g)];
    expect(processRoutes.length).toBe(6);
    processRoutes.forEach(([, , element]) => expect(element).toContain("PreserveRedirect"));
  });

  it("keeps a self-contained failure recovery surface", () => {
    const app = src("../App.tsx");
    const boundary = src("./PreviewErrorBoundary.tsx");
    expect(app).toContain("<PreviewErrorBoundary>");
    expect(boundary).toContain("Reload application");
    expect(boundary).not.toContain("/classic");
  });
});
