import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('cloud edge OpenAPI contract', () => {
  it('parses and deliberately excludes local business configuration endpoints', () => {
    const source = readFileSync(resolve('contracts/cloud-edge.openapi.yaml'), 'utf8');
    const contract = parse(source) as { openapi: string; paths: Record<string, unknown> };
    expect(contract.openapi).toBe('3.0.3');
    expect(Object.keys(contract.paths)).toEqual([
      '/api/edge/v1/heartbeat',
      '/api/edge/v1/commands',
      '/api/edge/v1/commands/{commandId}/ack',
      '/api/edge/v1/commands/{commandId}/result',
    ]);
  });
});
