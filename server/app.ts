import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { requestSchema } from '../shared/schema.js';
import { ProviderError, type DecisionProvider } from './provider.js';
import type { Store } from './store.js';
export function createApp(
  store: Store,
  provider: DecisionProvider,
  configured: boolean,
) {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const host = c.req.header('host');
    if (host && !/^(127\.0\.0\.1|localhost):(5173|8787)$/.test(host))
      return c.json({ error: '許可されていないホストです。' }, 403);
    const origin = c.req.header('origin');
    if (
      origin &&
      !/^http:\/\/(127\.0\.0\.1|localhost):(5173|8787)$/.test(origin)
    )
      return c.json({ error: '許可されていない接続元です。' }, 403);
    await next();
  });
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: '入力は1MB以下にしてください。' }, 413),
    }),
  );
  app.onError((error, c) => {
    if (error instanceof ProviderError)
      return c.json(
        { error: error.message, code: error.code },
        error.status as 429 | 502 | 503 | 504,
      );
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: '入力形式を確認してください。' }, 400);
    return c.json({ error: '保存またはサーバー処理に失敗しました。' }, 500);
  });
  app.get('/api/config', (c) => c.json({ configured, provider: 'jev' }));
  app.get('/api/runs', (c) => c.json(store.listRuns()));
  app.get('/api/experiments', (c) => c.json(store.listExperiments()));
  const input = z.object({
    title: z.string().trim().min(1).max(120),
    query: requestSchema,
  });
  app.post('/api/experiments', async (c) => {
    const v = input.parse(await c.req.json());
    return c.json(store.saveExperiment(v.title, v.query), 201);
  });
  let running = false;
  app.post('/api/runs', async (c) => {
    const v = input.parse(await c.req.json());
    if (running)
      return c.json(
        { error: '実行中のクエリが完了するまでお待ちください。' },
        409,
      );
    running = true;
    try {
      const start = performance.now();
      const response = await provider.evaluate(v.query);
      const run = store.saveRun({
        ...v,
        response,
        elapsedMs: Math.round(performance.now() - start),
        createdAt: new Date().toISOString(),
      });
      return c.json(run, 201);
    } finally {
      running = false;
    }
  });
  return app;
}
