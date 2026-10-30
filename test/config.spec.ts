import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const databaseUrl = 'postgresql://dori:password@postgres:5432/dori';

describe('loadConfig', () => {
  it('allows the agent to remain disabled without cloud credentials', () => {
    const config = loadConfig({ DATABASE_URL: databaseUrl, AGENT_ENABLED: 'false' });
    expect(config.enabled).toBe(false);
    expect(config.cloudUrl).toBeUndefined();
  });

  it('requires an installation-specific identity when enabled', () => {
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, AGENT_ENABLED: 'true' })).toThrow();
  });

  it('accepts a complete outbound cloud configuration', () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      AGENT_ENABLED: 'true',
      DORIFY_CLOUD_URL: 'https://cloud.dorify.app/',
      DORIFY_INSTALLATION_ID: '00000000-0000-4000-8000-000000000001',
      DORIFY_CLOUD_TOKEN: 'installation-specific-token-with-32-chars',
    });
    expect(config.cloudUrl).toBe('https://cloud.dorify.app');
  });
});
