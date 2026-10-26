import { startDemo } from './launcher.js';

const demo = await startDemo({ dataDir: process.env.FCTP_DATA_DIR ?? '.fctp-data' });
process.stdout.write(`FCTP local demo listening at ${demo.origins.client}\n`);
let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await demo.close();
};
process.once('SIGINT', () => { void shutdown().then(() => { process.exitCode = 0; }); });
process.once('SIGTERM', () => { void shutdown().then(() => { process.exitCode = 0; }); });
