import { CloudHttpError, type CloudClient } from '../cloud-client.js';
import type { EngineClient } from '../engine-client.js';
import type { AgentStore } from '../store.js';
import { safeError } from '../logger.js';
import type { CloudCommand, CommandResult } from '../types.js';

/** Durable command processing, isolated from heartbeat and tracking orchestration. */
export class CommandProcessor {
  constructor(
    private readonly store: AgentStore,
    private readonly engine: EngineClient,
    private readonly cloud: CloudClient,
  ) {}
  async process(deadline: number, shouldContinue: () => boolean): Promise<void> {
    const page = await this.cloud.getCommands(await this.store.getCursor());
    for (const command of page.commands) {
      if (!shouldContinue() || Date.now() >= deadline) return;
      if (Date.parse(command.expiresAt) <= Date.now()) {
        await this.store.setCursor(command.commandId);
        continue;
      }
      const existing = await this.store.reserveCommand(command);
      if (existing) {
        if (!existing.result) return; // A live lease must never advance the cursor.
        await this.cloud.sendCommandResult(existing.result);
      } else {
        try {
          await this.cloud.acknowledgeCommand(command.commandId);
        } catch (error) {
          if (!(error instanceof CloudHttpError) || error.status !== 409) throw error;
          await this.store.completeCommand({
            commandId: command.commandId,
            status: 'EXPIRED',
            completedAt: new Date().toISOString(),
          });
          await this.store.setCursor(command.commandId);
          continue;
        }
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
}
