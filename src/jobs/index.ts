import { registerCallJobs, scheduleCallJobs } from '../modules/calls/call.pipeline.js';
import { registerMarketingJobs, scheduleMarketingJobs } from '../modules/marketing/marketing.jobs.js';
import { registerReportJobs } from '../modules/reports/report.service.js';
import { registerNotificationJobs, scheduleNotificationJobs } from '../modules/notifications/notification.jobs.js';

/** Registers every background job handler (API process and standalone workers). */
export function registerJobs(): void {
  registerCallJobs();
  registerMarketingJobs();
  registerReportJobs();
  registerNotificationJobs();
}

export async function scheduleJobs(): Promise<void> {
  await scheduleCallJobs();
  await scheduleMarketingJobs();
  await scheduleNotificationJobs();
}
