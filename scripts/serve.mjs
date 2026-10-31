import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { readDeploymentConfig, startDeployment } from './deployment.mjs';

export async function serve(args = process.argv.slice(2)) {
  if (args.length !== 2) throw new TypeError('Usage: node scripts/serve.mjs SERVICE CONFIG_PATH');
  const [service, configPath] = args;
  const config = await readDeploymentConfig(service, configPath);
  const deployment = await startDeployment(service, config);
  console.log(`${service} ${deployment.origin} ${deployment.listenAddress}`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    try {
      await deployment.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  };
  const onInterrupt = () => { void shutdown(); };
  const onTerminate = () => { void shutdown(); };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  return deployment;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await serve();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Deployment startup failed';
    console.error(message);
    process.exitCode = 1;
  }
}
