import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import env from './config/env.js';
import defaultApiRouter from './routes/index.js';
import { notFoundHandler, errorHandler } from './middlewares/error.middleware.js';

export function createApp({ apiRouter = defaultApiRouter, registerExtraRoutes = null } = {}) {
  const app = express();

  if (env.trustProxy > 0) {
    app.set('trust proxy', env.trustProxy);
  }

  app.use(helmet());
  app.use(
    cors({
      origin: env.adminFrontendUrl,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());

  app.use('/api/v1', apiRouter);

  if (typeof registerExtraRoutes === 'function') {
    registerExtraRoutes(app);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const app = createApp();
export default app;
