# Dorify Agent

Dorify Agent connects an autonomous intra installation to the Dorify Cloud control plane. It is
strictly an outbound supervision channel: the local Dorify App and Engine keep working when the
cloud, DNS or internet connection is unavailable.

## Product boundary

For intra installations, the following data remains locally administered and is never changed by
this agent: sites, queues, services, priorities, opening schedules, counters, appointment rules,
notification templates, translations, branding, users, roles and assignments.

Cloud-native customers run the complete Dorify App and Engine in the cloud. That deployment is
separate from this edge agent; the cloud control plane only adds installation inventory,
supervision, audit and allow-listed operational commands.

## Current capabilities

- outbound heartbeat with App, Engine and Agent versions;
- local Engine health observation;
- durable PostgreSQL command inbox;
- idempotent command results;
- strict command allow-list: `RUN_HEALTH_CHECK`, `SYNC_NOW`;
- retry with exponential backoff when the cloud is offline;
- `/healthz` remains healthy during cloud outages;
- optional mTLS client certificate support.

The cloud endpoints are specified in `contracts/cloud-edge.openapi.yaml`. No cloud implementation
is assumed or hidden in this repository.

## Local checks

```bash
npm install
npm run check
```

## Docker

The Dorify Engine stack must be running first because it creates `dorify-network` and provides
PostgreSQL.

```bash
docker compose build
docker compose up -d
```

The default Compose configuration keeps the agent disabled. To connect it later, create an
uncommitted `.env` with a real installation identity and set `AGENT_ENABLED=true`.

## Health semantics

- `GET /healthz`: the process is alive; cloud connectivity is reported but never required.
- `GET /readyz`: the local persistent store is reachable.

This distinction prevents a cloud outage from restarting or disabling a working intra installation.
