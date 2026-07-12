const STATIC_LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  "/": "/desk",
  "/curator": "/desk",
  "/curator/books": "/curate/review",
  "/curator/tag": "/curate/tags",
  "/curator/collections": "/curate/collections",
  "/curator/encode": "/curate/encode",
  "/curator/encode/jobs": "/curate/encode/jobs",
  "/logs": "/activity",
  "/status": "/settings",
  "/settings": "/settings",
};

function normalizePathname(pathname: string) {
  if (!pathname || pathname === "/") return "/";
  return `/${pathname.replace(/^\/+|\/+$/g, "")}`;
}

/** Resolve bookmarks from both retired UI namespaces to the sole public route tree. */
export function resolveCompatibilityRedirect(pathname: string): string {
  let normalized = normalizePathname(pathname);

  if (normalized === "/preview" || normalized === "/classic") return "/desk";
  if (normalized.startsWith("/preview/")) normalized = normalized.slice("/preview".length);
  if (normalized.startsWith("/classic/")) normalized = normalized.slice("/classic".length);

  const exact = STATIC_LEGACY_REDIRECTS[normalized];
  if (exact) return exact;

  if (normalized === "/acquire/downloads") return "/scout/search";
  if (normalized === "/acquire/intake") return "/process/scan";
  if (normalized === "/process/encode") return "/curate/encode";
  if (normalized === "/process/encode/jobs") return "/curate/encode/jobs";

  const bookPrefix = "/curator/books/";
  if (normalized.startsWith(bookPrefix)) {
    return `/curate/books/${normalized.slice(bookPrefix.length)}`;
  }

  const collectionPrefix = "/curator/collections/";
  if (normalized.startsWith(collectionPrefix)) {
    return `/curate/collections/${normalized.slice(collectionPrefix.length)}`;
  }

  if (normalized === "/logs" || normalized.startsWith("/logs/")) {
    return "/activity";
  }

  if (normalized.startsWith("/curator/")) {
    return "/curate/review";
  }

  if (/^\/(desk|scout|curate|process|activity|settings)(?:\/|$)/.test(normalized)) {
    return normalized;
  }

  return "/desk";
}
