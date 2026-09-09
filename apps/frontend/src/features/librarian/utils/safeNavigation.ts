const ALLOWED_PREFIXES = [
  "/discover",
  "/library",
  "/ask",
  "/desk",
  "/activity",
  "/settings",
  "/scout",
  "/curate",
];

/**
 * Validates and sanitizes a returnTo path to prevent open redirect vulnerabilities.
 * Ensures navigation only routes to allowed internal application destinations.
 */
export function sanitizeReturnTo(
  candidate: string | null | undefined,
  fallback = "/discover/charts",
): string {
  if (!candidate || typeof candidate !== "string") {
    return fallback;
  }

  const trimmed = candidate.trim();
  if (!trimmed) {
    return fallback;
  }

  // Reject protocol-relative URLs (//) or backslash evasion (/\\)
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) {
    return fallback;
  }

  // Must be an absolute path starting with a single forward slash
  if (!trimmed.startsWith("/")) {
    return fallback;
  }

  // Check for embedded protocols or colon before path delimiter (e.g., javascript:, data:)
  const firstSlashIndex = trimmed.indexOf("/");
  const firstColonIndex = trimmed.indexOf(":");
  if (firstColonIndex !== -1 && firstColonIndex < firstSlashIndex) {
    return fallback;
  }

  try {
    // Parse using dummy base to inspect pathname safely
    const parsed = new URL(trimmed, "http://internal-app.local");
    
    // Verify hostname did not change
    if (parsed.hostname !== "internal-app.local") {
      return fallback;
    }

    const { pathname } = parsed;

    // Must match one of the allowed prefixes
    const isAllowed = ALLOWED_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );

    if (!isAllowed) {
      return fallback;
    }

    // Return the sanitized relative path with query and hash preserved
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
