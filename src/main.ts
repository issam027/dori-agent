import { DorifyAgent } from './agent.js';
import { HttpCloudClient, type CloudClient } from './cloud-client.js';
import { loadConfig } from './config.js';
import { HttpEngineClient } from './engine-client.js';
import { createHealthServer } from './health-server.js';
import { logger, safeError } from './logger.js';
import { PostgresAgentStore } from './store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new PostgresAgentStore(config.databaseUrl);
  const engine = new HttpEngineClient(config);
  const cloud = createCloudClient(config);
  const agent = new DorifyAgent(config, store, engine, cloud, logger);
  const server = createHealthServer(config.port, agent, store);

  await agent.start();
  logger.info('Health server listening', { port: config.port });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    server.close();
    await agent.stop();
    process.exitCode = 0;
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

function createCloudClient(config: ReturnType<typeof loadConfig>): CloudClient | null {
  if (!config.enabled) return null;
  return new HttpCloudClient({
    cloudUrl: config.cloudUrl as string,
    cloudToken: config.cloudToken as string,
    installationId: config.installationId as string,
    requestTimeoutMs: config.requestTimeoutMs,
    tls: config.tls,
  });
}

main().catch((error: unknown) => {
  logger.error('Agent failed to start', { error: safeError(error) });
  process.exitCode = 1;
});
