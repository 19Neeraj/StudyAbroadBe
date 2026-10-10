/** npm run seed:demo:clean — removes only the demo organization and its data (see demoClean.ts). */
import { logger } from '../config/logger.js';
import { connectDatabase, disconnectDatabase } from './connection.js';
import { removeDemoOrganization } from './demoClean.js';

async function run() {
  await connectDatabase();
  const removed = await removeDemoOrganization();
  logger.info(removed ? `Demo data removed (${removed.documents} documents)` : 'No demo organization found');
  await disconnectDatabase();
}

run().catch(async (err: unknown) => {
  logger.fatal({ err }, 'Demo clean-up failed');
  await disconnectDatabase();
  process.exit(1);
});
