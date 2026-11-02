import { CloudHttpError } from '../src/cloud-client.js';
import { describe, expect, it, vi } from 'vitest';
import { DorifyAgent } from '../src/agent.js';
import type { CloudClient } from '../src/cloud-client.js';
import type { AgentConfig } from '../src/config.js';
import type { EngineClient } from '../src/engine-client.js';
import type { Logger } from '../src/logger.js';
import type { AgentStore, StoredCommand } from '../src/store.js';
import type { CloudCommand, CommandResult, DeploymentControlState } from '../src/types.js';

const config: AgentConfig = {
  nodeEnv: 'test',
  enabled: true,
  port: 3100,
  pollIntervalMs: 30_000,
  requestTimeoutMs: 1_000,
  databaseUrl: 'postgresql://unused',
  engineUrl: 'http://engine:3000',
  cloudUrl: 'https://cloud.dorify.app',
  cloudToken: 'token',
  installationId: '00000000-0000-4000-8000-000000000001',
  versions: { engine: 'dev', app: 'dev', agent: '0.1.0' },
};

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

class MemoryStore implements AgentStore {
  cursor: string | null = null;
  commands = new Map<string, StoredCommand>();
  control: DeploymentControlState | null = null;
  async initialize() {}
  async close() {}
  async ping() {}
  async getCursor() {
    return this.cursor;
  }
  async setCursor(cursor: string) {
    this.cursor = cursor;
  }
  async getDeploymentControl() {
    return this.control;
  }
  async saveDeploymentControl(state: DeploymentControlState) {
    this.control = { ...state };
  }
  async reserveCommand(command: CloudCommand) {
    const existing = this.commands.get(command.commandId);
    if (existing) return existing;
    this.commands.set(command.commandId, { status: 'RUNNING', result: null });
    return null;
  }
  async completeCommand(result: CommandResult) {
    this.commands.set(result.commandId, { status: result.status, result });
  }
  async refreshTracking() {}
  async listUnsyncedTracking(): Promise<import('../src/types.js').TrackingProjection[]> {
    return [];
  }
  async markTrackingSynced() {}
  async listPendingNotifications() {
    return [];
  }
  async markNotificationRelayed() {}
  async skipPendingNotifications() {}
}

const engine: EngineClient = {
  health: async () => ({ status: 'ok', checkedAt: new Date().toISOString() }),
};

describe('DorifyAgent', () => {
  it('records a cloud outage without failing the autonomous local installation', async () => {
    const cloud: CloudClient = {
      getInstallationStatus: async () => ({
        installationId: config.installationId as string,
        deploymentStatus: 'active',
        checkedAt: new Date().toISOString(),
      }),
      sendHeartbeat: async () => {
        throw new Error('offline');
      },
      getCommands: async () => ({ commands: [], nextCursor: null }),
      acknowledgeCommand: async () => undefined,
      sendCommandResult: async () => undefined,
      relayNotification: async () => undefined,
      syncTracking: async () => undefined,
    };
    const agent = new DorifyAgent(config, new MemoryStore(), engine, cloud, silentLogger);

    await expect(agent.runCycle()).resolves.toBeUndefined();
    expect(agent.getStatus()).toMatchObject({
      consecutiveCloudFailures: 1,
      lastCloudError: 'offline',
    });
  });

  it('executes an allow-listed command once and replays its stored result', async () => {
    const command: CloudCommand = {
      commandId: '00000000-0000-4000-8000-000000000010',
      type: 'RUN_HEALTH_CHECK',
      payload: {},
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const results: CommandResult[] = [];
    const cloud: CloudClient = {
      getInstallationStatus: async () => ({
        installationId: config.installationId as string,
        deploymentStatus: 'active',
        checkedAt: new Date().toISOString(),
      }),
      sendHeartbeat: async () => undefined,
      getCommands: async () => ({ commands: [command], nextCursor: 'cursor-1' }),
      acknowledgeCommand: async () => undefined,
      sendCommandResult: async (result) => {
        results.push(result);
      },
      relayNotification: async () => undefined,
      syncTracking: async () => undefined,
    };
    const store = new MemoryStore();
    const agent = new DorifyAgent(config, store, engine, cloud, silentLogger);

    await agent.runCycle();
    await agent.runCycle();

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.status).toBe('SUCCEEDED');
    expect(store.cursor).toBe(command.commandId);
  });

  it('persists a revoked deployment without sending supervision traffic', async () => {
    let heartbeatSent = false;
    let commandsPulled = false;
    const cloud: CloudClient = {
      getInstallationStatus: async () => ({
        installationId: config.installationId as string,
        deploymentStatus: 'revoked',
        checkedAt: new Date().toISOString(),
      }),
      sendHeartbeat: async () => {
        heartbeatSent = true;
      },
      getCommands: async () => {
        commandsPulled = true;
        return { commands: [], nextCursor: null };
      },
      acknowledgeCommand: async () => undefined,
      sendCommandResult: async () => undefined,
      relayNotification: async () => undefined,
      syncTracking: async () => undefined,
    };
    const store = new MemoryStore();
    const agent = new DorifyAgent(config, store, engine, cloud, silentLogger);

    await agent.runCycle();

    expect(agent.getStatus()).toMatchObject({
      deploymentStatus: 'revoked',
      consecutiveCloudFailures: 0,
    });
    expect(store.control?.deploymentStatus).toBe('revoked');
    expect(heartbeatSent).toBe(false);
    expect(commandsPulled).toBe(false);
  });

  it('restores a revoked status after restart without requiring cloud access', async () => {
    const store = new MemoryStore();
    store.control = {
      installationId: config.installationId,
      deploymentStatus: 'revoked',
      lastStatusCheckedAt: '2026-10-30T08:00:00.000Z',
      lastCloudSuccessAt: '2026-10-30T08:00:00.000Z',
      lastCloudError: 'offline',
    };
    const agent = new DorifyAgent({ ...config, enabled: false }, store, engine, null, silentLogger);

    await agent.start();

    expect(agent.getStatus()).toMatchObject({
      deploymentStatus: 'revoked',
      lastCloudError: 'offline',
    });
    await agent.stop();
  });

  it('rejects a cloud status issued for another installation identity', async () => {
    const store = new MemoryStore();
    const cloud: CloudClient = {
      getInstallationStatus: async () => ({
        installationId: '00000000-0000-4000-8000-000000000099',
        deploymentStatus: 'revoked',
        checkedAt: new Date().toISOString(),
      }),
      sendHeartbeat: async () => undefined,
      getCommands: async () => ({ commands: [], nextCursor: null }),
      acknowledgeCommand: async () => undefined,
      sendCommandResult: async () => undefined,
      relayNotification: async () => undefined,
      syncTracking: async () => undefined,
    };
    const agent = new DorifyAgent(config, store, engine, cloud, silentLogger);

    await agent.runCycle();

    expect(agent.getStatus()).toMatchObject({
      deploymentStatus: 'unknown',
      consecutiveCloudFailures: 1,
      lastCloudError: 'Cloud returned a status for another installation',
    });
    expect(store.control?.deploymentStatus).toBe('unknown');
  });

  it('does not carry a revoked status over to a newly configured identity', async () => {
    const store = new MemoryStore();
    store.control = {
      installationId: '00000000-0000-4000-8000-000000000099',
      deploymentStatus: 'revoked',
      lastStatusCheckedAt: '2026-10-30T08:00:00.000Z',
      lastCloudSuccessAt: '2026-10-30T08:00:00.000Z',
      lastCloudError: null,
    };
    const agent = new DorifyAgent(config, store, engine, null, silentLogger);

    await agent.start();

    expect(agent.getStatus().deploymentStatus).toBe('unknown');
    expect(store.control).toMatchObject({
      installationId: config.installationId,
      deploymentStatus: 'unknown',
    });
    await agent.stop();
  });
});
describe('agent operational guarantees', () => {
  function activeCloud(overrides: Partial<CloudClient> = {}): CloudClient {
    return {
      getInstallationStatus: async () => ({
        installationId: config.installationId as string,
        deploymentStatus: 'active',
        checkedAt: new Date().toISOString(),
      }),
      sendHeartbeat: async () => undefined,
      getCommands: async () => ({ commands: [], nextCursor: null }),
      acknowledgeCommand: async () => undefined,
      sendCommandResult: async () => undefined,
      relayNotification: async () => undefined,
      syncTracking: async () => undefined,
      ...overrides,
    };
  }

  it('keeps data-plane backoff after successful control heartbeats', async () => {
    let failing = true;
    const cloud = activeCloud({
      getCommands: () =>
        failing
          ? Promise.reject(new Error('transfer unavailable'))
          : Promise.resolve({ commands: [], nextCursor: null }),
    });
    const agent = new DorifyAgent(config, new MemoryStore(), engine, cloud, silentLogger);
    await agent.runCycle();
    await agent.runCycle();
    expect(agent.getStatus().consecutiveCloudFailures).toBe(2);
    failing = false;
    await agent.runCycle();
    expect(agent.getStatus().consecutiveCloudFailures).toBe(0);
    expect(agent.getStatus().lastCloudError).toBeNull();
  });

  it('sends bounded batches and gives heartbeat priority over the backlog', async () => {
    const order: string[] = [];
    const store = new MemoryStore();
    const item = {
      tokenHash: 'a'.repeat(64),
      registrationId: 'registration',
      sequence: 1,
      ticketNumber: 'A1',
      registrationStatus: 'waiting',
      queueName: 'Test',
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    store.listUnsyncedTracking = async () => Array.from({ length: 100 }, () => item);
    let acknowledged = 0;
    store.markTrackingSynced = async () => {
      acknowledged++;
    };
    const cloud = activeCloud({
      sendHeartbeat: async () => {
        order.push('heartbeat');
      },
      syncTracking: async () => {
        order.push('tracking');
      },
    });
    const agent = new DorifyAgent(
      { ...config, syncMaxBatches: 2 },
      store,
      engine,
      cloud,
      silentLogger,
    );
    await agent.runCycle();
    expect(order).toEqual(['heartbeat', 'tracking', 'tracking']);
    expect(acknowledged).toBe(2);
    expect(agent.getStatus().lastTrackingBatchCount).toBe(2);
    expect(agent.getStatus().lastTrackingProjectionCount).toBe(200);
  });

  it('waits for a running cycle before closing the database and tolerates repeated stop', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new MemoryStore();
    let closed = 0;
    store.close = async () => {
      closed++;
    };
    store.refreshTracking = async () => gate;
    const agent = new DorifyAgent(config, store, engine, activeCloud(), silentLogger);
    const cycle = agent.runCycle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stopped = agent.stop();
    expect(closed).toBe(0);
    release();
    await Promise.all([cycle, stopped, agent.stop()]);
    expect(closed).toBe(1);
  });

  it('keeps sending control heartbeats while tracking is blocked', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new MemoryStore();
    store.refreshTracking = async () => gate;
    const sendHeartbeat = vi.fn(async () => undefined);
    const agent = new DorifyAgent(
      config,
      store,
      engine,
      activeCloud({ sendHeartbeat }),
      silentLogger,
    );
    try {
      await agent.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sendHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      release();
      await agent.stop();
      vi.useRealTimers();
    }
  });

  it('coalesces database notifications into an immediate cycle without waiting for the safety interval', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    let changed: () => void = () => undefined;
    Object.assign(store, {
      watchTrackingChanges: (callback: () => void) => {
        changed = callback;
        return Promise.resolve();
      },
    });
    const refresh = vi.spyOn(store, 'refreshTracking');
    const agent = new DorifyAgent(config, store, engine, activeCloud(), silentLogger);
    try {
      await agent.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(1);
      changed();
      changed();
      changed();
      await vi.advanceTimersByTimeAsync(100);
      expect(refresh).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      await agent.stop();
      vi.useRealTimers();
    }
  });
});

it.each(['expired', 'refused'] as const)('never executes a %s command', async (kind) => {
  const command: CloudCommand = {
    commandId: '00000000-0000-4000-8000-000000000010',
    type: 'RUN_HEALTH_CHECK',
    payload: {},
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (kind === 'expired' ? -1000 : 60000)).toISOString(),
  };
  const acknowledgeCommand = vi.fn(async () => {
    throw new CloudHttpError(409);
  });
  const health = vi.fn(async () => ({ status: 'ok', checkedAt: new Date().toISOString() }));
  const cloud: CloudClient = {
    getInstallationStatus: async () => ({
      installationId: config.installationId as string,
      deploymentStatus: 'active',
      checkedAt: new Date().toISOString(),
    }),
    sendHeartbeat: async () => undefined,
    getCommands: async () => ({ commands: [command], nextCursor: null }),
    acknowledgeCommand,
    sendCommandResult: vi.fn(),
    relayNotification: async () => undefined,
    syncTracking: async () => undefined,
  };
  const store = new MemoryStore();
  await new DorifyAgent(config, store, { health }, cloud, silentLogger).runCycle();
  // One health probe is the normal heartbeat; the rejected command adds none.
  expect(health).toHaveBeenCalledTimes(1);
  expect(cloud.sendCommandResult).not.toHaveBeenCalled();
  expect(acknowledgeCommand).toHaveBeenCalledTimes(kind === 'expired' ? 0 : 1);
  expect(store.cursor).toBe(command.commandId);
});
