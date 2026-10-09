import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env, isProduction } from './config/env.js';
import { logger } from './config/logger.js';
import { generateOpenApiDocument } from './docs/openapi.js';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware.js';
import { ipLimiter, userLimiter } from './middlewares/rateLimit.middleware.js';
import { requestId } from './middlewares/requestId.middleware.js';
import { sanitizeRequest } from './middlewares/sanitize.middleware.js';
import { apiRouter } from './routes/index.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple');

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId ?? '',
      autoLogging: { ignore: (req) => req.url === '/health' },
      quietReqLogger: true,
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  app.use(compression());
  // rawBody is kept for webhook signature verification (HMAC over the exact bytes).
  const keepRaw = (req: express.Request, _res: unknown, buf: Buffer) => {
    if (req.originalUrl.startsWith('/api/v1/webhooks/')) req.rawBody = buf;
  };
  app.use(express.json({ limit: '1mb', verify: keepRaw }));
  app.use(express.urlencoded({ extended: false, limit: '1mb', verify: keepRaw }));
  app.use(cookieParser());
  app.use(sanitizeRequest);

  app.get('/health', (_req, res) => {
    res.json({ success: true, message: 'OK', data: { uptime: process.uptime() } });
  });
  app.get('/ready', (_req, res) => {
    const ready = mongoose.connection.readyState === 1;
    res
      .status(ready ? 200 : 503)
      .json({ success: ready, message: ready ? 'Ready' : 'Database unavailable', data: null });
  });

  const openApiDoc = generateOpenApiDocument();
  app.get('/api/docs.json', (_req, res) => {
    res.json(openApiDoc);
  });
  if (!isProduction) {
    // Swagger UI ships inline scripts, so relax CSP for the docs route only.
    app.use(
      '/api/docs',
      helmet({ contentSecurityPolicy: false }),
      swaggerUi.serve,
      swaggerUi.setup(openApiDoc),
    );
  }

  app.use('/api/v1', ipLimiter, userLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
