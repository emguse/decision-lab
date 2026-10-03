import { it, expect } from 'vitest';
import { createApp } from '../server/app';
import { Store } from '../server/store';
import { initialQuery, validateResponse } from '../shared/schema';
import { fixture } from './fixture';
it('saves drafts and immutable runs; rejects invalid input and foreign origins', async () => {
  const store = new Store(':memory:');
  const app = createApp(
    store,
    { evaluate: async () => validateResponse(fixture, initialQuery) },
    true,
  );
  const post = (path: string, body: unknown, origin?: string) =>
    app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    });
  const run = await post('/api/runs', { title: 'Test', query: initialQuery });
  expect(run.status).toBe(201);
  expect((await run.json()).query).toEqual(initialQuery);
  expect((await (await app.request('/api/runs')).json()).length).toBe(1);
  expect(
    (await post('/api/experiments', { title: 'Draft', query: initialQuery }))
      .status,
  ).toBe(201);
  expect(store.listExperiments()).toHaveLength(1);
  expect((await post('/api/runs', { title: '', query: {} })).status).toBe(400);
  expect(
    (
      await post(
        '/api/runs',
        { title: 'Test', query: initialQuery },
        'https://evil.example',
      )
    ).status,
  ).toBe(403);
  store.close();
});
it('prevents overlapping paid requests', async () => {
  const store = new Store(':memory:');
  let finish!: () => void;
  const app = createApp(
    store,
    {
      evaluate: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return validateResponse(fixture, initialQuery);
      },
    },
    true,
  );
  const send = () =>
    app.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test', query: initialQuery }),
    });
  const first = send();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await send()).status).toBe(409);
  finish();
  expect((await first).status).toBe(201);
  store.close();
});
