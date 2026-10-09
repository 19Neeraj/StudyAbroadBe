import type { Types } from 'mongoose';
import { emitTo, rooms } from '../../sockets/index.js';

interface LeadRef {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  assignedCounsellor?: Types.ObjectId | null;
  assignedManager?: Types.ObjectId | null;
}

export type LeadEvent = 'lead.created' | 'lead.updated' | 'lead.assigned' | 'lead.stageChanged';

/**
 * Real-time hints (spec §38). The organization room only gets the lead id (no personal data);
 * clients refetch through the API, which enforces scope. Assignees get a little more context.
 */
export function emitLeadEvent(event: LeadEvent, lead: LeadRef, extra: Record<string, unknown> = {}): void {
  emitTo([rooms.organization(lead.organizationId.toString())], event, { leadId: lead._id.toString() });
  const assignees = [lead.assignedCounsellor, lead.assignedManager].filter((u): u is Types.ObjectId => !!u);
  if (assignees.length) {
    emitTo(
      assignees.map((u) => rooms.user(u.toString())),
      event,
      { leadId: lead._id.toString(), ...extra },
    );
  }
}
