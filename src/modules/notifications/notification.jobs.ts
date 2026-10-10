import { Types } from 'mongoose';
import { registerJob, scheduleRepeating } from '../../jobs/queue.js';
import { deliver } from './notification.service.js';
import { followUpReminders } from './triggers.js';

export function registerNotificationJobs(): void {
  registerJob<{ organizationId: string; notificationId: string }>('notifications.deliver', async (d) => deliver(new Types.ObjectId(d.organizationId), new Types.ObjectId(d.notificationId)), { attempts: 3, backoffMs: 30_000 });
  registerJob('notifications.followups', async () => {
    await followUpReminders();
  }, { attempts: 1 });
}

export async function scheduleNotificationJobs(): Promise<void> {
  await scheduleRepeating('notifications.followups', 5 * 60_000);
}
