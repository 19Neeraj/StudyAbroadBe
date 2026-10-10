import { Types } from 'mongoose';
import { registerJob, scheduleRepeating } from '../../jobs/queue.js';
import { runExport } from './export.service.js';
import { ExternalLeadReferenceModel } from './externalLeadReference.model.js';
import { ingestLead } from './leadImport.service.js';
import { runSync, scheduleDueSyncs } from './sync.service.js';
import type { SyncTrigger, SyncType } from './syncLog.model.js';

const ANSWER_RETENTION_DAYS = 180;

export function registerMarketingJobs(): void {
  registerJob<{ organizationId: string; integrationId: string; type: SyncType; trigger: SyncTrigger; triggeredBy?: string; from?: string; to?: string }>(
    'ads.sync',
    async (d) => runSync({ ...d, organizationId: new Types.ObjectId(d.organizationId), integrationId: new Types.ObjectId(d.integrationId), triggeredBy: d.triggeredBy ? new Types.ObjectId(d.triggeredBy) : undefined }),
    { attempts: 3, backoffMs: 60_000 },
  );
  registerJob<{ organizationId: string; provider: string; externalLeadId: string; via: 'webhook' | 'poll' | 'retry' }>(
    'ads.processLead',
    async (d) => {
      await ingestLead(new Types.ObjectId(d.organizationId), d.provider, { externalLeadId: d.externalLeadId }, d.via);
    },
    { attempts: 5, backoffMs: 30_000 },
  );
  registerJob<{ organizationId: string; jobId: string }>('marketing.export', async (d) => runExport(new Types.ObjectId(d.organizationId), new Types.ObjectId(d.jobId)), { attempts: 2 });
  registerJob('ads.scheduled', async () => scheduleDueSyncs(), { attempts: 1 });
  // Form answers are personal data; the import record (IDs, outcome) stays for audit.
  registerJob('ads.retention', async () => {
    await ExternalLeadReferenceModel.updateMany({ createdAt: { $lt: new Date(Date.now() - ANSWER_RETENTION_DAYS * 86_400_000) }, answers: { $exists: true } }, { $unset: { answers: 1 } }).setOptions({ skipTenantGuard: true });
  }, { attempts: 1 });
}

export async function scheduleMarketingJobs(): Promise<void> {
  await scheduleRepeating('ads.scheduled', 15 * 60_000);
  await scheduleRepeating('ads.retention', 24 * 3_600_000);
}
