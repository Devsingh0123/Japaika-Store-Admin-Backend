import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { sequelize } from './models/index.js';
import authRoutes from './routes/auth.routes.js';
import categoryRoutes from './routes/category.routes.js';
import productRoutes from './routes/product.routes.js';
import bannerRoutes from './routes/banner.routes.js';
import { notFoundHandler, errorHandler } from './middlewares/error.middleware.js';
import { sendSuccess, sendError } from './utils/http.js';

const app = express();

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(helmet());
app.use(
  cors({
    origin: process.env.ADMIN_FRONTEND_URL || 'http://localhost:3001',
    credentials: true,
  })
);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

app.get('/api/v1/health', async (_req, res) => {
  try {
    await sequelize.authenticate();
    return sendSuccess(res, {
      message: 'Admin backend is healthy',
      data: { service: 'admin-backend', status: 'ok', database: 'connected' },
    });
  } catch {
    return sendError(res, {
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Database connectivity check failed.',
    });
  }
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/categories', categoryRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/banners', bannerRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
