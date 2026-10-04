import 'dotenv/config';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
import { JevProvider } from './provider.js';
import { LocalDecisionProvider } from './local-provider.js';
import { Store } from './store.js';
const store = await Store.open(process.env.DATABASE_PATH || 'data/jev.sqlite');
const app = createApp(
  store,
  new JevProvider(process.env.TYPESAFE_API_KEY),
  Boolean(process.env.TYPESAFE_API_KEY),
  new LocalDecisionProvider(
    process.env.LOCAL_DECISION_BASE_URL,
    process.env.LOCAL_DECISION_MODEL,
    fetch,
    Number(process.env.LOCAL_DECISION_TIMEOUT_MS ?? 60000),
  ),
);
app.use('/*', serveStatic({ root: './dist' }));
const server = serve(
  { fetch: app.fetch, hostname: '127.0.0.1', port: 8787 },
  () => console.log('Jev Lab: http://127.0.0.1:8787'),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
