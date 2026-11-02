import { afterEach, expect, it, vi } from 'vitest';
import { HttpEngineClient } from '../src/engine-client.js';
afterEach(() => vi.unstubAllGlobals());
it.each(['http://engine:3000', 'http://engine:3000/', 'http://engine:3000///'])(
  'probes the same health endpoint for %s',
  async (engineUrl) => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'ok' }) }));
    vi.stubGlobal('fetch', fetch);
    const client = new HttpEngineClient({ engineUrl, requestTimeoutMs: 1000 });
    await expect(client.health()).resolves.toMatchObject({ status: 'ok' });
    expect(fetch).toHaveBeenCalledWith(
      'http://engine:3000/api/v1/monitoring/health',
      expect.any(Object),
    );
  },
);
