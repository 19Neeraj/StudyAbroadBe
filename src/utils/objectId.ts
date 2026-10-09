import { Types } from 'mongoose';
import { z } from '../docs/zod.js';

export const objectIdString = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Invalid id')
  .openapi({ example: '665f1c2e9b1d8a0012a3b4c5' });

export const idParams = z.object({ id: objectIdString });

export function toObjectId(id: string): Types.ObjectId {
  return new Types.ObjectId(id);
}
