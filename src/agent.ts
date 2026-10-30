import type { AgentConfig } from './config.js';
import type { CloudClient } from './cloud-client.js';
import type { EngineClient } from './engine-client.js';
import type { Logger } from './logger.js';
import { safeError } from './logger.js';
import type { AgentStore, StoredCommand } from './store.js';
import type {
  AgentRuntimeStatus,
  CloudCommand,
  CommandResult,
  EngineHealth,
  Heartbeat,
} from './types.js';

export class DorifyAgent {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private cycleRunning = false;
  private readonly status: AgentRuntimeStatus;

  constructor(
    private readonly config: AgentConfig,
    private readonly store: AgentStore,
    private readonly engine: EngineClient,
    private readonly cloud: CloudClient | null,
    private readonly log: Logger,
  ) {
    this.status = {
      enabled: config.enabled,
      startedAt: new Date().toISOString(),
      lastCycleAt: null,
      lastCloudSuccessAt: null,
      lastCloudError: null,
      consecutiveCloudFailures: 0,
      deploymentStatus: 'unknown',
      lastStatusCheckedAt: null,
    };
  }

  getStatus(): AgentRuntimeStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    await this.store.initialize();
    const persisted = await this.store.getDeploymentControl();
    if (persisted) Object.assign(this.status, persisted);
    if (!this.config.enabled) {
      this.log.info('Agent is disabled; local Dorify remains fully autonomous');
      return;
    }
    this.log.info('Agent started in outbound-only mode', {
      installationId: this.config.installationId,
    });
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.store.close();
  }

  async runCycle(): Promise<void> {
    if (this.cycleRunning || !this.config.enabled || !this.cloud) return;
    this.cycleRunning = true;
    this.status.lastCycleAt = new Date().toISOString();
    try {
      const installation = await this.cloud.getInstallationStatus();
      const cloudSuccessAt = new Date().toISOString();
      await this.store.saveDeploymentControl({
        deploymentStatus: installation.deploymentStatus,
        lastStatusCheckedAt: installation.checkedAt,
        lastCloudSuccessAt: cloudSuccessAt,
        lastCloudError: null,
      });
      Object.assign(this.status, {
        deploymentStatus: installation.deploymentStatus,
        lastStatusCheckedAt: installation.checkedAt,
        lastCloudSuccessAt: cloudSuccessAt,
        lastCloudError: null,
      });
      this.status.consecutiveCloudFailures = 0;
      if (installation.deploymentStatus === 'revoked') {
        this.log.warn('Installation is revoked in Dorify Cloud; local access is blocked', {
          installationId: this.config.installationId,
        });
        return;
      }
      const health = await this.engine.health();
      await this.cloud.sendHeartbeat(this.heartbeat(health));
      await this.processCommands();
      this.status.lastCloudSuccessAt = new Date().toISOString();
      this.status.lastCloudError = null;
      this.status.consecutiveCloudFailures = 0;
    } catch (error) {
      this.status.consecutiveCloudFailures += 1;
      this.status.lastCloudError = safeError(error);
      await this.persistCurrentControl().catch((persistenceError: unknown) =>
        this.log.error('Failed to persist cloud control status', {
          error: safeError(persistenceError),
        }),
      );
      this.log.warn('Cloud cycle failed; local Dorify is unaffected', {
        failures: this.status.consecutiveCloudFailures,
        error: this.status.lastCloudError,
      });
    } finally {
      this.cycleRunning = false;
    }
  }

  private persistCurrentControl(): Promise<void> {
    return this.store.saveDeploymentControl({
      deploymentStatus: this.status.deploymentStatus,
      lastStatusCheckedAt: this.status.lastStatusCheckedAt,
      lastCloudSuccessAt: this.status.lastCloudSuccessAt,
      lastCloudError: this.status.lastCloudError,
    });
  }

  private heartbeat(engineHealth: EngineHealth): Heartbeat {
    return {
      installationId: this.config.installationId as string,
      sentAt: new Date().toISOString(),
      versions: this.config.versions,
      health: { agent: 'up', engine: engineHealth.status },
    };
  }

  private async processCommands(): Promise<void> {
    if (!this.cloud) return;
    const cursor = await this.store.getCursor();
    const page = await this.cloud.getCommands(cursor);
    for (const command of page.commands) await this.processCommand(command);
    if (page.nextCursor) await this.store.setCursor(page.nextCursor);
  }

  private async processCommand(command: CloudCommand): Promise<void> {
    if (!this.cloud) return;
    const existing = await this.store.reserveCommand(command);
    if (existing) {
      await this.replayExistingResult(existing);
      return;
    }

    await this.cloud.acknowledgeCommand(command.commandId);
    const result = await this.executeCommand(command);
    await this.store.completeCommand(result);
    await this.cloud.sendCommandResult(result);
  }

  private async replayExistingResult(existing: StoredCommand): Promise<void> {
    if (existing.result && this.cloud) await this.cloud.sendCommandResult(existing.result);
  }

  private async executeCommand(command: CloudCommand): Promise<CommandResult> {
    if (Date.parse(command.expiresAt) <= Date.now()) {
      return {
        commandId: command.commandId,
        status: 'EXPIRED',
        completedAt: new Date().toISOString(),
      };
    }

    try {
      if (command.type === 'RUN_HEALTH_CHECK') {
        const health = await this.engine.health();
        return this.success(command.commandId, { health });
      }
      if (command.type === 'SYNC_NOW') {
        return this.success(command.commandId, { accepted: true });
      }
      return this.failure(command.commandId, 'Unsupported command');
    } catch (error) {
      return this.failure(command.commandId, safeError(error));
    }
  }

  private success(commandId: string, output: Record<string, unknown>): CommandResult {
    return { commandId, status: 'SUCCEEDED', completedAt: new Date().toISOString(), output };
  }

  private failure(commandId: string, error: string): CommandResult {
    return { commandId, status: 'FAILED', completedAt: new Date().toISOString(), error };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runCycle().finally(() => this.schedule(this.nextDelay()));
    }, delayMs);
  }

  private nextDelay(): number {
    if (this.status.consecutiveCloudFailures === 0) return this.config.pollIntervalMs;
    const exponent = Math.min(this.status.consecutiveCloudFailures - 1, 6);
    return Math.min(this.config.pollIntervalMs * 2 ** exponent, 300_000);
  }
}
