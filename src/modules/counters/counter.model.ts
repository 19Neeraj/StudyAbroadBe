import { Schema, model, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

/** Per-organization sequences for human-friendly numbers (lead #1001, …). */
const counterSchema = new Schema({
  ...tenantField,
  key: { type: String, required: true },
  seq: { type: Number, required: true, default: 0 },
});
counterSchema.index({ organizationId: 1, key: 1 }, { unique: true });
counterSchema.plugin(tenantPlugin);

export const CounterModel = model('Counter', counterSchema);

/** Atomically returns the next number of a sequence (first value = start). */
export async function nextSequence(organizationId: Types.ObjectId, key: string, start = 1001): Promise<number> {
  const doc = await CounterModel.findOneAndUpdate(
    { organizationId, key },
    [{ $set: { seq: { $add: [{ $ifNull: ['$seq', start - 1] }, 1] } } }],
    { upsert: true, new: true, updatePipeline: true },
  ).lean();
  return doc!.seq;
}
