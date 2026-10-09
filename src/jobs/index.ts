import { registerCallJobs, scheduleCallJobs } from '../modules/calls/call.pipeline.js';

/** Registers every background job handler (API process and standalone workers). */
export function registerJobs(): void {
  registerCallJobs();
}

export async function scheduleJobs(): Promise<void> {
  await scheduleCallJobs();
}
