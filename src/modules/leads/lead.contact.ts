import type { Types } from 'mongoose';
import { LeadModel } from './lead.model.js';

/**
 * Records a real contact with the lead (call connected, WhatsApp/email sent, meeting).
 * `firstContactAt` is set once and drives first-response-time analytics (spec §43).
 */
export async function markContacted(organizationId: Types.ObjectId, leadId: Types.ObjectId, at: Date = new Date()): Promise<void> {
  await LeadModel.updateOne({ organizationId, _id: leadId, firstContactAt: null }, { firstContactAt: at });
  await LeadModel.updateOne(
    { organizationId, _id: leadId },
    [{ $set: { lastContactedAt: { $max: [{ $ifNull: ['$lastContactedAt', at] }, at] }, lastActivityAt: { $max: [{ $ifNull: ['$lastActivityAt', at] }, at] } } }],
    { updatePipeline: true },
  );
}
