import { z } from 'zod';

export const commandTypeSchema = z.enum(['RUN_HEALTH_CHECK', 'SYNC_NOW']);
export type CommandType = z.infer<typeof commandTypeSchema>;

export const cloudCommandSchema = z.object({
  commandId: z.uuid(),
  type: commandTypeSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type CloudCommand = z.infer<typeof cloudCommandSchema>;

export const commandPageSchema = z.object({
  commands: z.array(cloudCommandSchema),
  nextCursor: z.string().min(1).nullable(),
});
export type CommandPage = z.infer<typeof commandPageSchema>;

export interface EngineHealth {
  status: 'ok' | 'degraded' | 'unreachable';
  checkedAt: string;
  details?: Record<string, unknown>;
}

export interface Heartbeat {
  installationId: string;
  sentAt: string;
  versions: { engine: string; app: string; agent: string };
  health: { agent: 'up'; engine: EngineHealth['status'] };
}

export type CommandResultStatus = 'SUCCEEDED' | 'FAILED' | 'EXPIRED';

export interface CommandResult {
  commandId: string;
  status: CommandResultStatus;
  completedAt: string;
  output?: Record<string, unknown>;
  error?: string;
}

export interface AgentRuntimeStatus {
  enabled: boolean;
  startedAt: string;
  lastCycleAt: string | null;
  lastCloudSuccessAt: string | null;
  lastCloudError: string | null;
  consecutiveCloudFailures: number;
}
