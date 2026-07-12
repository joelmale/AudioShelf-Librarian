const STATIC_LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  "/": "/preview/desk",
  "/curator": "/preview/desk",
  "/curator/books": "/preview/curate/review",
  "/curator/tag": "/preview/curate/tags",
  "/curator/collections": "/preview/curate/collections",
  "/curator/encode": "/preview/curate/encode",
  "/curator/encode/jobs": "/preview/curate/encode/jobs",
  "/status": "/preview/settings",
  "/settings": "/preview/settings",
};

function normalizePathname(pathname: string) {
  if (!pathname || pathname === "/") return "/";
  return `/${pathname.replace(/^\/+|\/+$/g, "")}`;
}

/** Resolve bookmarks from the former public UI without touching preview/classic routes. */
export function resolveLegacyRedirect(pathname: string): string {
  const normalized = normalizePathname(pathname);
  const exact = STATIC_LEGACY_REDIRECTS[normalized];
  if (exact) return exact;

  const bookPrefix = "/curator/books/";
  if (normalized.startsWith(bookPrefix)) {
    return `/preview/curate/books/${normalized.slice(bookPrefix.length)}`;
  }

  const collectionPrefix = "/curator/collections/";
  if (normalized.startsWith(collectionPrefix)) {
    return `/preview/curate/collections/${normalized.slice(collectionPrefix.length)}`;
  }

  if (normalized === "/logs" || normalized.startsWith("/logs/")) {
    return "/preview/activity";
  }

  if (normalized.startsWith("/curator/")) {
    return "/preview/curate/review";
  }

  return "/preview/desk";
}
