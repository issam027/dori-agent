import type { AgentConfig } from './config.js';
import type { CloudClient } from './cloud-client.js';
import type { EngineClient } from './engine-client.js';
import type { Logger } from './logger.js';
import { safeError } from './logger.js';
import type { AgentStore } from './store.js';
import type {
  AgentRuntimeStatus,
  CloudCommand,
  CommandResult,
  EngineHealth,
  Heartbeat,
} from './types.js';

export class DorifyAgent {
  private timer: NodeJS.Timeout | null = null;
  private controlTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private trackingWakeRequested = false;
  private shutdownWork: Promise<void> | null = null;
  private cycleWork: Promise<void> | null = null;
  private controlWork: Promise<boolean> | null = null;
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
    return {
      ...this.status,
      heartbeatAgeMs: this.status.lastHeartbeatAt
        ? Date.now() - Date.parse(this.status.lastHeartbeatAt)
        : null,
    };
  }

  async start(): Promise<void> {
    await this.store.initialize();
    const persisted = await this.store.getDeploymentControl();
    if (
      persisted &&
      (!persisted.installationId ||
        !this.config.enabled ||
        persisted.installationId === this.config.installationId)
    ) {
      Object.assign(this.status, persisted);
    } else if (persisted) {
      await this.store.saveDeploymentControl({
        installationId: this.config.installationId,
        deploymentStatus: 'unknown',
        lastStatusCheckedAt: null,
        lastCloudSuccessAt: null,
        lastCloudError: null,
      });
    }
    if (!this.config.enabled) {
      this.log.info('Agent disabled; local installation remains autonomous');
      return;
    }
    // Control-plane traffic never waits for tracking/notification backlogs.
    this.controlTimer = setInterval(
      () => {
        void this.refreshControl().catch((error: unknown) => this.recordFailure(error));
      },
      Math.min(30_000, this.config.pollIntervalMs),
    );
    this.schedule(0);
  }

  stop(): Promise<void> {
    if (this.shutdownWork) return this.shutdownWork;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.controlTimer) clearInterval(this.controlTimer);
    this.shutdownWork = Promise.allSettled([this.cycleWork, this.controlWork]).then(async () => {
      await this.store.close();
    });
    return this.shutdownWork;
  }

  runCycle(): Promise<void> {
    if (this.stopped || !this.config.enabled || !this.cloud) return Promise.resolve();
    if (this.cycleWork) return this.cycleWork;
    this.cycleWork = this.performCycle().finally(() => {
      this.cycleWork = null;
    });
    return this.cycleWork;
  }

  private async performCycle(): Promise<void> {
    this.status.lastCycleAt = new Date().toISOString();
    const started = Date.now();
    try {
      // Re-establish LISTEN after a database disconnect; periodic cycles recover missed events.
      await this.store
        .watchTrackingChanges?.(() => {
          if (this.stopped) return;
          this.trackingWakeRequested = true;
          if (!this.cycleWork && this.status.consecutiveCloudFailures === 0) this.schedule(100);
        })
        .catch((error: unknown) =>
          this.log.warn('Tracking LISTEN unavailable; periodic recovery remains active', {
            error: safeError(error),
          }),
        );
      if (!(await this.refreshControl()) || this.stopped) return;
      await this.processCommands(Date.now() + (this.config.syncBudgetMs ?? 10_000));
      await this.synchronizeTracking();
      await this.relayNotifications();
      if (this.store.getSyncMetrics)
        this.status.synchronization = await this.store.getSyncMetrics();
      this.status.lastCloudError = null;
      this.status.consecutiveCloudFailures = 0;
      await this.persistCurrentControl();
    } catch (error: unknown) {
      await this.recordFailure(error);
    } finally {
      this.status.lastCycleDurationMs = Date.now() - started;
    }
  }

  private refreshControl(): Promise<boolean> {
    if (this.controlWork) return this.controlWork;
    this.controlWork = this.performControl().finally(() => {
      this.controlWork = null;
    });
    return this.controlWork;
  }

  private async performControl(): Promise<boolean> {
    if (this.stopped || !this.cloud) return false;
    const installation = await this.cloud.getInstallationStatus();
    if (installation.installationId !== this.config.installationId) {
      throw new Error('Cloud returned a status for another installation');
    }
    Object.assign(this.status, {
      deploymentStatus: installation.deploymentStatus,
      lastStatusCheckedAt: installation.checkedAt,
      lastCloudSuccessAt: new Date().toISOString(),
    });
    await this.persistCurrentControl();
    if (installation.deploymentStatus === 'revoked') return false;
    const health = await this.engine.health();
    await this.cloud.sendHeartbeat(this.heartbeat(health));
    this.status.lastHeartbeatAt = new Date().toISOString();
    return true;
  }

  private async recordFailure(error: unknown): Promise<void> {
    this.status.consecutiveCloudFailures += 1;
    this.status.lastCloudError = safeError(error);
    if (!this.stopped) {
      await this.store.skipPendingNotifications('CLOUD_UNAVAILABLE').catch(() => undefined);
      await this.persistCurrentControl().catch((failure: unknown) => {
        this.log.error('Failed to persist cloud control status', { error: safeError(failure) });
      });
    }
    this.log.warn('Cloud cycle failed; local installation remains autonomous', {
      failures: this.status.consecutiveCloudFailures,
      error: this.status.lastCloudError,
    });
  }

  private async synchronizeTracking(): Promise<void> {
    if (!this.cloud || this.stopped || this.status.deploymentStatus !== 'active') return;
    await this.store.refreshTracking();
    const deadline = Date.now() + (this.config.syncBudgetMs ?? 10_000);
    let sent = 0;
    let batches = 0;
    for (let batch = 0; batch < (this.config.syncMaxBatches ?? 100); batch++) {
      if (this.stopped || Date.now() >= deadline || this.status.deploymentStatus !== 'active')
        break;
      // Reserve every fourth batch for FIFO backlog to prevent starvation.
      const items = await this.store.listUnsyncedTracking(batch % 4 !== 3);
      if (!items.length) break;
      await this.cloud.syncTracking(items);
      await this.store.markTrackingSynced(items);
      sent += items.length;
      batches++;
    }
    this.status.lastTrackingBatchCount = batches;
    this.status.lastTrackingProjectionCount = sent;
  }

  private async relayNotifications(): Promise<void> {
    if (!this.cloud || this.stopped || this.status.deploymentStatus !== 'active') return;
    const items = await this.store.listPendingNotifications();
    const deadline = Date.now() + (this.config.syncBudgetMs ?? 10_000);
    let cursor = 0;
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(3, items.length) }, async () => {
        while (
          cursor < items.length &&
          Date.now() < deadline &&
          !this.stopped &&
          this.status.deploymentStatus === 'active'
        ) {
          const item = items[cursor++];
          if (!item || !this.cloud) return;
          await this.cloud.relayNotification(item);
          await this.store.markNotificationRelayed(item.notificationId);
        }
      }),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  private persistCurrentControl(): Promise<void> {
    return this.store.saveDeploymentControl({
      installationId: this.config.installationId,
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

  private async processCommands(deadline: number): Promise<void> {
    if (!this.cloud) return;
    const page = await this.cloud.getCommands(await this.store.getCursor());
    for (const command of page.commands) {
      if (this.stopped || Date.now() >= deadline || this.status.deploymentStatus !== 'active')
        return;
      const existing = await this.store.reserveCommand(command);
      if (existing) {
        if (!existing.result) return; // A live lease must never advance the cursor.
        await this.cloud.sendCommandResult(existing.result);
      } else {
        await this.cloud.acknowledgeCommand(command.commandId);
        const result = await this.executeCommand(command);
        await this.store.completeCommand(result);
        await this.cloud.sendCommandResult(result);
      }
      // The edge API cursor is the last processed command UUID, including partial pages.
      await this.store.setCursor(command.commandId);
    }
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
        return this.success(command.commandId, { health: await this.engine.health() });
      }
      if (command.type === 'SYNC_NOW') return this.success(command.commandId, { accepted: true });
      return this.failure(command.commandId, 'Unsupported command');
    } catch (error: unknown) {
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
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.trackingWakeRequested = false;
      void this.runCycle().finally(() => {
        const delay =
          this.trackingWakeRequested && this.status.consecutiveCloudFailures === 0
            ? 100
            : this.nextDelay();
        this.trackingWakeRequested = false;
        this.schedule(delay);
      });
    }, delayMs);
  }
  private nextDelay(): number {
    if (this.status.consecutiveCloudFailures === 0) return this.config.pollIntervalMs;
    const exponent = Math.min(this.status.consecutiveCloudFailures - 1, 6);
    return Math.min(
      this.config.pollIntervalMs * 2 ** exponent * (0.8 + Math.random() * 0.4),
      300_000,
    );
  }
}
