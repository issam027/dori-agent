import pg from 'pg';
import type { CloudCommand, CommandResult, CommandResultStatus } from './types.js';

const { Pool } = pg;

export interface StoredCommand {
  status: CommandResultStatus | 'RUNNING';
  result: CommandResult | null;
}

export interface AgentStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<void>;
  getCursor(): Promise<string | null>;
  setCursor(cursor: string): Promise<void>;
  reserveCommand(command: CloudCommand): Promise<StoredCommand | null>;
  completeCommand(result: CommandResult): Promise<void>;
}

export class PostgresAgentStore implements AgentStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS dorify_agent;
      CREATE TABLE IF NOT EXISTS dorify_agent.agent_state (
        state_key TEXT PRIMARY KEY,
        state_value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS dorify_agent.command_inbox (
        command_id UUID PRIMARY KEY,
        command_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL,
        result JSONB,
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMPTZ
      );
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async getCursor(): Promise<string | null> {
    const result = await this.pool.query<{ state_value: string }>(
      "SELECT state_value FROM dorify_agent.agent_state WHERE state_key = 'command_cursor'",
    );
    return result.rows[0]?.state_value ?? null;
  }

  async setCursor(cursor: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO dorify_agent.agent_state (state_key, state_value)
       VALUES ('command_cursor', $1)
       ON CONFLICT (state_key) DO UPDATE
       SET state_value = EXCLUDED.state_value, updated_at = CURRENT_TIMESTAMP`,
      [cursor],
    );
  }

  async reserveCommand(command: CloudCommand): Promise<StoredCommand | null> {
    const inserted = await this.pool.query(
      `INSERT INTO dorify_agent.command_inbox (command_id, command_type, payload, status)
       VALUES ($1, $2, $3, 'RUNNING')
       ON CONFLICT (command_id) DO NOTHING
       RETURNING command_id`,
      [command.commandId, command.type, command.payload],
    );
    if (inserted.rowCount) return null;

    const existing = await this.pool.query<{
      status: StoredCommand['status'];
      result: CommandResult | null;
    }>('SELECT status, result FROM dorify_agent.command_inbox WHERE command_id = $1', [
      command.commandId,
    ]);
    const row = existing.rows[0];
    if (!row) throw new Error('Command reservation disappeared');
    return row;
  }

  async completeCommand(result: CommandResult): Promise<void> {
    await this.pool.query(
      `UPDATE dorify_agent.command_inbox
       SET status = $2, result = $3, completed_at = CURRENT_TIMESTAMP
       WHERE command_id = $1`,
      [result.commandId, result.status, result],
    );
  }
}
