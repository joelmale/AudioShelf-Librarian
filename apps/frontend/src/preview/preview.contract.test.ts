import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = (path: string) => readFileSync(resolve(__dirname, path), "utf8");

describe("reversible UI v2 contract", () => {
  it("makes UI v2 the default while retaining a lazy classic rollback branch", () => {
    const app = src("../App.tsx");
    const classic = src("../classic/ClassicApp.tsx");
    expect(app).toContain('path="/preview/*"');
    expect(app).toContain('path="/classic/*"');
    expect(app).toContain('path="*" element={<LegacyRedirect />}');
    expect(app).toContain("resolveLegacyRedirect(pathname)");
    expect(app).toContain('React.lazy(() => import("./preview/PreviewApp.js"))');
    expect(app).toContain('React.lazy(() => import("./classic/ClassicApp.js"))');
    expect(app).toContain("<PreviewErrorBoundary>");
    expect(app.indexOf("<PreviewErrorBoundary>")).toBeLessThan(app.indexOf("<PreviewApp />"));
    for (const destination of ["/classic", "/classic/curator", "/classic/logs", "/classic/status", "/classic/settings"]) {
      expect(classic).toContain(destination);
    }
    expect(classic).toContain('basePath="/classic/curator"');
    expect(classic).toContain("Return to UI v2");
  });

  it("publishes every required preview destination", () => {
    const preview = src("./PreviewApp.tsx");
    const routes = [
      "desk", "scout/trends", "scout/search", "acquire/downloads", "acquire/intake",
      "curate/review", "curate/books/:id", "curate/encode", "curate/encode/jobs",
      "curate/collections", "curate/collections/:id", "curate/tags", "process/scan",
      "process/review", "process/organize", "process/encode", "process/encode/jobs",
      "activity", "activity/:id", "settings",
    ];
    routes.forEach((route) => expect(preview).toContain(`path="${route}"`));
  });

  it("keeps preview presentation scoped and supplies responsive/reduced-motion rules", () => {
    const css = src("./preview.css");
    expect(css).toContain("#ui-v2-root");
    expect(css).toContain("@media(max-width:800px)");
    expect(css).toContain("prefers-reduced-motion:reduce");
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).not.toMatch(/(^|\})\s*(body|html|:root)\s*\{/m);
  });

  it("wires the preview to live workflow components rather than mock data", () => {
    const preview = src("./PreviewApp.tsx");
    const scout = src("./pages/ScoutPage.tsx");
    const process = src("./pages/ProcessPage.tsx");
    for (const component of ["CuratePage", "EncoderPage", "UnifiedLogsPage", "PreviewSettingsDialog"]) {
      expect(preview).toContain(component);
    }
    const curate = src("./pages/CuratePage.tsx");
    for (const component of ["Books", "Collections", "Tagging", "EncoderPage"]) {
      expect(curate).toContain(component);
    }
    expect(scout).toContain("AudiobookSearch");
    expect(scout).toContain("BestsellerLists");
    expect(process).toContain("ScannerControl");
    expect(process).toContain("ScanResultsReview");
  });

  it("uses a preview-native autosaving settings dialog without replacing classic settings", () => {
    const preview = src("./PreviewApp.tsx");
    const dialog = src("./components/PreviewSettingsDialog.tsx");
    const client = src("./settingsClient.ts");
    expect(preview).toContain('aria-label="Open settings"');
    expect(preview).toContain("SettingsDeepLink");
    expect(preview).not.toContain("SettingsPage");
    expect(dialog).toContain("Edits are stored as you type");
    expect(dialog).toContain("Last 100 non-secret states");
    expect(dialog).toContain("Credentials are intentionally excluded");
    expect(dialog).toContain('href="/classic"');
    expect(dialog).toContain("Open classic UI");
    expect(dialog).toContain("flushBeforeLeaving");
    expect(dialog).toContain("a[href]");
    expect(dialog.indexOf('className="v2-classic-access"')).toBeGreaterThan(dialog.indexOf("</fieldset>"));
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('aria-modal="true"');
    expect(client).toContain('method: "PATCH"');
    expect(client).toContain("SettingsAutosaveCoordinator");
  });

  it("combines Scout and Acquire while preserving old preview links", () => {
    const preview = src("./PreviewApp.tsx");
    expect(preview).toContain('"Scout & Acquire"');
    expect(preview).toContain('<Navigate to="/preview/scout/search" replace/>');
    expect(preview).not.toContain('["acquire/downloads", "Acquire"');
  });

  it("keeps Curate and its M4B workflow inside the preview shell", () => {
    const preview = src("./PreviewApp.tsx");
    const curate = src("./pages/CuratePage.tsx");
    expect(curate).toContain('"Needs M4B"');
    expect(curate).toContain('basePath="/preview/curate/books"');
    expect(curate).toContain('jobHistoryPath="/preview/curate/encode/jobs"');
    expect(preview).toContain('backPath="/preview/curate/encode"');
  });

  it("keeps classic rollback and live-system warnings visible", () => {
    const preview = src("./PreviewApp.tsx");
    const app = src("../App.tsx");
    const errorBoundary = src("./PreviewErrorBoundary.tsx");
    const dialog = src("./components/PreviewSettingsDialog.tsx");
    const process = src("./pages/ProcessPage.tsx");
    expect(preview).toContain("Live system");
    expect(process).toContain("Live filesystem");
    expect(errorBoundary).toContain('to="/classic"');
    expect(app).toContain("<PreviewErrorBoundary>");
    expect(dialog).toContain("The previous UI remains available during the rollback period.");
  });
});
