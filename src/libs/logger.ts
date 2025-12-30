import { pino } from 'pino';
import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';

// 1. Sentry Integration Hook
const sentryStream = {
  write: (msg: string) => {
    try {
      const log = JSON.parse(msg);

      if (log.level >= 40) {
        Sentry.withScope((scope) => {
          const contextTags: string[] = ['orderId', 'userId', 'txHash', 'chain', 'symbol', 'workerName', 'jobId'];

          contextTags.forEach(tag => {
            if (log[tag]) scope.setTag(tag, String(log[tag]));
          });

          if (log.reqId) scope.setTag('req_id', log.reqId);

          const level = log.level >= 60 ? 'fatal' : log.level >= 50 ? 'error' : 'warning';
          scope.setLevel(level);

          scope.setExtra('log_details', log);

          if (log.error || log.err) {
            const errorObj = log.error || log.err;
            const errorToReport = errorObj instanceof Error ? errorObj : new Error(errorObj.message || log.msg);

            if (errorObj.stack && !(errorObj instanceof Error)) {
              errorToReport.stack = errorObj.stack;
            }

            Sentry.captureException(errorToReport);
          } else {
            Sentry.captureMessage(log.msg, level);
          }
        });
      }

      process.stdout.write(msg);
    } catch (e) {
      process.stdout.write(msg);
    }
  }
};

// 2. Pino Logger Configuration
export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',

  // Custom Serializers
  serializers: {
    err: (err) => {
      if (err instanceof Error) {
        // SPREAD FIRST to avoid overriding specific properties if any
        const { message, stack, name, ...rest } = err as any;
        return {
          ...rest,
          message,
          stack,
          name
        };
      }
      return err;
    },
    error: (err) => {
      if (err instanceof Error) {
        const { message, stack, name, ...rest } = err as any;
        return {
          ...rest,
          message,
          stack,
          name
        };
      }
      return err;
    },
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      headers: req.headers,
      remoteAddress: req.connection?.remoteAddress,
      remotePort: req.connection?.remotePort,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
      headers: res.getHeaders ? res.getHeaders() : res.headers,
    }),
  },

  mixin() {
    // Return environment. Note: pino automatically adds pid/hostname unless disabled.
    return { env: env.NODE_ENV };
  },
}, sentryStream);

export default logger;
