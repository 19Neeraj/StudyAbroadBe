import type { Types } from 'mongoose';
import type { ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { normalizeEmail, normalizePhone } from '../../utils/normalize.js';
import { getOrgSettings } from '../organizations/orgSettings.js';
import { LeadModel } from './lead.model.js';

export interface ContactInput {
  phone?: string | null | undefined;
  whatsappNumber?: string | null | undefined;
  email?: string | null | undefined;
}

export interface NormalizedContact {
  phone?: string | null;
  whatsappNumber?: string | null;
  email?: string | null;
}

/** Normalizes phone numbers (country code, spaces, dashes) and email casing (spec §13). */
export async function normalizeContact(ctx: Pick<ServiceContext, 'organizationId'>, input: ContactInput): Promise<NormalizedContact> {
  const { defaultCountryCode } = await getOrgSettings(ctx.organizationId);
  const out: NormalizedContact = {};
  const errors: { field: string; message: string }[] = [];
  for (const field of ['phone', 'whatsappNumber'] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (value === null || value === '') {
      out[field] = null;
      continue;
    }
    const normalized = normalizePhone(value, defaultCountryCode);
    if (!normalized) errors.push({ field: `body.${field}`, message: 'Invalid phone number' });
    else out[field] = normalized;
  }
  if (input.email !== undefined) out.email = input.email ? normalizeEmail(input.email) : null;
  if (errors.length) throw ApiError.validation(errors);
  return out;
}

export interface DuplicateMatch {
  _id: Types.ObjectId;
  leadNumber: number;
  fullName: string;
  matchedOn: ('phone' | 'whatsappNumber' | 'email')[];
  leadStage: string;
  leadStatus: string;
  originalSource: string;
  latestSource: string;
  campaign: string | null;
  assignedCounsellor: string | null;
  createdAt: Date;
}

/**
 * Finds existing (non-deleted, non-merged) leads sharing a phone/WhatsApp number or email.
 * Deliberately not limited to the caller's data scope: a counsellor must learn that the student
 * already exists elsewhere. Only the summary fields the spec lists are returned.
 */
export async function findDuplicates(
  ctx: Pick<ServiceContext, 'organizationId'>,
  contact: NormalizedContact,
  excludeId?: Types.ObjectId | string,
): Promise<DuplicateMatch[]> {
  const phones = [contact.phone, contact.whatsappNumber].filter((p): p is string => !!p);
  const or: Record<string, unknown>[] = [];
  if (phones.length) or.push({ phone: { $in: phones } }, { whatsappNumber: { $in: phones } });
  if (contact.email) or.push({ email: contact.email });
  if (!or.length) return [];

  const leads = await LeadModel.find({
    organizationId: ctx.organizationId,
    deletedAt: null,
    mergedInto: null,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    $or: or,
  })
    .select('leadNumber fullName phone whatsappNumber email leadStage leadStatus leadSource campaign sourceHistory assignedCounsellor createdAt')
    .sort({ createdAt: 1 })
    .limit(10)
    .populate({ path: 'assignedCounsellor', select: 'fullName', match: { organizationId: ctx.organizationId } })
    .lean<
      {
        _id: Types.ObjectId;
        leadNumber: number;
        fullName: string;
        phone?: string;
        whatsappNumber?: string;
        email?: string;
        leadStage: string;
        leadStatus: string;
        leadSource: string;
        campaign?: string;
        sourceHistory?: { leadSource?: string }[];
        assignedCounsellor: { fullName: string } | null;
        createdAt: Date;
      }[]
    >();

  return leads.map((l) => {
    const matchedOn: DuplicateMatch['matchedOn'] = [];
    if ((l.phone && phones.includes(l.phone)) || (l.whatsappNumber && phones.includes(l.whatsappNumber))) {
      if (contact.phone && (l.phone === contact.phone || l.whatsappNumber === contact.phone)) matchedOn.push('phone');
      if (contact.whatsappNumber && (l.phone === contact.whatsappNumber || l.whatsappNumber === contact.whatsappNumber)) {
        matchedOn.push('whatsappNumber');
      }
    }
    if (contact.email && l.email === contact.email) matchedOn.push('email');
    return {
      _id: l._id,
      leadNumber: l.leadNumber,
      fullName: l.fullName,
      matchedOn,
      leadStage: l.leadStage,
      leadStatus: l.leadStatus,
      originalSource: l.sourceHistory?.[0]?.leadSource ?? l.leadSource,
      latestSource: l.sourceHistory?.at(-1)?.leadSource ?? l.leadSource,
      campaign: l.campaign ?? null,
      assignedCounsellor: l.assignedCounsellor?.fullName ?? null,
      createdAt: l.createdAt,
    };
  });
}

export function duplicateConflict(duplicates: DuplicateMatch[]): ApiError {
  return new ApiError(409, 'A lead with this phone number or email already exists', [], 'DUPLICATE_LEAD', { duplicates });
}
