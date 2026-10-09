import { Types } from 'mongoose';
import type { AuthContext, ServiceContext } from '../../types/auth.js';
import { hasOrgScope } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { normalizeEmail, normalizePhone } from '../../utils/normalize.js';
import { escapeRegex } from '../../utils/pagination.js';
import { LeadModel } from './lead.model.js';

type Filter = Record<string, unknown>;

/**
 * Which leads the user may see (spec §6–8):
 *  organization → all; branch → leads in their branches or assigned to them; own → assigned to them.
 * Deleted leads are never visible.
 */
export function leadScopeFilter(ctx: AuthContext): Filter {
  const base: Filter = { organizationId: ctx.organizationId, deletedAt: null };
  if (hasOrgScope(ctx)) return base;
  const mine = [{ assignedCounsellor: ctx.userId }, { assignedManager: ctx.userId }];
  if (ctx.dataScope === 'branch') return { ...base, $or: [{ branchId: { $in: ctx.branchIds } }, ...mine] };
  return { ...base, $or: mine };
}

/** Combines the scope filter with extra conditions without clobbering its `$or`. */
export function scopedLeadFilter(ctx: AuthContext, ...conditions: Filter[]): Filter {
  const scope = leadScopeFilter(ctx);
  const and = conditions.filter((c) => Object.keys(c).length > 0);
  return and.length ? { ...scope, $and: and } : scope;
}

export async function loadLead(ctx: ServiceContext, id: string | Types.ObjectId) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Lead');
  const lead = await LeadModel.findOne(scopedLeadFilter(ctx, { _id: new Types.ObjectId(id) }));
  if (!lead) throw ApiError.notFound('Lead');
  return lead;
}

/**
 * Index-friendly search (spec §31): no unanchored regex scans.
 *  "#1001" / "L-1001"  → lead number
 *  contains "@"        → email prefix
 *  digits              → full phone/WhatsApp (≥10 digits) or phone prefix; short numbers also try the lead number
 *  words               → every word must prefix-match a name token
 */
export function buildLeadSearch(raw: string, countryCode: string): Filter {
  const s = raw.trim();
  if (!s) return {};

  const numbered = /^(?:#|l-?)(\d{1,9})$/i.exec(s);
  if (numbered) return { leadNumber: Number(numbered[1]) };

  if (s.includes('@')) return { email: { $regex: `^${escapeRegex(normalizeEmail(s))}` } };

  const digits = s.replace(/[\s().+-]/g, '');
  if (/^\d+$/.test(digits)) {
    const or: Filter[] = [];
    if (digits.length <= 9) or.push({ leadNumber: Number(digits) });
    if (digits.length >= 10) {
      const full = normalizePhone(s, countryCode);
      if (full) or.push({ phone: full }, { whatsappNumber: full });
    } else if (digits.length >= 4) {
      const prefix = s.trim().startsWith('+') ? `^\\+${digits}` : `^\\+${countryCode}${digits.replace(/^0+/, '')}`;
      or.push({ phone: { $regex: prefix } }, { whatsappNumber: { $regex: prefix } });
    }
    return or.length ? { $or: or } : { _id: null };
  }

  const tokens = s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 5);
  return tokens.length ? { $and: tokens.map((t) => ({ nameTokens: { $regex: `^${escapeRegex(t)}` } })) } : {};
}
