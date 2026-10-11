import { createHash } from 'node:crypto';
import {
  ExchangeService,
  importSchema,
  gradingSelectionSchema,
  type ExecuteQuery,
} from './exchange.js';
import { exchangeFormatSchema, serializeDocument } from '../shared/exchange.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { requestSchema } from '../shared/schema.js';
import {
  ProviderError,
  type DecisionProvider,
  type ConfiguredDecisionProvider,
} from './provider.js';
import { SCHEMA_VERSION, StoreError, type Store } from './store.js';
import { providerIdSchema } from '../shared/providers.js';
import { draftSchema } from '../shared/evaluation.js';
export function createApp(
  store: Store,
  provider: DecisionProvider,
  configured: boolean,
  connections: ConfiguredDecisionProvider[] = [],
) {
  const providers = new Map<string, DecisionProvider | undefined>([
    ['jev', provider],
  ]);
  for (const connection of connections)
    providers.set(connection.connection.id, connection);
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const host = c.req.header('host');
    if (host && !/^(127\.0\.0\.1|localhost):(5173|8787)$/.test(host))
      return c.json({ error: 'Host is not allowed.' }, 403);
    const origin = c.req.header('origin');
    if (
      origin &&
      !/^http:\/\/(127\.0\.0\.1|localhost):(5173|8787)$/.test(origin)
    )
      return c.json({ error: 'Origin is not allowed.' }, 403);
    await next();
  });
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: 'Input must be 1 MiB or smaller.' }, 413),
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
      return c.json({ error: 'Check the input format.' }, 400);
    return c.json({ error: 'Server processing or persistence failed.' }, 500);
  });
  app.get('/api/config', (c) =>
    c.json({
      configured,
      provider: 'jev',
      providers: {
        jev: {
          configured,
          model: 'jev-latest',
          label: 'Jev API',
          modelEditable: true,
          healthCheck: false,
          questionInteraction: 'independent',
        },
        ...Object.fromEntries(
          connections.map((p) => [p.connection.id, p.config]),
        ),
      },
      schemaVersion: SCHEMA_VERSION,
      recordFormatVersion: 1,
    }),
  );
  app.get('/api/providers/:id/health', async (c) => {
    const id = c.req.param('id');
    const selected = connections.find((p) => p.connection.id === id);
    if (!selected)
      return c.json({ error: 'Connection is not registered.' }, 404);
    return c.json(await selected.health());
  });
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
  const exchange = new ExchangeService(store);
  let running = false;
  function context(providerId: string, model: string) {
    const selected = providers.get(providerId);
    const connection = connections.find(
      (p) => p.connection.id === providerId,
    )?.connection;
    if (
      !selected ||
      (providerId === 'jev' && !configured) ||
      (connection &&
        !connections.find((p) => p.connection.id === providerId)?.config
          .configured)
    )
      throw new ProviderError(
        503,
        'not_configured',
        'Connection is not configured or has been removed. Select a connection explicitly.',
      );
    if (
      connection &&
      connections.find((p) => p.connection.id === providerId)?.config
        .modelEditable === false &&
      model !== connection.model
    )
      throw new ProviderError(
        422,
        'model_mismatch',
        'Use the configured model ID.',
      );
    return {
      fingerprint: createHash('sha256')
        .update(
          JSON.stringify(
            connection ?? {
              provider: providerId,
              model,
            },
          ),
        )
        .digest('hex'),
      metadata: connection
        ? {
            formatVersion: 2 as const,
            provider: providerId,
            label: connection.label,
            adapter: connection.adapter,
            questionInteraction: connection.question_interaction,
            requestedModel: model,
            artifactRevision: null,
          }
        : {
            formatVersion: 1 as const,
            provider: 'jev' as const,
            requestedModel: model,
            artifactRevision: null,
          },
    };
  }
  const execute: ExecuteQuery = async (
    query,
    title,
    providerId,
    userId,
    blind,
    link,
  ) => {
    context(providerId, query.model);
    const selected = providers.get(providerId)!;
    const connection = connections.find(
      (p) => p.connection.id === providerId,
    )?.connection;
    const start = performance.now();
    const output = await selected.evaluate(query);
    const { rawResponse, executionInfo, ...response } = output;
    const run = store.saveRun(
      {
        title,
        query,
        response,
        elapsedMs: Math.round(performance.now() - start),
        createdAt: new Date().toISOString(),
      },
      userId,
      blind,
      {
        ...(connection
          ? {
              formatVersion: 2 as const,
              label: connection.label,
              adapter: connection.adapter,
              questionInteraction: connection.question_interaction,
              provider: providerId,
            }
          : {
              formatVersion: 1 as const,
              provider: 'jev' as const,
            }),
        requestedModel: query.model,
        resolvedModel: response.model,
        artifactRevision: null,
        ...executionInfo,
      },
      rawResponse,
      link,
    );
    return run;
  };
  app.post('/api/runs', async (c) => {
    const userId = actor(c);
    const v = input.parse(await c.req.json());
    context(v.provider, v.query.model);
    if (running)
      return c.json({ error: 'Wait for the current request to finish.' }, 409);
    running = true;
    try {
      const run = await execute(
        v.query,
        v.title,
        v.provider,
        userId,
        v.blind ?? false,
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
  app.get('/api/exchange/documents', (c) => {
    actor(c);
    return c.json(store.listDocuments());
  });
  app.post('/api/exchange/preview', async (c) => {
    actor(c);
    const documents = exchange.parseImport(
      importSchema.parse(await c.req.json()),
    );
    return c.json(
      documents.map((d) => ({
        kind: d.kind,
        name: d.name,
        version: d.version,
        ...(d.kind === 'experiment-suite'
          ? {
              caseCount: d.cases.length,
              expectedCount: d.cases.filter(
                (c) => c.expected && Object.keys(c.expected).length,
              ).length,
              definition: d.definition,
            }
          : { questionCount: Object.keys(d.questions).length }),
      })),
    );
  });
  app.post('/api/exchange/import', async (c) =>
    c.json(
      exchange.import(importSchema.parse(await c.req.json()), actor(c)),
      201,
    ),
  );
  app.post('/api/exchange/documents/:id/export', async (c) => {
    const v = z
      .object({ format: exchangeFormatSchema })
      .strict()
      .parse(await c.req.json());
    return c.json(exchange.exportInput(c.req.param('id'), actor(c), v.format));
  });
  app.get('/api/suites/:id', (c) => {
    const userId = actor(c),
      suite = exchange.suite(c.req.param('id'));
    return c.json({
      ...suite,
      cases: suite.cases.map(
        ({ expected: _expected, note: _note, ...item }) => item,
      ),
      expectedSeenAt: store.expectedSeenAt(c.req.param('id'), userId),
      executions: store
        .listSuiteExecutions(c.req.param('id'))
        .map((e) => exchange.progress(e, userId)),
    });
  });
  const suiteRunInput = z
    .object({ provider: providerIdSchema, model: requestSchema.shape.model })
    .strict();
  function launch(id: string) {
    // Persistence and error handling live in the worker; requests return immediately.
    void exchange
      .run(id, execute)
      .catch(() => {
        /* Recover persisted running state on the next startup. */
      })
      .finally(() => {
        running = false;
      });
  }
  app.post('/api/suites/:id/execute', async (c) => {
    const userId = actor(c),
      v = suiteRunInput.parse(await c.req.json());
    const selected = context(v.provider, v.model);
    if (running) throw new StoreError(409, 'Another inference is running.');
    const e = exchange.create(
      c.req.param('id'),
      v.provider,
      v.model,
      userId,
      selected,
    );
    running = true;
    const progress = exchange.progress(e, userId);
    launch(e.id);
    return c.json(progress, 202);
  });
  app.get('/api/suite-executions/:id', (c) =>
    c.json(
      exchange.progress(store.getSuiteExecution(c.req.param('id')), actor(c)),
    ),
  );
  app.post('/api/suite-executions/:id/resume', (c) => {
    const userId = actor(c),
      prior = store.getSuiteExecution(c.req.param('id'));
    const selected = context(prior.provider, prior.model);
    if (running) throw new StoreError(409, 'Another inference is running.');
    const e = exchange.resume(prior.id, userId, selected);
    running = true;
    const progress = exchange.progress(e, userId);
    launch(e.id);
    return c.json(progress, 202);
  });
  app.get('/api/runs/:id/suite-reference', (c) =>
    c.json(exchange.reference(c.req.param('id'), actor(c))),
  );
  app.post('/api/suite-executions/:id/results', async (c) => {
    const v = gradingSelectionSchema.parse(await c.req.json());
    return c.json(
      exchange.results(c.req.param('id'), actor(c), v.source, v.settings),
    );
  });
  app.post('/api/suite-executions/:id/export', async (c) => {
    const v = gradingSelectionSchema
      .extend({ format: exchangeFormatSchema })
      .parse(await c.req.json());
    const result = exchange.results(
      c.req.param('id'),
      actor(c),
      v.source,
      v.settings,
    );
    return c.json({
      text: serializeDocument(result, v.format),
      format: v.format,
      filename: `experiment-results-${result.execution.id}.${v.format}`,
    });
  });
  return app;
}
