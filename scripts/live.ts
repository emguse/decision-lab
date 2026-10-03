import 'dotenv/config';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { JevProvider } from '../server/provider.js';
import { initialQuery } from '../shared/schema.js';
if (!process.env.TYPESAFE_API_KEY) {
  console.error('Set TYPESAFE_API_KEY in .env before running this paid test.');
  process.exit(1);
}
const store = new Store(process.env.DATABASE_PATH || 'data/jev.sqlite');
try {
  const app = createApp(
    store,
    new JevProvider(process.env.TYPESAFE_API_KEY),
    true,
  );
  const res = await app.request('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Live API smoke test', query: initialQuery }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(data.error);
    process.exitCode = 1;
  } else
    console.log(
      JSON.stringify({
        id: data.id,
        model: data.response.model,
        usage: data.response.usage,
        elapsedMs: data.elapsedMs,
      }),
    );
} finally {
  store.close();
}
