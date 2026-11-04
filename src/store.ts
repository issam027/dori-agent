import type { AgentConfig } from './config.js';
import pg from 'pg';
import type {
  CloudCommand,
  CommandResult,
  CommandResultStatus,
  DeploymentControlState,
  RelayNotification,
  TrackingProjection,
} from './types.js';

const { Pool } = pg;

export interface StoredCommand {
  status: CommandResultStatus | 'RUNNING';
  result: CommandResult | null;
}

export interface AgentStore {
  initialize(): Promise<void>;
  watchTrackingChanges?(onChange: () => void): Promise<void>;
  isTrackingListenerConnected?(): boolean;
  close(): Promise<void>;
  ping(): Promise<void>;
  getCursor(): Promise<string | null>;
  setCursor(cursor: string): Promise<void>;
  getDeploymentControl(): Promise<DeploymentControlState | null>;
  saveDeploymentControl(state: DeploymentControlState): Promise<void>;
  reserveCommand(command: CloudCommand): Promise<StoredCommand | null>;
  completeCommand(result: CommandResult): Promise<void>;
  refreshTracking(): Promise<void>;
  listUnsyncedTracking(preferLive?: boolean): Promise<TrackingProjection[]>;
  getSyncMetrics?(): Promise<{
    pendingTracking: number;
    oldestPendingAgeMs: number;
    runningCommands: number;
    poolWaiting: number;
  }>;
  markTrackingSynced(items: TrackingProjection[]): Promise<void>;
  listPendingNotifications(): Promise<RelayNotification[]>;
  markNotificationRelayed(notificationId: string): Promise<void>;
  skipPendingNotifications(reason: string): Promise<void>;
}

export class PostgresAgentStore implements AgentStore {
  private readonly pool: pg.Pool;
  private listener: pg.Client | null = null;
  private listenerWork: Promise<void> | null = null;
  private closing = false;

  constructor(
    private readonly databaseUrl: string,
    private readonly options?: AgentConfig['databaseOptions'],
  ) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      application_name: 'dorify-agent',
      max: options?.poolMax ?? 3,
      connectionTimeoutMillis: options?.connectionTimeoutMs ?? 5000,
      statement_timeout: options?.statementTimeoutMs ?? 30000,
      query_timeout: (options?.statementTimeoutMs ?? 30000) + 5000,
      lock_timeout: options?.lockTimeoutMs ?? 3000,
      idle_in_transaction_session_timeout: options?.idleTransactionTimeoutMs ?? 15000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });
  }

  async initialize(): Promise<void> {
    const result = await this.pool.query<{
      agent_state: string | null;
      command_inbox: string | null;
      tracking_contract: string | null;
    }>(`
      SELECT
        to_regclass('dorify_agent.agent_state')::TEXT AS agent_state,
        to_regclass('dorify_agent.command_inbox')::TEXT AS command_inbox,
        to_regprocedure('dorify_agent.refresh_tracking(timestamp with time zone)')::TEXT AS tracking_contract
    `);
    const storage = result.rows[0];
    if (!storage?.agent_state || !storage.command_inbox || !storage.tracking_contract) {
      throw new Error(
        'Dorify agent storage is missing; apply dori-api database migrations before starting the agent',
      );
    }
    // Replay metadata once after this protocol upgrade, including already acknowledged snapshots.
    await this.pool.query(`WITH activated AS (
      INSERT INTO dorify_agent.agent_state(state_key,state_value)
      VALUES ('tracking_language_v1','enabled') ON CONFLICT(state_key) DO NOTHING RETURNING state_key
    ) UPDATE dorify.dori_public_tracking_state SET cloud_synced_sequence=0
      WHERE registration_id IS NOT NULL AND expires_at>CURRENT_TIMESTAMP
        AND EXISTS(SELECT 1 FROM activated)`);
  }

  watchTrackingChanges(onChange: () => void): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.listenerWork) return this.listenerWork;
    if (this.listener) return Promise.resolve();
    this.listenerWork = this.openTrackingListener(onChange).finally(() => {
      this.listenerWork = null;
    });
    return this.listenerWork;
  }

  private async openTrackingListener(onChange: () => void): Promise<void> {
    const client = new pg.Client({
      connectionString: this.options?.listenUrl ?? this.databaseUrl,
      application_name: 'dorify-agent-listener',
      connectionTimeoutMillis: this.options?.connectionTimeoutMs ?? 5000,
      statement_timeout: 5000,
      query_timeout: 6000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });
    this.listener = client;
    client.on('notification', (message) => {
      if (!this.closing && message.channel === 'dorify_tracking_dirty') onChange();
    });
    client.on('end', () => {
      if (this.listener === client) this.listener = null;
    });
    client.on('error', () => {
      if (this.listener === client) this.listener = null;
      void client.end().catch(() => undefined);
    });
    try {
      await client.connect();
      if (!this.closing) await client.query('LISTEN dorify_tracking_dirty');
    } catch (error) {
      if (this.listener === client) this.listener = null;
      await client.end().catch(() => undefined);
      throw error;
    }
  }

  isTrackingListenerConnected(): boolean {
    return this.listener !== null && !this.closing;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.listenerWork?.catch(() => undefined);
    const listener = this.listener;
    this.listener = null;
    await listener?.end().catch(() => undefined);
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

  async getDeploymentControl(): Promise<DeploymentControlState | null> {
    const result = await this.pool.query<{ state_value: string }>(
      "SELECT state_value FROM dorify_agent.agent_state WHERE state_key = 'deployment_control'",
    );
    const value = result.rows[0]?.state_value;
    if (!value) return null;
    try {
      return JSON.parse(value) as DeploymentControlState;
    } catch {
      return {
        deploymentStatus: 'unknown',
        lastStatusCheckedAt: null,
        lastCloudSuccessAt: null,
        lastCloudError: 'Stored deployment status is invalid',
      };
    }
  }

  async saveDeploymentControl(state: DeploymentControlState): Promise<void> {
    await this.pool.query(
      `WITH saved AS (
         INSERT INTO dorify_agent.agent_state (state_key, state_value)
         VALUES ('deployment_control', $1)
         ON CONFLICT (state_key) DO UPDATE
         SET state_value = EXCLUDED.state_value, updated_at = CURRENT_TIMESTAMP
         WHERE agent_state.state_value IS DISTINCT FROM EXCLUDED.state_value
         RETURNING state_key
       )
       SELECT pg_notify('dorify_realtime', json_build_object('key', 'edge-local-status')::text)
       FROM saved`,
      [JSON.stringify(state)],
    );
  }

  async reserveCommand(command: CloudCommand): Promise<StoredCommand | null> {
    const inserted = await this.pool.query(
      `INSERT INTO dorify_agent.command_inbox (command_id, command_type, payload, status, lease_until)
       VALUES ($1, $2, $3, 'RUNNING', CURRENT_TIMESTAMP + INTERVAL '2 minutes')
       ON CONFLICT (command_id) DO UPDATE SET lease_until=CURRENT_TIMESTAMP + INTERVAL '2 minutes'
       WHERE command_inbox.status='RUNNING' AND command_inbox.lease_until<CURRENT_TIMESTAMP
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
       SET status = $2, result = $3, completed_at = CURRENT_TIMESTAMP, lease_until=NULL
       WHERE command_id = $1`,
      [result.commandId, result.status, result],
    );
  }

  async refreshTracking(): Promise<void> {
    await this.pool.query('SELECT dorify_agent.refresh_tracking()');
  }

  async listUnsyncedTracking(preferLive = false): Promise<TrackingProjection[]> {
    const result = await this.pool.query(`
      SELECT tracking_token_hash, registration_id, sequence, ticket_number,
             registration_status, position, estimated_wait_minutes, counter_name,
             queue_public_name, language_preference, observed_at, expires_at
      FROM dorify.dori_public_tracking_state
      WHERE registration_id IS NOT NULL AND sequence>cloud_synced_sequence
      ORDER BY ${preferLive ? "CASE WHEN registration_status IN ('waiting','in_progress') THEN 0 ELSE 1 END," : ''}
        updated_at,tracking_token_hash LIMIT 100
    `);
    return result.rows.map((row) => ({
      tokenHash: row.tracking_token_hash,
      registrationId: row.registration_id,
      sequence: Number(row.sequence),
      ticketNumber: row.ticket_number,
      registrationStatus: row.registration_status,
      position: row.position ?? undefined,
      estimatedWaitMinutes: row.estimated_wait_minutes ?? undefined,
      counterName: row.counter_name ?? undefined,
      queueName: row.queue_public_name,
      languagePreference: row.language_preference ?? undefined,
      observedAt: new Date(row.observed_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    }));
  }

  async markTrackingSynced(items: TrackingProjection[]): Promise<void> {
    if (!items.length) return;
    await this.pool.query(
      `UPDATE dorify.dori_public_tracking_state state
       SET cloud_synced_sequence=ack.sequence
       FROM jsonb_to_recordset($1::jsonb) AS ack(token_hash text,sequence bigint)
       WHERE state.tracking_token_hash=ack.token_hash AND state.sequence=ack.sequence
         AND state.cloud_synced_sequence<ack.sequence`,
      [
        JSON.stringify(
          items.map((item) => ({ token_hash: item.tokenHash, sequence: item.sequence })),
        ),
      ],
    );
  }

  async getSyncMetrics() {
    const result = await this.pool.query(`SELECT
      COUNT(*)::int AS pending,
      COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-MIN(updated_at)))*1000,0)::float8 AS oldest
      FROM dorify.dori_public_tracking_state WHERE sequence>cloud_synced_sequence`);
    const running = await this.pool.query(
      "SELECT COUNT(*)::int AS count FROM dorify_agent.command_inbox WHERE status='RUNNING'",
    );
    return {
      pendingTracking: Number(result.rows[0]?.pending ?? 0),
      oldestPendingAgeMs: Number(result.rows[0]?.oldest ?? 0),
      runningCommands: Number(running.rows[0]?.count ?? 0),
      poolWaiting: this.pool.waitingCount,
    };
  }

  async listPendingNotifications(): Promise<RelayNotification[]> {
    const result = await this.pool.query(`
      SELECT notification_id, registration_id, channel, notification_type, locale,
             recipient, notification_content, created_at
      FROM dorify.dori_notification
      WHERE dispatch_route='cloud_relay' AND notification_status='pending'
      ORDER BY created_at LIMIT 50`);
    return result.rows.map((row) => ({
      notificationId: row.notification_id,
      registrationId: row.registration_id,
      channel: row.channel,
      notificationType: row.notification_type,
      locale: row.locale,
      recipient: row.recipient,
      content: row.notification_content,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async markNotificationRelayed(notificationId: string): Promise<void> {
    await this.pool.query(
      `UPDATE dorify.dori_notification
      SET notification_status='sent', provider='dorify-cloud', sent_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP WHERE notification_id=$1 AND notification_status='pending'`,
      [notificationId],
    );
  }

  async skipPendingNotifications(reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE dorify.dori_notification
      SET notification_status='skipped_offline', dispatch_route='disabled_offline',
          failure_reason=$1, updated_at=CURRENT_TIMESTAMP
      WHERE dispatch_route='cloud_relay' AND notification_status='pending'`,
      [reason],
    );
  }
}
