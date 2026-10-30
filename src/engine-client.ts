import type { AgentConfig } from './config.js';
import type { EngineHealth } from './types.js';

export interface EngineClient {
  health(): Promise<EngineHealth>;
}

export class HttpEngineClient implements EngineClient {
  constructor(private readonly config: Pick<AgentConfig, 'engineUrl' | 'requestTimeoutMs'>) {}

  async health(): Promise<EngineHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await fetch(`${this.config.engineUrl}/api/v1/monitoring/health`, {
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        return { status: 'degraded', checkedAt, details: { httpStatus: response.status } };
      }
      const details = (await response.json()) as Record<string, unknown>;
      return { status: details.status === 'ok' ? 'ok' : 'degraded', checkedAt, details };
    } catch {
      return { status: 'unreachable', checkedAt };
    }
  }
}
