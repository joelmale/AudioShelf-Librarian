import { SECRET_KEYS, SettingsStore } from "../config/settings.js";

/**
 * Scrubs secret material out of text that is about to leave the process.
 *
 * The settings layer keeps secrets out of `settings.json`, out of the settings
 * API, and out of rollback snapshots — but none of that helps once a value is
 * interpolated into a log line, because the console interceptor in `index.ts`
 * buffers every log into `/api/system/logs` and broadcasts it to every connected
 * WebSocket client. This module is the backstop for that path: even if some
 * future call site logs a credential, it does not reach a client.
 *
 * Redaction is best-effort by design. It cannot catch a secret that has been
 * transformed (base64-encoded, truncated, split across arguments), so it is a
 * second line of defence — not a licence to log credentials.
 */

export const REDACTED = "[redacted]";

/**
 * Values shorter than this are not redacted. A two-character password would
 * otherwise match inside unrelated words and shred every log line in the buffer.
 */
const MIN_REDACTABLE_LENGTH = 8;

/** `//user:password@host` in any URL — catches proxy and qBittorrent URLs. */
const URL_CREDENTIALS = /(\/\/)[^/\s:@]+:[^/\s:@]+@/g;

/** `Authorization: Bearer <token>` and bare `Bearer <token>` in error dumps. */
const BEARER_TOKEN = /(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let cachedSecrets: string[] | null = null;

/**
 * Stores we have already subscribed to. Tracked per store rather than with a
 * single boolean: production uses one singleton, but tests (and any future
 * multi-store code) construct several, and a global flag would leave every
 * store after the first with no invalidation — silently pinning the redactor
 * to a stale secret after a rotation.
 */
const subscribedStores = new WeakSet<SettingsStore>();

/** Current secret values, longest first. */
export function currentSecrets(store: SettingsStore = SettingsStore.getInstance()): string[] {
  if (!subscribedStores.has(store)) {
    // Settings changes rotate secrets; drop the cache rather than hold a stale
    // value that would leave the *new* credential unredacted.
    store.subscribe(() => {
      cachedSecrets = null;
    });
    subscribedStores.add(store);
    cachedSecrets = null;
  }

  if (cachedSecrets) return cachedSecrets;

  const settings = store.getSettings();
  cachedSecrets = SECRET_KEYS.map((key) => settings[key]).filter(
    (value): value is string => typeof value === "string" && value.trim().length >= MIN_REDACTABLE_LENGTH,
  );

  return cachedSecrets;
}

/** Forget cached secrets. Exported for tests and for explicit invalidation. */
export function resetSecretCache(): void {
  cachedSecrets = null;
}

/**
 * Replace every known secret, embedded URL credential, and bearer token in
 * `message` with {@link REDACTED}.
 */
export function redactSecrets(message: string, secrets: string[] = currentSecrets()): string {
  let redacted = message;

  // Longest first, so a secret that contains another as a prefix is replaced
  // whole instead of leaving its tail behind. Sorted here rather than at the
  // cache so that callers passing an explicit list get the same guarantee.
  const ordered = [...secrets].sort((left, right) => right.length - left.length);

  for (const secret of ordered) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }

  redacted = redacted.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  redacted = redacted.replace(BEARER_TOKEN, `$1${REDACTED}`);

  return redacted;
}
