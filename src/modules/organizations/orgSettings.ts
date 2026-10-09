import type { Types } from 'mongoose';
import { OrganizationModel } from './organization.model.js';

export interface OrgSettings {
  timezone: string;
  currency: string;
  defaultCountryCode: string;
  dateFormat: string;
}

const DEFAULTS: OrgSettings = { timezone: 'Asia/Kolkata', currency: 'INR', defaultCountryCode: '91', dateFormat: 'DD MMM YYYY' };
const TTL_MS = 60_000;
const cache = new Map<string, { value: OrgSettings; expires: number }>();

/** Organization settings (time zone, phone country code, …) with a short in-process cache. */
export async function getOrgSettings(organizationId: Types.ObjectId): Promise<OrgSettings> {
  const key = organizationId.toString();
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const org = await OrganizationModel.findById(organizationId).select('settings').lean();
  const value = { ...DEFAULTS, ...(org?.settings ?? {}) } as OrgSettings;
  cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
}

export function invalidateOrgSettings(organizationId: Types.ObjectId | string): void {
  cache.delete(organizationId.toString());
}
