import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
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
beforeEach(() => vi.clearAllMocks());
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

it('shares a concurrent listener connection and closes an opening connection without subscribing', async () => {
  let connected!: () => void;
  const client = Object.assign(new EventEmitter(), {
    connect: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          connected = resolve;
        }),
    ),
    query: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
  });
  database.createClient.mockReturnValue(client);
  const store = new PostgresAgentStore('postgresql://unused');
  const first = store.watchTrackingChanges(vi.fn());
  const second = store.watchTrackingChanges(vi.fn());
  expect(database.createClient).toHaveBeenCalledOnce();
  const closing = store.close();
  connected();
  await Promise.all([first, second, closing]);
  expect(client.query).not.toHaveBeenCalled();
  expect(client.end).toHaveBeenCalledOnce();
  expect(database.endPool).toHaveBeenCalledOnce();
  await store.watchTrackingChanges(vi.fn());
  expect(database.createClient).toHaveBeenCalledOnce();
});
