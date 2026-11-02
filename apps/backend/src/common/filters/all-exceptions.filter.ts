import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

import type { Response } from 'express';

import type { RequestWithId } from '../middleware/request-id.middleware.js';

interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string | string[];
  timestamp: string;
  path: string;
  requestId: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();

    const request = context.getRequest<RequestWithId>();

    const response = context.getResponse<Response>();

    const isHttpException = exception instanceof HttpException;

    const statusCode = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] = 'Internal server error';

    if (isHttpException && statusCode < 500) {
      const detail = exception.getResponse();

      if (typeof detail === 'string') {
        message = detail;
      } else if (detail && typeof detail === 'object' && 'message' in detail) {
        const candidate = detail.message;

        if (typeof candidate === 'string') {
          message = candidate;
        } else if (
          Array.isArray(candidate) &&
          candidate.every((item) => typeof item === 'string')
        ) {
          message = candidate as string[];
        }
      }
    }

    const body: ErrorResponse = {
      statusCode,
      error: statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : `HTTP_${statusCode}`,
      message,
      timestamp: new Date().toISOString(),
      path: request.path,
      requestId: request.requestId ?? 'unavailable',
    };

    if (statusCode >= 500) {
      this.logger.error({
        event: 'unhandled_exception',
        requestId: body.requestId,
        method: request.method,
        path: request.path,
        statusCode,
        errorType: exception instanceof Error ? exception.name : typeof exception,
      });
    }

    response.status(statusCode).json(body);
  }
}
