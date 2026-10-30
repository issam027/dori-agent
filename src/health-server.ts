import { createServer, type Server } from 'node:http';
import type { DorifyAgent } from './agent.js';
import type { AgentStore } from './store.js';

export function createHealthServer(port: number, agent: DorifyAgent, store: AgentStore): Server {
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET' || !['/healthz', '/readyz'].includes(request.url ?? '')) {
      response.writeHead(404).end(JSON.stringify({ status: 'not_found' }));
      return;
    }

    if (request.url === '/healthz') {
      response.writeHead(200).end(JSON.stringify({ status: 'ok', agent: agent.getStatus() }));
      return;
    }

    try {
      await store.ping();
      response.writeHead(200).end(JSON.stringify({ status: 'ready' }));
    } catch {
      response.writeHead(503).end(JSON.stringify({ status: 'not_ready' }));
    }
  }).listen(port, '0.0.0.0');
}
