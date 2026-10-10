import { Types } from 'mongoose';
import type { ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { escapeRegex } from '../../utils/pagination.js';
import { AttributionTouchpointModel } from '../marketing/touchpoint.model.js';
import { LeadInquiryModel } from './inquiry.model.js';
import type { LeadListQuery } from './lead.validation.js';

type Filter = Record<string, unknown>;

/** A history sub-query may narrow leads to at most this many IDs; beyond that, ask for a narrower range. */
const MAX_HISTORY_IDS = 50_000;

const LEVELS = [
  ['source', 'sourcePrimary', 'sourceSecondary', 'sourceTertiary'],
  ['medium', 'mediumPrimary', 'mediumSecondary', 'mediumTertiary'],
  ['campaign', 'campaignPrimary', 'campaignSecondary', 'campaignTertiary'],
] as const;

const TRACKING = [
  ['utmSource', 'utmSource', 'normalized.utm_source'],
  ['utmMedium', 'utmMedium', 'normalized.utm_medium'],
  ['utmCampaign', 'utmCampaign', 'normalized.utm_campaign'],
  ['utmTerm', 'utmTerm', 'normalized.utm_term'],
  ['utmContent', 'utmContent', 'normalized.utm_content'],
  ['provider', 'provider', 'provider'],
  ['campaignExternalId', 'campaignExternalId', 'campaignExternalId'],
  ['adExternalId', 'adExternalId', 'adExternalId'],
  ['formExternalId', 'formExternalId', 'leadFormExternalId'],
] as const;

const ids = (v: string[]) => ({ $in: v.map((x) => new Types.ObjectId(x)) });
const ci = (v: string, key: string) => (key.startsWith('utm') ? v.trim().toLowerCase() : v.trim());

async function historyLeadIds(model: 'touchpoint' | 'inquiry', filter: Filter): Promise<Types.ObjectId[]> {
  const found =
    model === 'touchpoint'
      ? await AttributionTouchpointModel.distinct('leadId', filter)
      : await LeadInquiryModel.distinct('leadId', filter);
  if (found.length > MAX_HISTORY_IDS) {
    throw ApiError.validation([{ field: 'query', message: 'This history filter matches too many leads; add a date range or another filter' }]);
  }
  return (found as (Types.ObjectId | null)[]).filter((x): x is Types.ObjectId => !!x);
}

/**
 * Re-inquiry, hierarchical attribution, UTM and integration filters for the lead list (and every
 * path that reuses it: pipeline, exports, reports). Attribution matches one explicit context:
 *  - original: the lead's first-touch attribution (`attribution`, `firstTouch`)
 *  - latest:   the most recent inquiry (`latestAttribution`, `latestTouch`)
 *  - any:      any touchpoint in the lead's history (sub-query on touchpoints)
 * The caller ANDs the result with the user's data scope before pagination and counting.
 */
export async function inquiryAndAttributionFilters(ctx: ServiceContext, q: Partial<LeadListQuery>): Promise<Filter[]> {
  const and: Filter[] = [];

  // --- inquiry counters (on the lead; maintained atomically) ---
  if (q.inquiryType === 'reinquiry') and.push({ inquiryCount: { $gte: 2 } });
  if (q.inquiryType === 'first_time') and.push({ $or: [{ inquiryCount: { $lte: 1 } }, { inquiryCount: null }] });
  if (q.inquiryCountMin || q.inquiryCountMax) {
    and.push({ inquiryCount: { ...(q.inquiryCountMin ? { $gte: q.inquiryCountMin } : {}), ...(q.inquiryCountMax ? { $lte: q.inquiryCountMax } : {}) } });
  }
  const range = (from?: Date, to?: Date) => ({ ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) });
  if (q.firstInquiryFrom || q.firstInquiryTo) and.push({ firstInquiryAt: range(q.firstInquiryFrom, q.firstInquiryTo) });
  if (q.lastInquiryFrom || q.lastInquiryTo) and.push({ lastInquiryAt: range(q.lastInquiryFrom, q.lastInquiryTo) });

  // --- inquiry history (date range / channel / queue status) ---
  if (q.inquiryFrom || q.inquiryTo || q.inquiryChannel?.length || q.inquiryStatus) {
    const f: Filter = { organizationId: ctx.organizationId };
    if (q.inquiryFrom || q.inquiryTo) f.occurredAt = range(q.inquiryFrom, q.inquiryTo);
    if (q.inquiryChannel?.length) f.channel = { $in: q.inquiryChannel };
    if (q.inquiryStatus) Object.assign(f, { status: q.inquiryStatus, isReinquiry: true });
    and.push({ _id: { $in: await historyLeadIds('inquiry', f) } });
  }

  // --- hierarchy + tracking, in the chosen attribution context ---
  const mode = q.attributionMode ?? 'original';
  const leadAttr = mode === 'latest' ? 'latestAttribution' : 'attribution';
  const leadTouch = mode === 'latest' ? 'latestTouch' : 'firstTouch';
  const onLead: Filter = {};
  const onTouch: Filter = {};
  for (const [dim, p, s, t] of LEVELS) {
    for (const [level, key] of [[1, p], [2, s], [3, t]] as const) {
      const v = q[key];
      if (!v?.length) continue;
      onLead[`${leadAttr}.${dim}.l${level}`] = ids(v);
      onTouch[`${dim}.l${level}`] = ids(v);
    }
  }
  for (const [key, leadField, touchField] of TRACKING) {
    const v = q[key];
    if (!v) continue;
    onLead[`${leadTouch}.${leadField}`] = ci(v, key);
    onTouch[touchField] = ci(v, key);
  }
  if (q.landingPage) {
    const prefix = { $regex: `^${escapeRegex(q.landingPage.trim())}` };
    onLead[`${leadTouch}.landingPage`] = prefix;
    Object.assign(onTouch, { $or: [{ 'raw.landing_url': prefix }, { 'raw.page_url': prefix }] });
  }
  if (Object.keys(onLead).length) {
    if (mode === 'any') {
      and.push({ _id: { $in: await historyLeadIds('touchpoint', { organizationId: ctx.organizationId, leadId: { $ne: null }, ...onTouch }) } });
    } else {
      and.push(onLead);
    }
  }
  return and;
}
