/**
 * Audiobookshelf REST API client.
 *
 * Design constraints (MADP-FULL, adversarial cases B1–B5, D1–D3):
 *  - Every request carries `Authorization: Bearer <token>` and a bounded timeout
 *    (AbortSignal) so a dead ABS host fails fast with a typed connection error
 *    instead of hanging (B2).
 *  - 401/403 → ABSAuthError, surfaced clearly and NEVER retried blindly (B1).
 *  - All JSON is Zod-validated; validation failure is a typed ValidationError.
 *  - getLibraryItems fetches every page; the loop terminates on a short/empty
 *    page and is guarded against a mis-reported `total` (B3, B5).
 *  - No promise is left unhandled; every await is inside try/catch mapping to a
 *    typed AppError (D1–D3).
 */
import { z } from 'zod';

import {
  ABSAuthError,
  ABSConnectionError,
  ABSRequestError,
  AppError,
  ValidationError,
} from './errors.js';
import { nullLogger, type Logger } from './logger.js';
import {
  absCollectionSchema,
  absCollectionsResponseSchema,
  absLibrariesResponseSchema,
  absLibraryItemSchema,
  absLibraryItemsResponseSchema,
  type ABSCollection,
  type ABSLibrary,
  type ABSLibraryItem,
} from './types.js';

const PAGE_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ABSClientOptions {
  timeoutMs?: number;
  logger?: Logger;
  /** Injectable fetch for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface CreateCollectionInput {
  libraryId: string;
  name: string;
  description?: string | null;
  bookIds: string[];
}

export class ABSClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, token: string, options: ABSClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? nullLogger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async getLibraries(): Promise<ABSLibrary[]> {
    const data = await this.request('GET', '/api/libraries', absLibrariesResponseSchema);
    return data.libraries;
  }

  /** Fetch ALL pages of items for a library (adversarial B3). */
  async getLibraryItems(libraryId: string): Promise<ABSLibraryItem[]> {
    const items: ABSLibraryItem[] = [];
    let page = 0;
    let total = Number.POSITIVE_INFINITY;
    // Hard ceiling guards against a mis-reported `total` causing an infinite loop.
    const maxPages = 100_000;

    while (items.length < total && page < maxPages) {
      const path = `/api/libraries/${encodeURIComponent(libraryId)}/items?limit=${PAGE_LIMIT}&page=${page}`;
      const data = await this.request('GET', path, absLibraryItemsResponseSchema);
      total = data.total;
      items.push(...data.results);

      if (data.results.length === 0) break; // nothing more (also covers empty library, B5)
      page += 1;
    }

    this.logger.debug('Fetched library items', { libraryId, count: items.length, total });
    return items;
  }

  async getBook(bookId: string): Promise<ABSLibraryItem> {
    return this.request(
      'GET',
      `/api/items/${encodeURIComponent(bookId)}`,
      absLibraryItemSchema
    );
  }

  /** Triggers the native ABS encoder for a specific library item. */
  async encodeBookToM4b(bookId: string): Promise<void> {
    // Note: Some versions of ABS use /api/library-items/ while others use /api/items/
    try {
      await this.requestVoid('POST', `/api/library-items/${encodeURIComponent(bookId)}/encode-m4b`);
    } catch (err: any) {
      if (err.httpStatus === 404 || err.status === 404) {
        try {
          await this.requestVoid('POST', `/api/items/${encodeURIComponent(bookId)}/encode-m4b`);
        } catch (err2: any) {
          if (err2.httpStatus === 404 || err2.status === 404) {
            // Newest Audiobookshelf uses /api/tools/item/
            await this.requestVoid('POST', `/api/tools/item/${encodeURIComponent(bookId)}/encode-m4b`);
          } else {
            throw err2;
          }
        }
      } else {
        throw err;
      }
    }
  }

  /** Update a book's tags in Audiobookshelf */
  async updateBookTags(bookId: string, tags: string[]): Promise<void> {
    await this.requestVoid('PATCH', `/api/items/${encodeURIComponent(bookId)}/media`, { tags });
  }

  /** Returns the new ABS collection id. */
  async createCollection(input: CreateCollectionInput): Promise<string> {
    const created = await this.request('POST', '/api/collections', absCollectionSchema, {
      libraryId: input.libraryId,
      name: input.name,
      description: input.description ?? '',
      books: input.bookIds,
    });
    return created.id;
  }

  /**
   * Replace the membership (and optionally name/description) of an existing ABS
   * collection. Uses PATCH /api/collections/{id} per the project's ABS API
   * reference.
   */
  async updateCollection(
    collectionId: string,
    bookIds: string[],
    meta?: { name?: string; description?: string | null }
  ): Promise<void> {
    const body: Record<string, unknown> = { books: bookIds };
    if (meta?.name !== undefined) body.name = meta.name;
    if (meta?.description !== undefined) body.description = meta.description ?? '';
    await this.requestVoid('PATCH', `/api/collections/${encodeURIComponent(collectionId)}`, body);
  }

  async deleteCollection(collectionId: string): Promise<void> {
    await this.requestVoid('DELETE', `/api/collections/${encodeURIComponent(collectionId)}`);
  }

  /**
   * Ask ABS to rescan a library so newly-encoded `.m4b` files are picked up.
   * Used by the encoder's optional `rescanAfter`. Fire-and-forget on the ABS
   * side (it scans asynchronously); we only surface a failed trigger.
   */
  async triggerLibraryScan(libraryId: string): Promise<void> {
    await this.requestVoid('POST', `/api/libraries/${encodeURIComponent(libraryId)}/scan`);
  }

  /** Existing collections in a library — used for name-conflict detection (B4). */
  async getCollections(libraryId: string): Promise<ABSCollection[]> {
    const data = await this.request(
      'GET',
      `/api/libraries/${encodeURIComponent(libraryId)}/collections`,
      absCollectionsResponseSchema
    );
    return data.collections;
  }

  /** Lightweight reachability + auth probe used by /health and settings test. */
  async testConnection(): Promise<{ ok: boolean; libraryCount: number }> {
    const libraries = await this.getLibraries();
    return { ok: true, libraryCount: libraries.length };
  }

  // ── Internal request plumbing ────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown
  ): Promise<T> {
    const raw = await this.execute(method, path, body);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error('ABS response failed validation', {
        path,
        issues: parsed.error.issues,
      });
      throw new ValidationError(`ABS response for ${path} did not match expected shape`, {
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  private async requestVoid(method: string, path: string, body?: unknown): Promise<void> {
    await this.execute(method, path, body);
  }

  private async execute(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Network down, DNS failure, or timeout — all map to a typed connection error (B2).
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      const message = isTimeout
        ? `ABS request to ${path} timed out after ${this.timeoutMs}ms`
        : `Could not reach ABS at ${this.baseUrl} (${path})`;
      throw new ABSConnectionError(message, err);
    }

    if (!res.ok) {
      const detail = await this.readErrorBody(res);
      if (res.status === 401 || res.status === 403) {
        throw new ABSAuthError(
          `ABS rejected the API token (HTTP ${res.status}). The token may be invalid or expired.`,
          detail
        );
      }
      throw new ABSRequestError(res.status, `ABS request to ${path} failed (HTTP ${res.status})`, detail);
    }

    // Successful but possibly empty body (DELETE / 204).
    const text = await res.text();
    if (text.trim() === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new ABSRequestError(res.status, `ABS returned non-JSON for ${path}`, {
        bodyPreview: text.slice(0, 500),
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async readErrorBody(res: Response): Promise<unknown> {
    try {
      const text = await res.text();
      if (text.trim() === '') return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text.slice(0, 500);
      }
    } catch (err) {
      // Never let body-reading failure mask the original HTTP error.
      return err instanceof AppError ? err.toPayload() : undefined;
    }
  }
}
