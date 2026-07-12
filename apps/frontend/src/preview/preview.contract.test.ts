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
  });

  it("publishes every canonical workflow destination", () => {
    const app = src("./PreviewApp.tsx");
    const routes = [
      "desk", "scout/trends", "scout/search", "acquire/downloads", "acquire/intake",
      "curate/review", "curate/books/:id", "curate/encode", "curate/encode/jobs",
      "curate/collections", "curate/collections/:id", "curate/tags", "process/scan",
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
    for (const component of ["ScoutPage", "ProcessPage", "CuratePage", "UnifiedLogsPage", "PreviewSettingsDialog"]) {
      expect(app).toContain(`const ${component} = React.lazy`);
    }
    expect(app).not.toContain('import { UnifiedLogsPage }');
    expect(app).toContain("DeferredRoute");
    for (const component of ["Books", "Collections", "Tagging", "EncoderPage"]) {
      expect(curate).toContain(`const ${component} = React.lazy`);
    }
  });

  it("wires live workflows rather than mock data", () => {
    const scout = src("./pages/ScoutPage.tsx");
    const process = src("./pages/ProcessPage.tsx");
    expect(scout).toContain("AudiobookSearch");
    expect(scout).toContain("BestsellerLists");
    expect(process).toContain("ScannerControl");
    expect(process).toContain("ScanResultsReview");
    expect(process).toContain("Live filesystem");
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
    expect(app).toContain('"Scout & Acquire"');
    expect(app).toContain('<Navigate to="/scout/search" replace/>');
    expect(curate).toContain('basePath="/curate/books"');
    expect(curate).toContain('jobHistoryPath="/curate/encode/jobs"');
    expect(app).toContain('backPath="/curate/encode"');
    const books = src("../features/curator/pages/Books.tsx");
    const api = src("../features/curator/api.ts");
    expect(books).toContain("copyAllBookTitles");
    expect(books).toContain("Copy all titles");
    expect(api).toContain("bookTitles: () => http<string[]>('/books/titles')");
  });

  it("keeps a self-contained failure recovery surface", () => {
    const app = src("../App.tsx");
    const boundary = src("./PreviewErrorBoundary.tsx");
    expect(app).toContain("<PreviewErrorBoundary>");
    expect(boundary).toContain("Reload application");
    expect(boundary).not.toContain("/classic");
  });
});
