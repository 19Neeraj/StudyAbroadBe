import type { Request } from 'express';

/**
 * Advertising provider contract (Integrations plan §3). Lead import, campaign mapping, attribution
 * and reporting depend only on this interface; Meta, Google Ads or others plug in behind it.
 */
export interface AdsCredentials {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface ValidationResult {
  ok: boolean;
  /** Who/what the token belongs to, for display. */
  accountName?: string;
  grantedScopes: string[];
  missingScopes: string[];
  expiresAt?: Date;
  error?: string;
}

export interface ExternalAccount {
  type: 'business' | 'ad_account' | 'page' | 'lead_form';
  externalId: string;
  name?: string;
  parentExternalId?: string;
  currency?: string;
  timezone?: string;
  status?: string;
}

export interface ExternalEntity {
  level: 'campaign' | 'adset' | 'ad';
  externalId: string;
  parentExternalId?: string;
  campaignExternalId?: string;
  name?: string;
  status?: string;
  effectiveStatus?: string;
  objective?: string;
  startAt?: Date;
  endAt?: Date;
  /** Major units as the provider reports them; converted to minor units by the CRM. */
  dailyBudget?: number;
  lifetimeBudget?: number;
  destinationUrl?: string;
  urlTags?: string;
}

/** Metrics absent from a row are "unavailable" (null), never zero. Money is in major units. */
export interface DailyMetricRow {
  level: 'account' | 'campaign' | 'adset' | 'ad';
  externalId: string;
  campaignExternalId?: string;
  date: string;
  currency?: string;
  spend?: number;
  impressions?: number;
  reach?: number;
  clicks?: number;
  linkClicks?: number;
  ctr?: number;
  linkCtr?: number;
  cpc?: number;
  costPerLinkClick?: number;
  cpm?: number;
  providerLeads?: number;
  actions?: { type: string; value: number }[];
}

export interface ExternalLead {
  externalLeadId: string;
  submittedAt?: Date;
  formExternalId?: string;
  pageExternalId?: string;
  campaignExternalId?: string;
  campaignName?: string;
  adsetExternalId?: string;
  adsetName?: string;
  adExternalId?: string;
  adName?: string;
  formName?: string;
  /** e.g. facebook / instagram when the provider says so. */
  platform?: string;
  isOrganic?: boolean;
  /** Form answers exactly as received: field name → value(s). */
  answers: Record<string, string>;
  /** UTMs / click IDs only if the provider actually delivered them. */
  tracking?: Record<string, string>;
}

export interface AdsWebhookEvent {
  eventKey: string;
  kind: 'lead' | 'other';
  externalLeadId?: string;
  pageExternalId?: string;
  formExternalId?: string;
  adExternalId?: string;
  raw: unknown;
}

export class ProviderRateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs = 60_000) {
    super(message);
  }
}
export class ProviderAuthError extends Error {}

export interface AdsProvider {
  readonly key: string;
  readonly label: string;
  readonly kind: 'meta_ads' | 'google_ads';
  readonly capabilities: { leads: boolean; metrics: boolean; webhooks: boolean; writeUrlTags: boolean };
  /** Scopes the CRM needs; validate() reports which are missing. */
  readonly requiredScopes: readonly string[];
  /** Secret keys the connect form asks for (write-only) and non-secret config keys. */
  readonly secretKeys: readonly string[];
  readonly configKeys: readonly string[];
  validate(creds: AdsCredentials): Promise<ValidationResult>;
  listAccounts(creds: AdsCredentials): Promise<ExternalAccount[]>;
  /** Lead forms of one page (called for selected pages). */
  listLeadForms?(creds: AdsCredentials, pageExternalId: string): Promise<ExternalAccount[]>;
  syncCampaigns(creds: AdsCredentials, adAccountExternalId: string): AsyncIterable<ExternalEntity>;
  fetchDailyMetrics(creds: AdsCredentials, adAccountExternalId: string, level: DailyMetricRow['level'], from: string, to: string): AsyncIterable<DailyMetricRow>;
  fetchLead(creds: AdsCredentials, externalLeadId: string): Promise<ExternalLead>;
  pollLeads?(creds: AdsCredentials, formExternalId: string, since: Date): AsyncIterable<ExternalLead>;
  /** Throws when the signature is invalid. */
  verifyWebhook?(req: Request, creds: AdsCredentials): void;
  /** Answers the provider's subscription handshake (GET) or null if it doesn't match. */
  webhookChallenge?(query: Record<string, unknown>, creds: AdsCredentials): string | null;
  parseWebhook?(req: Request): AdsWebhookEvent[];
}
