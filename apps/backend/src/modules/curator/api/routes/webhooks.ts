import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http.js';
import { handleWebhookEvent } from '../../core/webhookHandler.js';
import type { ApiServices } from '../services.js';

const webhookSchema = z.object({
  event: z.string(),
}).passthrough();

export function createWebhooksRouter(services: ApiServices): Router {
  const RouterInstance = Router();

  RouterInstance.post(
    '/webhooks/abs',
    asyncHandler(async (req, res) => {
      const payload = webhookSchema.safeParse(req.body);
      
      if (!payload.success) {
        services.logger.warn('Invalid webhook payload received', {
          issues: payload.error.issues,
        });
        return res.status(400).json({ error: 'Invalid payload' });
      }

      const event = payload.data.event;

      // Offload to core handler. We don't await because ABS expects a fast 200 OK.
      handleWebhookEvent(event, payload.data, {
        absClient: services.absClient,
        db: services.db,
        logger: services.logger,
      }).catch((err) => {
        services.logger.error('Unhandled error in async webhook processing', { err });
      });

      res.status(200).json({ success: true });
    })
  );

  return RouterInstance;
}
