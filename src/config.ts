import { readFileSync } from 'node:fs';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    AGENT_ENABLED: booleanString,
    AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    AGENT_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(30_000),
    AGENT_SYNC_MAX_BATCHES: z.coerce.number().int().min(1).max(1000).default(100),
    AGENT_SYNC_BUDGET_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
    AGENT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
    DATABASE_URL: z.string().url(),
    DORIFY_ENGINE_URL: z.string().url().default('http://engine:3000'),
    DORIFY_CLOUD_URL: z.string().url().optional(),
    DORIFY_INSTALLATION_ID: z.uuid().optional(),
    DORIFY_CLOUD_TOKEN: z.string().min(32).optional(),
    DORIFY_MTLS_CERT_PATH: z.string().min(1).optional(),
    DORIFY_MTLS_KEY_PATH: z.string().min(1).optional(),
    DORIFY_MTLS_CA_PATH: z.string().min(1).optional(),
    DORIFY_ENGINE_VERSION: z.string().min(1).default('dev'),
    DORIFY_APP_VERSION: z.string().min(1).default('dev'),
    DORIFY_AGENT_VERSION: z.string().min(1).default('0.1.0'),
  })
  .superRefine((environment, context) => {
    if (!environment.AGENT_ENABLED) return;
    for (const field of [
      'DORIFY_CLOUD_URL',
      'DORIFY_INSTALLATION_ID',
      'DORIFY_CLOUD_TOKEN',
    ] as const) {
      if (!environment[field]) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is required when enabled`,
        });
      }
    }
    if (Boolean(environment.DORIFY_MTLS_CERT_PATH) !== Boolean(environment.DORIFY_MTLS_KEY_PATH)) {
      context.addIssue({
        code: 'custom',
        path: ['DORIFY_MTLS_CERT_PATH'],
        message: 'Certificate and key paths must be configured together',
      });
    }
  });

export interface AgentConfig {
  nodeEnv: 'development' | 'test' | 'production';
  enabled: boolean;
  port: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  syncMaxBatches?: number;
  syncBudgetMs?: number;
  databaseUrl: string;
  engineUrl: string;
  cloudUrl?: string;
  installationId?: string;
  cloudToken?: string;
  tls?: { cert?: Buffer; key?: Buffer; ca?: Buffer };
  versions: { engine: string; app: string; agent: string };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    nodeEnv: parsed.NODE_ENV,
    enabled: parsed.AGENT_ENABLED,
    port: parsed.AGENT_PORT,
    pollIntervalMs: parsed.AGENT_POLL_INTERVAL_MS,
    requestTimeoutMs: parsed.AGENT_REQUEST_TIMEOUT_MS,
    syncMaxBatches: parsed.AGENT_SYNC_MAX_BATCHES,
    syncBudgetMs: parsed.AGENT_SYNC_BUDGET_MS,
    databaseUrl: parsed.DATABASE_URL,
    engineUrl: stripTrailingSlash(parsed.DORIFY_ENGINE_URL),
    cloudUrl: parsed.DORIFY_CLOUD_URL ? stripTrailingSlash(parsed.DORIFY_CLOUD_URL) : undefined,
    installationId: parsed.DORIFY_INSTALLATION_ID,
    cloudToken: parsed.DORIFY_CLOUD_TOKEN,
    tls: loadTlsFiles(parsed),
    versions: {
      engine: parsed.DORIFY_ENGINE_VERSION,
      app: parsed.DORIFY_APP_VERSION,
      agent: parsed.DORIFY_AGENT_VERSION,
    },
  };
}

function loadTlsFiles(environment: z.infer<typeof environmentSchema>): AgentConfig['tls'] {
  const cert = environment.DORIFY_MTLS_CERT_PATH
    ? readFileSync(environment.DORIFY_MTLS_CERT_PATH)
    : undefined;
  const key = environment.DORIFY_MTLS_KEY_PATH
    ? readFileSync(environment.DORIFY_MTLS_KEY_PATH)
    : undefined;
  const ca = environment.DORIFY_MTLS_CA_PATH
    ? readFileSync(environment.DORIFY_MTLS_CA_PATH)
    : undefined;
  return cert || key || ca ? { cert, key, ca } : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
