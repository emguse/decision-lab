import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../server/store';
import { ExchangeService } from '../server/exchange';
import { createApp } from '../server/app';
import { ProviderError } from '../server/provider';
import { initialQuery, validateResponse } from '../shared/schema';
import {
  parseInput,
  serializeDocument,
  definitionSchema,
  suiteSchema,
  type SuiteProgress,
  type Definition,
  type Suite,
  type ExperimentResults,
} from '../shared/exchange';
import { fixture } from './fixture';
import { emptyDraft } from '../shared/evaluation';

export const definition: Definition = definitionSchema.parse({
  kind: 'decision-definition',
  schemaVersion: 1,
  name: 'support',
  version: 1,
  questions: initialQuery.questions,
});
export const suite: Suite = suiteSchema.parse({
  kind: 'experiment-suite',
  schemaVersion: 1,
  name: 'evaluation',
  version: 1,
  definition: { name: definition.name, version: definition.version },
  cases: [
    {
      id: 'q001',
      state: {
        query: '返金をお願いしたい\n手続きを教えて',
        context: ['日本語', { industry: '製造業' }],
        number: '001',
        enabled: true,
        nothing: null,
      },
      expected: { is_urgent: true, department: 'billing', frustration: 1 },
      note: 'External reference',
    },
    {
      id: 'q002',
      state: '手順を教えて',
      expected: { department: 'technical' },
    },
    { id: 'q003', state: '期待結果なし' },
  ],
});
export const inputs = (docs = [definition, suite]) => ({
  documents: docs.map((d) => ({
    source: serializeDocument(d, 'yaml'),
    format: 'yaml' as const,
  })),
});
function setup(
  provider = {
    evaluate: vi.fn(async () => validateResponse(fixture, initialQuery)),
  },
  store = new Store(':memory:'),
) {
  const app = createApp(store, provider, true);
  const actor = store.actor();
  const req = (
    path: string,
    body?: unknown,
    user = actor,
    method = body === undefined ? 'GET' : 'POST',
  ) =>
    app.request(`/api/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Local-User': user },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { app, store, actor, req, provider };
}
async function imported(ctx: ReturnType<typeof setup>) {
  const res = await ctx.req('exchange/import', inputs());
  expect(res.status).toBe(201);
  return (await res.json()).find(
    (d: { kind: string }) => d.kind === 'experiment-suite',
  ).id as string;
}
async function waitFor(ctx: ReturnType<typeof setup>, id: string) {
  let result!: SuiteProgress;
  for (let i = 0; i < 100; i++) {
    result = await (await ctx.req(`suite-executions/${id}`)).json();
    if (result.status !== 'running') return result;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('Worker did not finish');
}
describe('exchange formats', () => {
  it('round-trips all primitives, structured fields, null, strings, and ordering across YAML/JSON', () => {
    const structured = definitionSchema.parse({
      ...definition,
      questions: {
        ...definition.questions,
        department: {
          type: 'choice',
          instructions: { text: '選択', examples: ['a', { b: true }] },
          criteria: { technical: null, billing: ['返金', { invoice: '請求' }] },
        },
        frustration: {
          type: 'score',
          instructions: ['Evaluation'],
          criteria: [{ level: '穏やか' }, ['怒り']],
        },
        is_urgent: {
          type: 'noul',
          instructions: '急ぎ？',
          criteria: { true: { when: '期限あり' }, false: ['期限なし'] },
        },
      },
    });
    for (const doc of [structured, suite]) {
      const yaml = serializeDocument(doc, 'yaml');
      const json = serializeDocument(parseInput(yaml, 'yaml'), 'json');
      expect(JSON.stringify(parseInput(json, 'json'))).toBe(
        JSON.stringify(doc),
      );
    }
  });
  it('rejects duplicate keys in JSON/YAML, tags, aliases, multiple documents, future formats, unknown fields and non-JSON values', () => {
    const source = serializeDocument(definition, 'yaml');
    for (const bad of [
      source + 'name: duplicate\n',
      source + '---\n' + source,
      source.replace('support', '&anchor support'),
      source.replace('support', '!!str support'),
      source.replace('support', '.inf'),
      source.replace('schemaVersion: 1', 'schemaVersion: 99'),
      source + 'unknown: true\n',
    ])
      expect(() => parseInput(bad, 'yaml')).toThrow();
    expect(() =>
      parseInput(
        '{"kind":"decision-definition","kind":"experiment-suite"}',
        'json',
      ),
    ).toThrow();
    expect(() => parseInput(source, 'json')).toThrow();
    expect(() =>
      parseInput(
        serializeDocument(
          {
            ...definition,
            questions: { q: { type: 'noul', instructions: 'ok', extra: true } },
          },
          'yaml',
        ),
        'yaml',
      ),
    ).toThrow();
    expect(() => parseInput('x'.repeat(1024 * 1024 + 1), 'yaml')).toThrow(
      '1 MiB',
    );
    expect(() =>
      suiteSchema.parse({
        ...suite,
        cases: Array.from({ length: 101 }, (_, i) => ({
          id: String(i),
          state: '',
        })),
      }),
    ).toThrow();
    expect(() =>
      suiteSchema.parse({ ...suite, cases: [suite.cases[0], suite.cases[0]] }),
    ).toThrow();
  });
});
it('previews without saving/inference, validates references, imports atomically and prevents conflicting versions', async () => {
  const c = setup();
  try {
    expect((await c.req('exchange/preview', inputs())).status).toBe(200);
    expect(c.store.listDocuments()).toHaveLength(0);
    expect((await c.req('exchange/import', inputs([suite]))).status).toBe(400);
    expect(c.store.listDocuments()).toHaveLength(0);
    const bad = {
      ...suite,
      cases: [{ id: 'bad', state: 'x', expected: { department: 'unknown' } }],
    };
    expect(
      (await c.req('exchange/import', inputs([definition, bad]))).status,
    ).toBe(400);
    expect(c.store.listDocuments()).toHaveLength(0);
    const id = await imported(c);
    await imported(c);
    expect(c.store.listDocuments()).toHaveLength(2);
    expect(
      (
        await c.req(
          'exchange/import',
          inputs([
            {
              ...definition,
              questions: { q: { type: 'noul', instructions: 'different' } },
            },
          ]),
        )
      ).status,
    ).toBe(409);
    // A second conflicting document cannot leave the first new one behind.
    expect(
      (
        await c.req(
          'exchange/import',
          inputs([
            { ...definition, version: 2 },
            { ...suite, cases: [] },
          ]),
        )
      ).status,
    ).toBe(400);
    expect(c.store.listDocuments()).toHaveLength(2);
    expect(c.provider.evaluate).not.toHaveBeenCalled();
    const exported = await (
      await c.req(`exchange/documents/${id}/export`, { format: 'json' })
    ).json();
    expect(parseInput(exported.text, 'json')).toEqual(suite);
  } finally {
    c.store.close();
  }
});
it('executes sequentially, keeps partial successes, stops on failure and resumes only unfinished cases with immutable snapshots', async () => {
  let call = 0;
  const evaluate = vi.fn(async () => {
    call++;
    if (call === 2)
      throw new ProviderError(429, 'rate', 'secret provider body');
    return validateResponse(fixture, initialQuery);
  });
  const c = setup({ evaluate });
  try {
    const suiteId = await imported(c);
    const started = await c.req(`suites/${suiteId}/execute`, {
      provider: 'jev',
      model: 'jev-latest',
    });
    expect(started.status).toBe(202);
    const id = (await started.json()).id;
    let progress = await waitFor(c, id);
    expect(progress.status).toBe('stopped');
    expect(progress.cases.map((c) => c.status)).toEqual([
      'succeeded',
      'failed',
      'pending',
    ]);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(progress)).not.toContain('secret');
    expect(progress.cases[0].runId).toBeTruthy();
    expect(evaluate.mock.calls[0]).toHaveLength(1);
    const query = (evaluate.mock.calls as unknown as [unknown][])[0][0];
    expect(query).toEqual({
      model: 'jev-latest',
      state: suite.cases[0].state,
      questions: definition.questions,
    });
    expect(JSON.stringify(query)).not.toContain('expected');
    expect(
      (
        await c.req(
          `suite-executions/${id}/resume`,
          {},
          c.store.addUser('Other').id,
        )
      ).status,
    ).toBe(403);
    expect((await c.req(`suite-executions/${id}/resume`, {})).status).toBe(202);
    progress = await waitFor(c, id);
    expect(progress.status).toBe('completed');
    expect(evaluate).toHaveBeenCalledTimes(4);
    expect(progress.cases.map((c) => c.attempts.length)).toEqual([1, 2, 1]);
    expect(c.store.getSuiteExecution(id).definition).toEqual(definition);
    expect(c.store.getSuiteExecution(id).suite).toEqual(suite);
    expect((await c.req(`suite-executions/${id}/resume`, {})).status).toBe(409);
  } finally {
    c.store.close();
  }
});
it('gates all predictions and expected values per evaluator and exports partial grading with provenance and separate metrics', async () => {
  const c = setup();
  try {
    const second = c.store.addUser('Blind reviewer').id;
    const suiteId = await imported(c);
    const id = (
      await (
        await c.req(`suites/${suiteId}/execute`, {
          provider: 'jev',
          model: 'jev-latest',
        })
      ).json()
    ).id;
    const progress = await waitFor(c, id);
    const runId = progress.cases[0].runId!;
    for (const user of [c.actor, second]) {
      const labeling = await (
        await c.req(`runs/${runId}/labeling`, undefined, user)
      ).json();
      expect(labeling.draft.labels).toEqual({});
      expect(JSON.stringify(labeling)).not.toMatch(
        /"(expected|response|probabilities|grading|rawResponse)"/,
      );
      expect(
        (await c.req(`runs/${runId}/suite-reference`, undefined, user)).status,
      ).toBe(403);
      expect(
        (
          await c.req(
            `suite-executions/${id}/export`,
            { source: 'expected', format: 'yaml' },
            user,
          )
        ).status,
      ).toBe(403);
      const details = await (
        await c.req(`suites/${suiteId}`, undefined, user)
      ).json();
      expect(JSON.stringify(details)).not.toMatch(
        /"(expected|grading|response|probabilities)"/,
      );
    }
    c.store.finalize(runId, second, {
      ...emptyDraft(),
      labels: { is_urgent: true, department: 'billing', frustration: 1 },
    });
    expect(
      c.store.revisions(runId, second)[0].expectedExposure?.seenAt,
    ).toBeNull();
    expect(c.store.revisions(runId, second)[0].exposure).toBe('blind');
    expect(
      (await c.req(`runs/${runId}/suite-reference`, undefined, second)).status,
    ).toBe(200);
    expect(c.store.expectedSeenAt(suiteId, second)).toBeTruthy();
    expect(c.store.revealed(runId, c.actor)).toBe(false);
    for (const item of progress.cases) c.store.reveal(item.runId!, c.actor);
    const result: ExperimentResults = await (
      await c.req(`suite-executions/${id}/results`, { source: 'expected' })
    ).json();
    expect(result.kind).toBe('experiment-results');
    expect(result.gradingSelection).toEqual({
      source: 'expected',
      settingsOverride: null,
    });
    expect(result.summary.noul.total).toBe(1);
    expect(result.summary.choice.total).toBe(2);
    expect(result.summary.score.mae).toBe(0.5);
    expect(result.summary.missingLabels).toBe(5);
    expect(result.results[1].grading?.revisionId).toBeNull();
    expect(result.results[0].execution?.artifactRevision).toBeNull();
    expect(result.results[0].input.questions).toEqual(definition.questions);
    expect(result.definition).toEqual(definition);
    expect(result.suite).toEqual(suite);
    expect(result).not.toHaveProperty('execution.connectionFingerprint');
    expect(JSON.stringify(result)).not.toContain('rawResponse');
    expect(
      (await c.req(`suite-executions/${id}/results`, { source: 'reference' }))
        .status,
    ).toBe(409);
    const exported = await (
      await c.req(`suite-executions/${id}/export`, {
        source: 'expected',
        format: 'json',
      })
    ).json();
    expect(JSON.parse(exported.text).summary).toEqual(result.summary);
    expect(c.provider.evaluate).toHaveBeenCalledTimes(3);
  } finally {
    c.store.close();
  }
});
it('blocks concurrent suite and single inference and pins the actor while profiles switch', async () => {
  let release!: () => void;
  const evaluate = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return validateResponse(fixture, initialQuery);
  });
  const c = setup({ evaluate });
  try {
    const suiteId = (
      await (
        await c.req(
          'exchange/import',
          inputs([definition, { ...suite, cases: [suite.cases[0]] }]),
        )
      ).json()
    ).find((d: { kind: string }) => d.kind === 'experiment-suite').id;
    const other = c.store.addUser('Other').id;
    const id = (
      await (
        await c.req(`suites/${suiteId}/execute`, {
          provider: 'jev',
          model: 'jev-latest',
        })
      ).json()
    ).id;
    expect(
      (
        await c.req(
          'runs',
          { title: 'x', query: initialQuery, blind: true },
          other,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await c.req(
          `suites/${suiteId}/execute`,
          { provider: 'jev', model: 'jev-latest' },
          other,
        )
      ).status,
    ).toBe(409);
    release();
    const progress = await waitFor(c, id);
    expect(c.store.attribution(progress.cases[0].runId!).userId).toBe(c.actor);
    expect(c.store.listRuns(other)).toHaveLength(0);
  } finally {
    c.store.close();
  }
});
it('keeps adoption revisioned, chooses an explicit label source, regrades without inference, and records expected familiarity', async () => {
  const c = setup();
  try {
    const suiteId = (
      await (
        await c.req(
          'exchange/import',
          inputs([definition, { ...suite, cases: [suite.cases[0]] }]),
        )
      ).json()
    ).find((d: { kind: string }) => d.kind === 'experiment-suite').id;
    const other = c.store.addUser('Other').id;
    await c.req(
      `exchange/documents/${suiteId}/export`,
      { format: 'yaml' },
      other,
    );
    expect(c.store.expectedSeenAt(suiteId, other)).toBeTruthy();
    const id = (
      await (
        await c.req(`suites/${suiteId}/execute`, {
          provider: 'jev',
          model: 'jev-latest',
        })
      ).json()
    ).id;
    const runId = (await waitFor(c, id)).cases[0].runId!;
    const labels = { is_urgent: true, department: 'billing', frustration: 1 };
    c.store.assign(runId, other);
    c.store.finalize(runId, c.actor, { ...emptyDraft(), labels });
    c.store.finalize(runId, other, { ...emptyDraft(), labels });
    expect(
      c.store.revisions(runId, other)[0].expectedExposure?.seenAt,
    ).toBeTruthy();
    const reference = c.store.adopt(
      runId,
      c.actor,
      { ...emptyDraft(), labels },
      c.store.comparison(runId, c.actor).revisions.map((r) => r.id),
    );
    let result: ExperimentResults = await (
      await c.req(`suite-executions/${id}/results`, { source: 'reference' })
    ).json();
    expect(result.results[0].grading?.revisionId).toBe(reference.id);
    expect(result.results[0].revision?.sourceRevisionIds).toHaveLength(2);
    result = await (
      await c.req(`suite-executions/${id}/results`, {
        source: 'individual',
        settings: { threshold: 0.99, tolerance: 0 },
      })
    ).json();
    expect(result.summary.noul.correct).toBe(0);
    expect(result.summary.score.correct).toBe(0);
    expect(result.results[0].grading?.revisionId).toBe(
      c.store.revisions(runId, c.actor)[0].id,
    );
    expect(c.provider.evaluate).toHaveBeenCalledTimes(1);
  } finally {
    c.store.close();
  }
});
it('persists interrupted attempts across restart and requires explicit resume without resending successful cases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exchange-restart-'));
  try {
    const path = join(dir, 'db.sqlite');
    let store = await Store.open(path);
    let service = new ExchangeService(store);
    const actor = store.actor();
    const suiteId = service
      .import(inputs(), actor)
      .find((d) => d.kind === 'experiment-suite')!.id;
    const context = {
      fingerprint: 'test',
      metadata: {
        formatVersion: 1 as const,
        provider: 'jev' as const,
        requestedModel: 'jev-latest',
        artifactRevision: null,
      },
    };
    const e = service.create(suiteId, 'jev', 'jev-latest', actor, context);
    e.cases[0].status = 'running';
    e.cases[0].attempts.push({
      id: 'attempt-1',
      startedAt: new Date().toISOString(),
      status: 'running',
    });
    store.putSuiteExecution(e);
    store.saveRun(
      {
        title: 'one',
        query: initialQuery,
        response: validateResponse(fixture, initialQuery),
        elapsedMs: 1,
        createdAt: new Date().toISOString(),
      },
      actor,
      true,
      undefined,
      undefined,
      { executionId: e.id, caseId: e.cases[0].caseId, attemptId: 'attempt-1' },
    );
    const pending = store.getSuiteExecution(e.id);
    pending.cases[1].status = 'running';
    pending.cases[1].attempts.push({
      id: 'attempt-2',
      startedAt: new Date().toISOString(),
      status: 'running',
    });
    store.putSuiteExecution(pending);
    store.close();
    store = await Store.open(path);
    service = new ExchangeService(store);
    expect(store.getSuiteExecution(e.id).status).toBe('interrupted');
    expect(store.getSuiteExecution(e.id).cases.map((c) => c.status)).toEqual([
      'succeeded',
      'interrupted',
      'pending',
    ]);
    expect(() =>
      service.resume(e.id, actor, { ...context, fingerprint: 'changed' }),
    ).toThrow('Connection settings');
    service.resume(e.id, actor, context);
    const calls: string[] = [];
    await service.run(
      e.id,
      async (query, title, provider, user, blind, link) => {
        calls.push(link!.caseId);
        return store.saveRun(
          {
            title,
            query,
            response: validateResponse(fixture, query),
            elapsedMs: 1,
            createdAt: new Date().toISOString(),
          },
          user,
          blind,
          undefined,
          undefined,
          link,
        );
      },
    );
    expect(calls).toEqual(['q002', 'q003']);
    expect(store.getSuiteExecution(e.id).status).toBe('completed');
    expect(
      store.getSuiteExecution(e.id).cases[1].attempts.map((a) => a.status),
    ).toEqual(['interrupted', 'succeeded']);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('migrates schema 3 additively with a restorable backup and leaves old payloads intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exchange-migrate-'));
  try {
    const path = join(dir, 'db.sqlite');
    const s = await Store.open(path);
    const actor = s.actor();
    const r = s.saveRun(
      {
        title: 'old',
        query: initialQuery,
        response: validateResponse(fixture, initialQuery),
        elapsedMs: 1,
        createdAt: '2026-10-01',
      },
      actor,
      true,
    );
    s.close();
    const old = new DatabaseSync(path);
    old.exec(
      'DROP TABLE suite_run_links; DROP TABLE suite_executions; DROP TABLE expected_exposures; DROP TABLE exchange_documents; PRAGMA user_version=3;',
    );
    const body = old.prepare('SELECT body FROM runs').get()!.body;
    old.close();
    const upgraded = await Store.open(path);
    expect(upgraded.getRun(r.id).query).toEqual(initialQuery);
    upgraded.close();
    const db = new DatabaseSync(path);
    expect(db.prepare('SELECT body FROM runs').get()!.body).toBe(body);
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(
      SCHEMA_VERSION,
    );
    db.close();
    const files = readdirSync(dir).filter((f) => f.includes('backup'));
    expect(files).toHaveLength(1);
    const backup = new DatabaseSync(join(dir, files[0]));
    expect(backup.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
    expect(backup.prepare('SELECT body FROM runs').get()!.body).toBe(body);
    backup.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('uses Clef joint questions unchanged, preserves original responses separately, and never falls back to Jev', async () => {
  const { SystemOneProvider } = await import('../server/systemone-provider');
  const { parseConnections } = await import('../server/connections');
  const store = new Store(':memory:');
  const requests: unknown[] = [];
  const connection = parseConnections(`version = 1
[[connections]]
id = "clef-local"
label = "Clef test"
adapter = "llamacpp"
endpoint = "http://127.0.0.1:8080/v1/systemone"
model = "clef"
question_interaction = "joint"
`)[0];
  const provider = new SystemOneProvider(
    connection,
    undefined,
    async (url, init) => {
      if (String(url).endsWith('/health'))
        return Response.json({ status: 'ok' });
      if (String(url).endsWith('/v1/models'))
        return Response.json({
          data: [
            { id: 'clef', architecture: { output_modalities: ['decisions'] } },
          ],
        });
      requests.push(JSON.parse(String(init?.body)));
      const { usage: _usage, ...raw } = fixture;
      return Response.json({ ...raw, model: 'clef' });
    },
  );
  const jev = { evaluate: vi.fn() };
  const app = createApp(store, jev, false, [provider]);
  const actor = store.actor();
  const req = (path: string, body?: unknown) =>
    app.request(`/api/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Local-User': actor },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    const docs = await (
      await req(
        'exchange/import',
        inputs([definition, { ...suite, cases: [suite.cases[0]] }]),
      )
    ).json();
    const suiteId = docs.find(
      (d: { kind: string }) => d.kind === 'experiment-suite',
    ).id;
    expect(
      (
        await req(`suites/${suiteId}/execute`, {
          provider: 'missing',
          model: 'clef',
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await req(`suites/${suiteId}/execute`, {
          provider: 'clef-local',
          model: 'different',
        })
      ).status,
    ).toBe(422);
    const id = (
      await (
        await req(`suites/${suiteId}/execute`, {
          provider: 'clef-local',
          model: 'clef',
        })
      ).json()
    ).id;
    let progress!: SuiteProgress;
    for (let i = 0; i < 100; i++) {
      progress = await (await req(`suite-executions/${id}`)).json();
      if (progress.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(progress.status).toBe('completed');
    expect(requests).toEqual([
      {
        model: 'clef',
        state: suite.cases[0].state,
        questions: definition.questions,
      },
    ]);
    const run = store.getRun(progress.cases[0].runId!);
    expect(run.rawResponse).not.toHaveProperty('usage');
    expect(run.response.usage).toEqual({});
    expect(JSON.stringify(store.labeling(run.id, actor))).not.toContain(
      'rawResponse',
    );
    store.reveal(run.id, actor);
    const result = await (
      await req(`suite-executions/${id}/results`, { source: 'expected' })
    ).json();
    expect(result.execution.questionInteraction).toBe('joint');
    expect(result.results[0].execution.questionInteraction).toBe('joint');
    expect(result.results[0]).not.toHaveProperty('rawResponse');
    expect(jev.evaluate).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});
it('rolls back documents and expected familiarity together and does not leave an orphan run after a failed link', () => {
  const store = new Store(':memory:');
  const service = new ExchangeService(store);
  const actor = store.actor();
  try {
    const documents = service.import(inputs(), actor);
    const second = store.addUser('Other').id;
    expect(() =>
      store.saveDocuments(
        [
          suite,
          {
            ...definition,
            questions: { q: { type: 'noul', instructions: 'different' } },
          },
        ],
        second,
      ),
    ).toThrow('Different content');
    expect(
      store.expectedSeenAt(
        documents.find((d) => d.kind === 'experiment-suite')!.id,
        second,
      ),
    ).toBeNull();
    expect(() =>
      store.saveDocuments(
        [
          { ...definition, version: 2 },
          { ...suite, cases: [] },
        ],
        actor,
      ),
    ).toThrow('Different content');
    expect(store.listDocuments()).toHaveLength(2);
    const execution = service.create(
      documents.find((d) => d.kind === 'experiment-suite')!.id,
      'jev',
      'jev-latest',
      actor,
      {
        fingerprint: 'test',
        metadata: {
          formatVersion: 1,
          provider: 'jev',
          requestedModel: 'jev-latest',
          artifactRevision: null,
        },
      },
    );
    expect(() =>
      store.saveRun(
        {
          title: 'fail',
          query: initialQuery,
          response: validateResponse(fixture, initialQuery),
          createdAt: '2026-10-11',
          elapsedMs: 1,
        },
        actor,
        true,
        undefined,
        undefined,
        { executionId: execution.id, caseId: 'q001', attemptId: 'missing' },
      ),
    ).toThrow('The case execution state changed.');
    expect(store.listSummaries(actor)).toHaveLength(0);
    expect(
      store.getSuiteExecution(execution.id).cases[0].runId,
    ).toBeUndefined();
  } finally {
    store.close();
  }
});
it('validates the shipped examples, safely rejects parser diagnostics, and refuses results input', async () => {
  const { parseDocument } = await import('yaml');
  const { resultsSchema } = await import('../shared/exchange');
  for (const kind of [
    'decision-definition',
    'experiment-suite',
    'experiment-results',
  ]) {
    const yaml = readFileSync(`examples/exchange/${kind}.yaml`, 'utf8');
    const json = readFileSync(`examples/exchange/${kind}.json`, 'utf8');
    if (kind === 'experiment-results') {
      expect(resultsSchema.parse(parseDocument(yaml).toJS())).toEqual(
        resultsSchema.parse(JSON.parse(json)),
      );
      expect(() => parseInput(json, 'json')).toThrow();
    } else expect(parseInput(yaml, 'yaml')).toEqual(parseInput(json, 'json'));
  }
  expect(() =>
    parseInput(
      '%YAML 1.1\n---\n' + serializeDocument(definition, 'yaml'),
      'yaml',
    ),
  ).toThrow('1.2');
  expect(() =>
    parseInput(
      serializeDocument(
        { ...suite, cases: [{ id: 'q', state: { false: 'value' } }] },
        'yaml',
      ).replace('"false":', 'false:'),
      'yaml',
    ),
  ).toThrow('Mapping keys must be strings');
  expect(() =>
    parseInput(
      JSON.stringify({
        ...suite,
        cases: [{ id: 'q', state: { x: { y: 'secret' } } }],
      }).replace('"y":"secret"', '"y":"secret",'),
      'json',
    ),
  ).toThrow();
  const c = setup();
  try {
    const body = await (
      await c.req('exchange/import', {
        documents: [
          { source: '{"apiKey":"DO_NOT_ECHO_SECRET",}', format: 'json' },
        ],
      })
    ).json();
    expect(JSON.stringify(body)).not.toContain('DO_NOT_ECHO_SECRET');
  } finally {
    c.store.close();
  }
});

it('rejects identifier normalization rather than silently changing option IDs or expectations', () => {
  expect(() =>
    parseInput(
      serializeDocument(
        {
          ...definition,
          questions: {
            q: {
              type: 'choice',
              instructions: 'Pick',
              criteria: { ' option ': 'description' },
            },
          },
        },
        'yaml',
      ),
      'yaml',
    ),
  ).toThrow();
  expect(() =>
    parseInput(
      serializeDocument(
        {
          ...definition,
          questions: { ' q ': { type: 'noul', instructions: 'Yes?' } },
        },
        'json',
      ),
      'json',
    ),
  ).toThrow();
  expect(() =>
    parseInput(
      serializeDocument(
        { ...suite, cases: [{ id: ' q ', state: 'input' }] },
        'yaml',
      ),
      'yaml',
    ),
  ).toThrow();
});
