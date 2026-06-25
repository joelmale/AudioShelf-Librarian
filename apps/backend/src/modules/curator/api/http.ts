/**
 * Shared Express helpers: async handler wrapping and the central structured
 * error responder. Every route surfaces `{ error, code, detail? }` (MADP D3).
 */
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';

import { toAppError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

/**
 * Wrap an async handler so rejected promises reach the error middleware.
 * (Express 5 forwards rejections automatically, but this keeps intent explicit
 * and is robust regardless of version — D1: no unhandled rejections.)
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Central error handler mapping any thrown value to its structured payload. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const appErr = toAppError(err);
    logger.error('Request failed', {
      method: req.method,
      path: req.path,
      code: appErr.code,
      message: appErr.message,
    });
    if (res.headersSent) return;
    res.status(appErr.httpStatus).json(appErr.toPayload());
  };
}

/** 404 for unmatched API routes (structured, not Express' default HTML). */
export const notFoundHandler: RequestHandler = (req, res) => {
  res
    .status(404)
    .json({ error: `No such endpoint: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
};
