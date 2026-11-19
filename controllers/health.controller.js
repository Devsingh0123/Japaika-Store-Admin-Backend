import defaultSequelize from '../config/database.js';
import { sendSuccess, sendError } from '../utils/response.js';

export function createHealthController({ sequelize = defaultSequelize } = {}) {
  async function getHealth(_req, res) {
    try {
      await sequelize.authenticate();
      return sendSuccess(res, {
        statusCode: 200,
        message: 'Admin backend is healthy',
        data: {
          service: 'admin-backend',
          status: 'ok',
          database: 'connected',
        },
      });
    } catch {
      return sendError(res, {
        statusCode: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: 'Database connectivity check failed.',
        details: [],
      });
    }
  }

  return { getHealth };
}

const healthController = createHealthController();
export default healthController;
