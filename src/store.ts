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
  close(): Promise<void>;
  ping(): Promise<void>;
  getCursor(): Promise<string | null>;
  setCursor(cursor: string): Promise<void>;
  getDeploymentControl(): Promise<DeploymentControlState | null>;
  saveDeploymentControl(state: DeploymentControlState): Promise<void>;
  reserveCommand(command: CloudCommand): Promise<StoredCommand | null>;
  completeCommand(result: CommandResult): Promise<void>;
  refreshTracking(): Promise<void>;
  listUnsyncedTracking(): Promise<TrackingProjection[]>;
  markTrackingSynced(items: TrackingProjection[]): Promise<void>;
  listPendingNotifications(): Promise<RelayNotification[]>;
  markNotificationRelayed(notificationId: string): Promise<void>;
  skipPendingNotifications(reason: string): Promise<void>;
}

export class PostgresAgentStore implements AgentStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });
  }

  async initialize(): Promise<void> {
    const result = await this.pool.query<{
      agent_state: string | null;
      command_inbox: string | null;
    }>(`
      SELECT
        to_regclass('dorify_agent.agent_state')::TEXT AS agent_state,
        to_regclass('dorify_agent.command_inbox')::TEXT AS command_inbox
    `);
    const storage = result.rows[0];
    if (!storage?.agent_state || !storage.command_inbox) {
      throw new Error(
        'Dorify agent storage is missing; apply dori-api database migrations before starting the agent',
      );
    }
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
      `INSERT INTO dorify_agent.agent_state (state_key, state_value)
       VALUES ('deployment_control', $1)
       ON CONFLICT (state_key) DO UPDATE
       SET state_value = EXCLUDED.state_value, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify(state)],
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

  async refreshTracking(): Promise<void> {
    await this.pool.query(`
      WITH ranked AS (
        SELECT r.registration_id, r.registration_tracking_token,
               r.registration_tracking_token_valid_until, r.ticket_number, r.status,
               q.queue_name,
               CASE WHEN r.status='waiting' THEN
                 ROW_NUMBER() OVER (PARTITION BY r.queue_id, r.business_date
                   ORDER BY r.priority_reference_time, r.created_at, r.registration_id)::int
                 WHEN r.status='in_progress' THEN 0 ELSE NULL END AS position,
               os.counter_name
        FROM dorify.dori_registration r
        JOIN dorify.dori_queue q ON q.queue_id=r.queue_id
        LEFT JOIN dorify.dori_operator_session os ON os.session_id=r.served_by_session_id
        WHERE r.is_active=TRUE AND r.registration_tracking_token_valid_until>CURRENT_TIMESTAMP
      ), incoming AS (
        SELECT encode(sha256(convert_to(registration_tracking_token::text,'UTF8')),'hex') AS token_hash,
               registration_id, ticket_number, status, position, counter_name, queue_name,
               registration_tracking_token_valid_until AS expires_at
        FROM ranked
      )
      INSERT INTO dorify.dori_public_tracking_state
       (tracking_token_hash, registration_id, sequence, cloud_synced_sequence,
        ticket_number, registration_status, position, estimated_wait_minutes,
        counter_name, queue_public_name, observed_at, expires_at, updated_at)
      SELECT token_hash, registration_id, 1, 0, ticket_number, status, position, NULL,
             counter_name, queue_name, CURRENT_TIMESTAMP, expires_at, CURRENT_TIMESTAMP
      FROM incoming
      ON CONFLICT (tracking_token_hash) DO UPDATE SET
        sequence=dorify.dori_public_tracking_state.sequence + 1,
        ticket_number=EXCLUDED.ticket_number,
        registration_status=EXCLUDED.registration_status,
        position=EXCLUDED.position,
        counter_name=EXCLUDED.counter_name,
        queue_public_name=EXCLUDED.queue_public_name,
        observed_at=CURRENT_TIMESTAMP,
        expires_at=EXCLUDED.expires_at,
        updated_at=CURRENT_TIMESTAMP
      WHERE (dorify.dori_public_tracking_state.ticket_number,
             dorify.dori_public_tracking_state.registration_status,
             dorify.dori_public_tracking_state.position,
             dorify.dori_public_tracking_state.counter_name,
             dorify.dori_public_tracking_state.queue_public_name,
             dorify.dori_public_tracking_state.expires_at)
        IS DISTINCT FROM
            (EXCLUDED.ticket_number, EXCLUDED.registration_status, EXCLUDED.position,
             EXCLUDED.counter_name, EXCLUDED.queue_public_name, EXCLUDED.expires_at)
    `);
  }

  async listUnsyncedTracking(): Promise<TrackingProjection[]> {
    const result = await this.pool.query(`
      SELECT tracking_token_hash, registration_id, sequence, ticket_number,
             registration_status, position, estimated_wait_minutes, counter_name,
             queue_public_name, observed_at, expires_at
      FROM dorify.dori_public_tracking_state
      WHERE registration_id IS NOT NULL AND sequence>cloud_synced_sequence
      ORDER BY updated_at LIMIT 100
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
      observedAt: new Date(row.observed_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    }));
  }

  async markTrackingSynced(items: TrackingProjection[]): Promise<void> {
    for (const item of items)
      await this.pool.query(
        `UPDATE dorify.dori_public_tracking_state SET cloud_synced_sequence=$2
       WHERE tracking_token_hash=$1 AND sequence=$2`,
        [item.tokenHash, item.sequence],
      );
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
