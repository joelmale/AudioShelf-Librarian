/**
 * Reference resolution for MCP tools that accept "by id OR by name". An
 * ambiguous name (multiple matches) raises a ConflictError listing the
 * candidates rather than acting on the wrong one (adversarial guardrail).
 */
import type { CuratorDb } from '../core/db.js';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js';
import type { Book, Collection } from '../core/types.js';

export function resolveCollection(db: CuratorDb, ref: { id?: number; name?: string }): Collection {
  if (ref.id !== undefined && Number.isFinite(ref.id)) {
    const c = db.getCollection(ref.id);
    if (!c) throw new NotFoundError(`No collection with id ${ref.id}`);
    return c;
  }
  if (ref.name) {
    const matches = db.findCollectionsByName(ref.name);
    if (matches.length === 0) throw new NotFoundError(`No collection named "${ref.name}"`);
    if (matches.length > 1) {
      throw new ConflictError(
        `Multiple collections named "${ref.name}" — specify one by id`,
        { ids: matches.map((m) => ({ id: m.id, status: m.status })) }
      );
    }
    return matches[0] as Collection;
  }
  throw new ValidationError('Provide a collection id or name');
}

export function resolveBook(db: CuratorDb, ref: { id?: string; title?: string }): Book {
  if (ref.id) {
    const b = db.getBook(ref.id);
    if (!b) throw new NotFoundError(`No book with id ${ref.id}`);
    return b;
  }
  if (ref.title) {
    const matches = db.queryBooks({ search: ref.title, limit: 5 }).books.filter(
      (b) => b.title.toLowerCase() === ref.title!.toLowerCase()
    );
    const fuzzy = matches.length > 0 ? matches : db.queryBooks({ search: ref.title, limit: 5 }).books;
    if (fuzzy.length === 0) throw new NotFoundError(`No book matching "${ref.title}"`);
    if (fuzzy.length > 1) {
      throw new ConflictError(`Multiple books match "${ref.title}" — specify one by id`, {
        candidates: fuzzy.map((b) => ({ id: b.id, title: b.title })),
      });
    }
    return fuzzy[0] as Book;
  }
  throw new ValidationError('Provide a book id or title');
}
