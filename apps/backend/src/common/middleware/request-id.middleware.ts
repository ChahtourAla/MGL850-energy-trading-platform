import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { Logger } from '@nestjs/common';

import type { NextFunction, Request, Response } from 'express';

export type RequestWithId = Request & {
  requestId?: string;
};

const logger = new Logger('HTTP');

/**
 * Attach a server-generated request identifier.
 *
 * Every request receives a new UUID.
 * Client-provided request IDs are not trusted.
 *
 * Request bodies, passwords, authorization headers,
 * query strings and private keys are never logged.
 */
export function requestIdMiddleware(
  request: RequestWithId,
  response: Response,
  next: NextFunction,
): void {
  const requestId = randomUUID();
  const start = performance.now();

  request.requestId = requestId;

  response.setHeader('X-Request-ID', requestId);

  response.on('finish', () => {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;

    logger.log({
      event: 'http_request',
      requestId,
      method: request.method,
      path: request.path,
      statusCode: response.statusCode,
      durationMs,
    });
  });

  next();
}
