import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
const database = vi.hoisted(() => ({
  createClient: vi.fn(),
  endPool: vi.fn(async () => undefined),
}));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      end = database.endPool;
    },
    Client: class {
      constructor() {
        return database.createClient();
      }
    },
  },
}));
import { PostgresAgentStore } from '../src/store.js';
it('reconnects the tracking listener after a graceful database disconnect', async () => {
  const clients: EventEmitter[] = [];
  database.createClient.mockImplementation(() => {
    const client = Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => undefined),
      query: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
    });
    clients.push(client);
    return client;
  });
  const store = new PostgresAgentStore('postgresql://unused');
  const onChange = vi.fn();
  await store.watchTrackingChanges(onChange);
  clients[0]?.emit('end');
  await store.watchTrackingChanges(onChange);
  expect(database.createClient).toHaveBeenCalledTimes(2);
  clients[1]?.emit('notification', { channel: 'dorify_tracking_dirty' });
  expect(onChange).toHaveBeenCalledOnce();
  await store.close();
});
