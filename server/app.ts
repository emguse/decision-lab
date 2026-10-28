import { FlowService, type InferFlow } from './flows.js';
import {
  flowDocumentSchema,
  flowSchema,
  flowSuiteSchema,
  expectationSchema,
} from '../shared/flows.js';
import { settingsSchema } from '../shared/evaluation.js';
import { createHash } from 'node:crypto';
import {
  ExchangeService,
  importSchema,
  gradingSelectionSchema,
  type ExecuteQuery,
} from './exchange.js';
import {
  exchangeFormatSchema,
  serializeDocument,
  parseExchangeValue,
} from '../shared/exchange.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { validateImage } from './images.js';
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
  app.use('/api/*', async (c, next) =>
    bodyLimit({
      maxSize:
        c.req.method === 'POST' && c.req.path === '/api/images'
          ? 6 * 1024 * 1024
          : 1024 * 1024,
      onError: (c) =>
        c.json({ error: 'Input exceeds the request size limit.' }, 413),
    })(c, next),
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
      recordFormatVersion: 2,
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
  app.post('/api/images', async (c) => {
    const userId = actor(c);
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new StoreError(400, 'Upload one image as multipart form data.');
    }
    const file = form.get('file');
    if (!(file instanceof File) || form.getAll('file').length !== 1)
      throw new StoreError(400, 'Upload one image using the file field.');
    const data = Buffer.from(await file.arrayBuffer());
    const info = await validateImage(data);
    return c.json(store.saveImage(data, info, userId), 201);
  });
  app.get('/api/images/:id', (c) => {
    actor(c);
    const image = store.getImage(c.req.param('id'));
    c.header('Content-Type', image.mime);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(image.data));
  });
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
  const infer: InferFlow = async (query, providerId) => {
    const selectedContext = context(providerId, query.model);
    const selected = providers.get(providerId)!;
    const connection = connections.find(
      (p) => p.connection.id === providerId,
    )?.connection;
    const start = performance.now();
    const { imageIds, ...textInput } = query;
    if (
      imageIds?.length &&
      !['strands', 'llamacpp'].includes(connection?.adapter ?? '')
    )
      throw new ProviderError(
        422,
        'images_unsupported',
        'Select an image-capable Strands or direct llama.cpp connection.',
      );
    const images = store.resolveImages(imageIds);
    const output = await selected.evaluate({
      ...textInput,
      ...(images.length ? { images } : {}),
    });
    const { rawResponse, executionInfo, ...response } = output;
    return {
      response,
      rawResponse,
      elapsedMs: Math.round(performance.now() - start),
      metadata: {
        ...selectedContext.metadata,
        resolvedModel: response.model,
        ...executionInfo,
      },
    };
  };
  const execute: ExecuteQuery = async (
    query,
    title,
    providerId,
    userId,
    blind,
    link,
  ) => {
    const output = await infer(query, providerId);
    return store.saveRun(
      {
        title,
        query,
        response: output.response,
        elapsedMs: output.elapsedMs,
        createdAt: new Date().toISOString(),
      },
      userId,
      blind,
      output.metadata,
      output.rawResponse,
      link,
    );
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
  app.post('/api/suites/:id/images', async (c) => {
    const user = actor(c),
      originalId = c.req.param('id'),
      suite = exchange.suite(originalId);
    const v = z
      .object({
        version: z.number().int().positive(),
        images: z.record(z.string(), requestSchema.shape.imageIds.unwrap()),
      })
      .strict()
      .parse(await c.req.json());
    if (v.version <= suite.version)
      throw new StoreError(400, 'Use a higher Suite version.');
    if (
      Object.keys(v.images).some(
        (id) => !suite.cases.some((item) => item.id === id),
      )
    )
      throw new StoreError(400, 'Unknown case ID.');
    for (const ids of Object.values(v.images)) store.resolveImages(ids);
    const document = {
      ...suite,
      schemaVersion: 2 as const,
      version: v.version,
      cases: suite.cases.map((item) => ({
        ...item,
        imageIds: v.images[item.id] ?? item.imageIds,
      })),
    };
    const saved = store.saveDocuments([document], user, false)[0];
    if (store.expectedSeenAt(originalId, user))
      store.noteExpectedSeen(saved.id, user);
    return c.json(saved, 201);
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
  const flows = new FlowService(store);
  app.get('/api/flow-documents', (c) => {
    actor(c);
    return c.json(store.listFlowDocuments());
  });
  app.post('/api/flow-documents', async (c) =>
    c.json(flows.save(await c.req.json(), actor(c)), 201),
  );
  app.post('/api/flow-documents/import', async (c) => {
    const v = z
      .object({ source: z.string(), format: exchangeFormatSchema })
      .strict()
      .parse(await c.req.json());
    return c.json(
      flows.save(parseExchangeValue(v.source, v.format), actor(c)),
      201,
    );
  });
  app.post('/api/flow-documents/validate', async (c) => {
    actor(c);
    flows.validate(flowDocumentSchema.parse(await c.req.json()));
    return c.json({ valid: true });
  });
  app.get('/api/flow-documents/:id', (c) => {
    const user = actor(c),
      document = store.getFlowDocument(c.req.param('id'));
    if (document.kind === 'flow-suite')
      return c.json({
        ...document,
        cases: document.cases.map(({ expected: _expected, ...item }) => item),
        expectedSeenAt: store.expectedSeenAt(c.req.param('id'), user),
      });
    return c.json(document);
  });
  app.post('/api/flow-documents/:id/export', async (c) => {
    const user = actor(c),
      document = store.getFlowDocument(c.req.param('id'));
    const { format } = z
      .object({ format: exchangeFormatSchema })
      .strict()
      .parse(await c.req.json());
    if (
      document.kind === 'flow-suite' &&
      document.cases.some((item) => item.expected)
    )
      store.noteExpectedSeen(c.req.param('id'), user);
    return c.json({
      text: serializeDocument(document, format),
      filename: `${document.kind}-${document.name}-v${document.version}.${format}`,
      format,
    });
  });
  app.get('/api/flow-definitions', (c) => {
    actor(c);
    return c.json(
      store
        .listDocuments()
        .filter((d) => d.kind === 'decision-definition')
        .map((d) => ({ id: d.id, ...store.getDocument(d.id) })),
    );
  });
  const flowRunInput = z
    .object({
      ...suiteRunInput.shape,
      state: requestSchema.shape.state,
      imageIds: requestSchema.shape.imageIds,
    })
    .strict();
  function launchFlow(id: string) {
    void flows
      .run(id, infer)
      .catch(() => {
        /* startup marks persisted executions interrupted */
      })
      .finally(() => {
        running = false;
      });
  }
  app.post('/api/flows/:id/execute', async (c) => {
    const user = actor(c),
      v = flowRunInput.parse(await c.req.json()),
      selected = context(v.provider, v.model);
    if (running) throw new StoreError(409, 'Another inference is running.');
    const e = flows.create(
      c.req.param('id'),
      { state: v.state, imageIds: v.imageIds },
      v.provider,
      v.model,
      user,
      selected,
    );
    running = true;
    launchFlow(e.id);
    return c.json(flows.summary(e, user), 202);
  });
  app.get('/api/flow-executions', (c) => {
    const user = actor(c);
    return c.json(
      store.listFlowExecutions().map((e) => flows.summary(e, user)),
    );
  });
  app.get('/api/flow-executions/:id', (c) => {
    const user = actor(c),
      e = store.getFlowExecution(c.req.param('id'));
    if (!store.flowRevealed(e.id, user)) return c.json(flows.summary(e, user));
    return c.json(e);
  });
  app.get('/api/flow-executions/:id/labeling', (c) =>
    c.json(flows.labeling(c.req.param('id'), actor(c))),
  );
  app.post('/api/flow-executions/:id/reveal', (c) => {
    const user = actor(c),
      id = c.req.param('id');
    store.revealFlow(id, user);
    return c.json(store.getFlowExecution(id));
  });
  const flowLabelsInput = z
    .object({
      labels: expectationSchema,
      settings: settingsSchema
        .strict()
        .default({ threshold: 0.5, tolerance: 0.5 }),
    })
    .strict();
  app.post('/api/flow-executions/:id/finalize', async (c) => {
    const v = flowLabelsInput.parse(await c.req.json());
    return c.json(
      flows.finalize(c.req.param('id'), actor(c), v.labels, v.settings),
      201,
    );
  });
  app.post('/api/flow-executions/:id/assignments', async (c) => {
    actor(c);
    const v = z
      .object({ userId: z.string() })
      .strict()
      .parse(await c.req.json());
    store.assignFlow(c.req.param('id'), v.userId);
    return c.json({ assigned: true });
  });
  app.get('/api/flow-executions/:id/comparison', (c) => {
    const user = actor(c),
      id = c.req.param('id'),
      assigned = store.flowAssignments(id);
    if (
      !assigned.includes(user) ||
      assigned.some(
        (u) => !store.flowRevisions(id, u).some((r) => r.kind === 'individual'),
      )
    )
      throw new StoreError(409, 'Wait for assigned evaluators to finalize.');
    return c.json({ revisions: store.flowRevisions(id) });
  });
  app.post('/api/flow-executions/:id/adopt', async (c) => {
    const v = flowLabelsInput
      .extend({ sourceRevisionIds: z.array(z.string().uuid()) })
      .parse(await c.req.json());
    return c.json(
      flows.finalize(
        c.req.param('id'),
        actor(c),
        v.labels,
        v.settings,
        'reference',
        v.sourceRevisionIds,
      ),
      201,
    );
  });
  app.post('/api/flow-suites/:id/execute', async (c) => {
    const user = actor(c),
      v = suiteRunInput.parse(await c.req.json()),
      selected = context(v.provider, v.model);
    if (running) throw new StoreError(409, 'Another inference is running.');
    const suiteId = c.req.param('id'),
      suite = flowSuiteSchema.parse(store.getFlowDocument(suiteId));
    const flow = store
      .listFlowDocuments()
      .find(
        (d) =>
          d.kind === 'decision-flow' &&
          d.name === suite.flow.name &&
          d.version === suite.flow.version,
      );
    if (!flow) throw new StoreError(409, 'Flow reference was not found.');
    for (const item of suite.cases) store.resolveImages(item.imageIds);
    const executions = suite.cases.map((item) =>
      flows.create(
        flow.id,
        { state: item.state, imageIds: item.imageIds },
        v.provider,
        v.model,
        user,
        selected,
        suiteId,
        item.id,
      ),
    );
    running = true;
    void (async () => {
      for (const e of executions) await flows.run(e.id, infer);
    })()
      .catch(() => {
        /* persisted state is recovered on restart */
      })
      .finally(() => {
        running = false;
      });
    return c.json(
      { executions: executions.map((e) => flows.summary(e, user)) },
      202,
    );
  });
  app.post('/api/flow-suites/:id/results', async (c) => {
    const v = z
      .object({
        executionIds: z.array(z.string().uuid()).min(1).max(100),
        source: z.enum(['expected', 'individual', 'reference']),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      flows.results(c.req.param('id'), v.executionIds, actor(c), v.source),
    );
  });
  return app;
}
