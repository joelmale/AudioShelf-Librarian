/**
 * Small helpers for handling caught values.
 *
 * `catch (e)` binds `unknown` — anything can be thrown, not just an `Error`.
 * These replace the `catch (e: any)` sites that reached straight for
 * `e.message` or `e.code` and would themselves throw on a thrown string.
 */

/** Narrows a caught value to a human-readable message. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reads the errno code off a caught value, or undefined if it has none. */
export function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}
