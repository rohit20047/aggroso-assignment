import { buildApp } from './app.js';
import { AgentPlanner } from './agent.js';
import { GeminiClient } from './gemini.js';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MigrationStore } from './store.js';
import { PostgresStore } from './postgres-store.js';

const databasePath = process.env.DATABASE_PATH ?? './migration-workbench.db';
const port = Number(process.env.PORT ?? 3000);

if (process.env.RENDER && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required on Render; configure a persistent Neon PostgreSQL database');
}
const store = process.env.DATABASE_URL
  ? await PostgresStore.open(process.env.DATABASE_URL)
  : new MigrationStore(databasePath);
const agent = process.env.GEMINI_API_KEY
  ? new AgentPlanner(store, new GeminiClient(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite'))
  : undefined;
const app = buildApp(store, agent);
const webRoot = resolve('dist-web');
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
}

try {
  await app.listen({ host: process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1', port });
} catch (error) {
  app.log.error(error);
  await store.close();
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().finally(() => store.close());
  });
}
