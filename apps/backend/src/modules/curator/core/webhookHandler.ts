import { mapItemToBook } from './sync.js';
import type { ABSClient } from './absClient.js';
import type { CuratorDb } from './db.js';
import { nullLogger, type Logger } from './logger.js';
import { toAppError } from './errors.js';

export interface WebhookHandlerDeps {
  absClient: ABSClient;
  db: CuratorDb;
  logger?: Logger;
  now?: () => number;
}

/**
 * Handle incoming ABS Webhooks.
 * E.g., automatically keep the local db in sync when items are added or updated in ABS.
 */
export async function handleWebhookEvent(
  event: string,
  payload: any,
  deps: WebhookHandlerDeps
): Promise<void> {
  const logger = deps.logger ?? nullLogger;
  const now = deps.now ?? Date.now;

  logger.info('Received ABS webhook', { event });

  try {
    switch (event) {
      case 'item_added':
      case 'item_updated': {
        const itemId = payload.item?.id || payload.id;
        if (!itemId) {
          logger.warn('ABS webhook missing item id', { event, payload });
          return;
        }

        logger.info(`Fetching latest item data from ABS for ${itemId}...`);
        const item = await deps.absClient.getBook(itemId);
        
        const book = mapItemToBook(item, now());
        const outcome = deps.db.upsertBook(book);
        
        logger.info(`Successfully synced item from webhook`, { bookId: book.id, outcome });
        break;
      }
      
      case 'item_deleted':
      case 'item_removed': {
        const itemId = payload.item?.id || payload.id;
        if (itemId) {
          logger.info(`Item removed webhook not implemented yet, would remove ${itemId}`);
        }
        break;
      }
      
      default:
        logger.debug(`Unhandled ABS webhook event: ${event}`);
    }
  } catch (err) {
    const appErr = toAppError(err);
    logger.error('Failed to process ABS webhook', {
      event,
      code: appErr.code,
      message: appErr.message
    });
    throw appErr;
  }
}
