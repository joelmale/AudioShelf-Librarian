/**
 * Safe readers for values whose shape is not guaranteed.
 *
 * Third-party payloads — AudiobookShelf socket events, its `passthrough`
 * library-item schemas, scraped provider responses — carry fields that are not
 * in any schema and vary by server version. The old idiom for reaching into
 * them was `(value as any)?.a?.b`, which silences the compiler for the whole
 * expression: a typo in `b`, or `a` turning into an array, both read as
 * `undefined` with no complaint anywhere.
 *
 * These helpers narrow instead. Each step is checked, and the caller gets back
 * either a value of the type it asked for or `undefined`.
 */

/** Walks a key path through an unknown value, stopping at the first non-object. */
export function readPath(source: unknown, ...keys: string[]): unknown {
  let current = source;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Reads a string at a key path, or undefined if it is absent or another type. */
export function readString(source: unknown, ...keys: string[]): string | undefined {
  const value = readPath(source, ...keys);
  return typeof value === "string" ? value : undefined;
}

/** Reads a number at a key path, or undefined if it is absent or another type. */
export function readNumber(source: unknown, ...keys: string[]): number | undefined {
  const value = readPath(source, ...keys);
  return typeof value === "number" ? value : undefined;
}

/** Reads an array at a key path, or undefined if it is absent or another type. */
export function readArray(source: unknown, ...keys: string[]): unknown[] | undefined {
  const value = readPath(source, ...keys);
  return Array.isArray(value) ? value : undefined;
}
