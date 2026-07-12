import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = (path: string) => readFileSync(resolve(__dirname, path), "utf8");

describe("reversible UI v2 contract", () => {
  it("keeps every classic route behind the legacy branch", () => {
    const app = src("../App.tsx");
    for (const route of ['path="/"', 'path="/curator/*"', 'path="/logs/*"', 'path="/status"', 'path="/settings"']) {
      expect(app).toContain(route);
    }
    expect(app).toContain('path="/preview/*"');
    expect(app).toContain('path="*" element={<LegacyApp />}');
    expect(app).toContain('React.lazy');
    expect(app).toContain('Try UI Preview');
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
    for (const component of ["CuratePage", "EncoderPage", "UnifiedLogsPage", "SettingsPage"]) {
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

  it("keeps classic escape and live-system warnings visible", () => {
    const preview = src("./PreviewApp.tsx");
    const process = src("./pages/ProcessPage.tsx");
    expect(preview).toContain("Return to classic UI");
    expect(preview).toContain("Live system");
    expect(process).toContain("Live filesystem");
  });
});
