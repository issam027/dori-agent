import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { AgentConfig } from './config.js';
import {
  commandPageSchema,
  installationStatusSchema,
  type CommandPage,
  type CommandResult,
  type Heartbeat,
  type InstallationStatus,
  type RelayNotification,
  type TrackingProjection,
} from './types.js';

export interface CloudClient {
  getInstallationStatus(): Promise<InstallationStatus>;
  sendHeartbeat(heartbeat: Heartbeat): Promise<void>;
  getCommands(cursor: string | null): Promise<CommandPage>;
  acknowledgeCommand(commandId: string): Promise<void>;
  sendCommandResult(result: CommandResult): Promise<void>;
  relayNotification(notification: RelayNotification): Promise<void>;
  syncTracking(items: TrackingProjection[]): Promise<void>;
}

export class HttpCloudClient implements CloudClient {
  constructor(
    private readonly config: Required<
      Pick<AgentConfig, 'cloudUrl' | 'cloudToken' | 'installationId' | 'requestTimeoutMs'>
    > &
      Pick<AgentConfig, 'tls'>,
  ) {}

  async getInstallationStatus(): Promise<InstallationStatus> {
    const value = await this.request('/api/edge/v1/status', 'GET');
    return installationStatusSchema.parse(value);
  }

  async sendHeartbeat(heartbeat: Heartbeat): Promise<void> {
    await this.request('/api/edge/v1/heartbeat', 'POST', heartbeat);
  }

  async getCommands(cursor: string | null): Promise<CommandPage> {
    const query = cursor ? `?after=${encodeURIComponent(cursor)}` : '';
    const value = await this.request(`/api/edge/v1/commands${query}`, 'GET');
    return commandPageSchema.parse(value);
  }

  async acknowledgeCommand(commandId: string): Promise<void> {
    await this.request(`/api/edge/v1/commands/${commandId}/ack`, 'POST', {});
  }

  async sendCommandResult(result: CommandResult): Promise<void> {
    await this.request(`/api/edge/v1/commands/${result.commandId}/result`, 'POST', result);
  }

  async relayNotification(notification: RelayNotification): Promise<void> {
    await this.request('/api/edge/v1/notifications', 'POST', notification);
  }

  async syncTracking(items: TrackingProjection[]): Promise<void> {
    await this.request('/api/edge/v1/tracking', 'POST', { items });
  }

  private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    const url = new URL(path, this.config.cloudUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      timeout: this.config.requestTimeoutMs,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.config.cloudToken}`,
        'X-Dorify-Installation-Id': this.config.installationId,
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}),
      },
      cert: this.config.tls?.cert,
      key: this.config.tls?.key,
      ca: this.config.tls?.ca,
      rejectUnauthorized: true,
    };

    return await new Promise((resolve, reject) => {
      const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = requestFn(options, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            reject(new Error(`Cloud returned HTTP ${status}`));
            return;
          }
          if (!text) {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(text) as unknown);
          } catch {
            reject(new Error('Cloud returned invalid JSON'));
          }
        });
      });
      request.on('timeout', () => request.destroy(new Error('Cloud request timed out')));
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }
}
