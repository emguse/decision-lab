import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { requestSchema } from '../shared/schema.js';
import { ProviderError, type DecisionProvider } from './provider.js';
import { SCHEMA_VERSION, StoreError, type Store } from './store.js';
import { providerIdSchema } from '../shared/providers.js';
import type { LocalDecisionProvider } from './local-provider.js';
import { draftSchema } from '../shared/evaluation.js';
export function createApp(
  store: Store,
  provider: DecisionProvider,
  configured: boolean,
  local?: LocalDecisionProvider,
) {
  const providers = { jev: provider, 'strands-local': local };
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
    if (error instanceof StoreError)
      return c.json(
        { error: error.message },
        error.status as 400 | 403 | 404 | 409,
      );
    if (error instanceof ProviderError)
      return c.json(
        { error: error.message, code: error.code },
        error.status as 422 | 429 | 502 | 503 | 504,
      );
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: '入力形式を確認してください。' }, 400);
    return c.json({ error: '保存またはサーバー処理に失敗しました。' }, 500);
  });
  app.get('/api/config', (c) =>
    c.json({
      configured,
      provider: 'jev',
      providers: {
        jev: { configured, model: 'jev-latest' },
        'strands-local': {
          configured: local?.configured ?? false,
          model: local?.model ?? 'StrandsAgents/strands-decider-2B-hobson-v19',
        },
      },
      schemaVersion: SCHEMA_VERSION,
      recordFormatVersion: 1,
    }),
  );
  app.get('/api/providers/strands-local/health', async (c) =>
    c.json(local ? await local.health() : { status: 'unconfigured' }),
  );
  const actor = (c: { req: { header(name: string): string | undefined } }) =>
    store.actor(c.req.header('X-Local-User'));
  app.get('/api/local-users', (c) =>
    c.json({ users: store.listUsers(), defaultUserId: store.actor() }),
  );
  app.post('/api/local-users', async (c) => {
    const v = z
      .object({ name: z.string().trim().min(1).max(80) })
      .parse(await c.req.json());
    return c.json(store.addUser(v.name), 201);
  });
  app.get('/api/runs', (c) => c.json(store.listRuns(actor(c))));
  app.get('/api/runs/summaries', (c) => c.json(store.listSummaries(actor(c))));
  app.get('/api/runs/:id/labeling', (c) =>
    c.json(store.labeling(c.req.param('id'), actor(c))),
  );
  app.put('/api/runs/:id/labels', async (c) =>
    c.json(
      store.saveDraft(
        c.req.param('id'),
        actor(c),
        draftSchema.parse(await c.req.json()),
      ),
    ),
  );
  app.post('/api/runs/:id/finalize', async (c) =>
    c.json(
      store.finalize(
        c.req.param('id'),
        actor(c),
        draftSchema.parse(await c.req.json()),
      ),
    ),
  );
  app.post('/api/runs/:id/reveal', (c) =>
    c.json(store.reveal(c.req.param('id'), actor(c))),
  );
  app.get('/api/runs/:id/evaluation', (c) =>
    c.json(store.evaluation(c.req.param('id'), actor(c))),
  );
  app.post('/api/runs/:id/assignments', async (c) => {
    actor(c);
    const v = z.object({ userId: z.string() }).parse(await c.req.json());
    store.assign(c.req.param('id'), v.userId);
    return c.json(store.assignments(c.req.param('id')));
  });
  app.get('/api/runs/:id/comparison', (c) =>
    c.json(store.comparison(c.req.param('id'), actor(c))),
  );
  app.post('/api/runs/:id/adopt', async (c) => {
    const v = draftSchema
      .extend({ sourceRevisionIds: z.array(z.string()) })
      .parse(await c.req.json());
    return c.json(
      store.adopt(c.req.param('id'), actor(c), v, v.sourceRevisionIds),
      201,
    );
  });
  app.get('/api/experiments', (c) => c.json(store.listExperiments()));
  const input = z.object({
    title: z.string().trim().min(1).max(120),
    query: requestSchema,
    blind: z.boolean().optional(),
    provider: providerIdSchema.default('jev'),
  });
  app.post('/api/experiments', async (c) => {
    const v = input.parse(await c.req.json());
    return c.json(
      store.saveExperiment(v.title, v.query, actor(c), v.provider),
      201,
    );
  });
  let running = false;
  app.post('/api/runs', async (c) => {
    const userId = actor(c);
    const v = input.parse(await c.req.json());
    const selected = providers[v.provider];
    if (!selected)
      throw new ProviderError(
        503,
        'local_not_configured',
        'ローカルPythonサーバーの接続先を設定してください。',
      );
    if (running)
      return c.json(
        { error: '実行中のクエリが完了するまでお待ちください。' },
        409,
      );
    running = true;
    try {
      const start = performance.now();
      const output = await selected.evaluate(v.query);
      const { rawResponse, executionInfo, ...response } = output;
      const run = store.saveRun(
        {
          title: v.title,
          query: v.query,
          response,
          elapsedMs: Math.round(performance.now() - start),
          createdAt: new Date().toISOString(),
        },
        userId,
        v.blind ?? false,
        {
          formatVersion: 1,
          provider: v.provider,
          requestedModel: v.query.model,
          resolvedModel: response.model,
          artifactRevision: null,
          ...(v.provider === 'strands-local' ? executionInfo : {}),
        },
        rawResponse,
      );
      return c.json(
        v.blind
          ? store.labeling(run.id, userId)
          : { ...run, executedByUserId: userId },
        201,
      );
    } finally {
      running = false;
    }
  });
  return app;
}
