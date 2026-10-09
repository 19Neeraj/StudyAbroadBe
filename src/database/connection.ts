import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

mongoose.set('strictQuery', true);

let closing = false;

export async function connectDatabase(uri: string = env.MONGO_URI): Promise<typeof mongoose> {
  mongoose.connection.on('disconnected', () => {
    if (!closing) logger.warn('MongoDB disconnected');
  });
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  const conn = await mongoose.connect(uri, {
    maxPoolSize: env.MONGO_MAX_POOL_SIZE,
    serverSelectionTimeoutMS: 10_000,
    // Unique indexes enforce business rules (e.g. one account per email), so they are always
    // ensured on startup; `npm run db:indexes` additionally drops indexes removed from schemas.
    autoIndex: true,
  });
  logger.info({ db: conn.connection.name }, 'MongoDB connected');
  return conn;
}

export async function disconnectDatabase(): Promise<void> {
  closing = true;
  await mongoose.disconnect();
}
