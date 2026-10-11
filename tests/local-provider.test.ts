import { StrandsProvider } from '../server/connection-providers';
import { validateConnection } from '../server/connections';
import { it, expect, vi } from 'vitest';
import { LocalDecisionProvider, localBaseUrl } from '../server/local-provider';
import { LOCAL_MODEL } from './fixture';
import { initialQuery, validateResponse } from '../shared/schema';
import { Store, SCHEMA_VERSION } from '../server/store';
import { createApp } from '../server/app';
import { fixture } from './fixture';
const model = LOCAL_MODEL.split('/').at(-1)!;
const health = {
  status: 'ok',
  model,
  device: 'mps',
  base_model: 'Qwen/Qwen3.5-2B-Base',
  max_length: 4096,
  checkpoint: '/private/checkpoint',
};
const query = { ...initialQuery, model: LOCAL_MODEL };
const wire = { ...fixture, model, latency_ms: 12.34 };
const fetcher = (answer: unknown = wire, status = 200) =>
  vi.fn<typeof fetch>(
    async (url) =>
      new Response(
        JSON.stringify(String(url).endsWith('/health') ? health : answer),
        { status: String(url).endsWith('/health') ? 200 : status },
      ),
  );
it('accepts only explicit loopback origins and validates runtime configuration', () => {
  expect(localBaseUrl('http://127.0.0.1:8000/')).toBe('http://127.0.0.1:8000');
  expect(localBaseUrl('http://[::1]:8000')).toBe('http://[::1]:8000');
  for (const v of [
    'http://localhost:8000',
    'http://127.1:8000',
    'http://2130706433:8000',
    'http://127.0.0.2',
    'http://example.com',
    'https://127.0.0.1',
    'http://127.0.0.1/path',
    'http://127.0.0.1?x=1',
    'http://user@127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:99999',
  ])
    expect(() => localBaseUrl(v)).toThrow();
  expect(
    () => new LocalDecisionProvider(undefined, LOCAL_MODEL, fetch, NaN),
  ).toThrow();
});
it('preserves structured requests and raw responses; never supplies a cloud key; sanitizes health', async () => {
  const f = fetcher({ ...wire, usage: undefined });
  const p = new LocalDecisionProvider('http://127.0.0.1:8000', LOCAL_MODEL, f);
  const q = {
    ...query,
    state: { ticket: ['請求の重複です'] },
    questions: {
      ...query.questions,
      is_urgent: {
        type: 'noul' as const,
        instructions: { question: '急ぎですか' },
        criteria: { true: '急ぎ', false: '通常' },
      },
      department: {
        type: 'choice' as const,
        instructions: '担当',
        criteria: {
          billing: null,
          technical: { scope: '技術' },
          sales: ['販売'],
        },
      },
    },
  };
  const r = await p.evaluate(q);
  expect(r.usage).toEqual({});
  expect(r.rawResponse).not.toHaveProperty('usage');
  expect(r.executionInfo).toEqual({
    device: 'mps',
    baseModel: health.base_model,
  });
  expect(JSON.parse(String(f.mock.calls[1][1]!.body))).toEqual(q);
  expect(f.mock.calls[1][1]!.headers).toEqual({
    'Content-Type': 'application/json',
  });
  expect(f.mock.calls.every((c) => c[1]?.redirect === 'error')).toBe(true);
  expect(await p.health()).not.toHaveProperty('checkpoint');
});
it('rejects unsupported criteria and model selection before network I/O', async () => {
  const f = fetcher();
  const p = new LocalDecisionProvider('http://127.0.0.1:8000', LOCAL_MODEL, f);
  await expect(p.evaluate(initialQuery)).rejects.toMatchObject({
    code: 'local_model_mismatch',
  });
  await expect(
    p.evaluate({
      ...query,
      questions: {
        x: { type: 'choice', instructions: 'x', criteria: { a: null } },
      },
    }),
  ).rejects.toMatchObject({ code: 'local_capability' });
  await expect(
    p.evaluate({
      ...query,
      questions: {
        x: { type: 'score', instructions: 'x', criteria: [{ a: 'a' }, 'b'] },
      },
    }),
  ).rejects.toMatchObject({ code: 'local_capability' });
  expect(f).not.toHaveBeenCalled();
});
it('handles missing configuration, health failure/mismatch, timeout, redirects, overflow, and invalid responses safely', async () => {
  expect(
    await new LocalDecisionProvider(undefined, LOCAL_MODEL).health(),
  ).toEqual({
    status: 'unconfigured',
  });
  const badHealth = vi.fn<typeof fetch>(async () =>
    Response.json({ ...health, model: 'wrong' }),
  );
  await expect(
    new LocalDecisionProvider(
      'http://127.0.0.1:8000',
      LOCAL_MODEL,
      badHealth,
    ).evaluate(query),
  ).rejects.toMatchObject({ code: 'local_mismatch' });
  expect(badHealth).toHaveBeenCalledTimes(1);
  const refused = vi.fn<typeof fetch>(async () => {
    throw new Error('secret body');
  });
  expect(
    await new LocalDecisionProvider(
      'http://127.0.0.1:8000',
      LOCAL_MODEL,
      refused,
    ).health(),
  ).toEqual({ status: 'unreachable' });
  for (const [status, code] of [
    [422, 'local_upstream_422'],
    [500, 'local_upstream_500'],
  ] as const)
    await expect(
      new LocalDecisionProvider(
        'http://127.0.0.1:8000',
        LOCAL_MODEL,
        fetcher({ detail: 'private upstream body' }, status),
      ).evaluate(query),
    ).rejects.toMatchObject({ code });
  const timed = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/health')) return Response.json(health);
    throw new DOMException('secret', 'TimeoutError');
  });
  await expect(
    new LocalDecisionProvider(
      'http://127.0.0.1:8000',
      LOCAL_MODEL,
      timed,
    ).evaluate(query),
  ).rejects.toMatchObject({ code: 'local_timeout' });
  for (const answer of [
    { ...wire, model: 'wrong' },
    { ...wire, answers: {} },
    {
      ...wire,
      answers: {
        ...wire.answers,
        department: { ...wire.answers.department, choice: 'unknown' },
      },
    },
  ])
    await expect(
      new LocalDecisionProvider(
        'http://127.0.0.1:8000',
        LOCAL_MODEL,
        fetcher(answer),
      ).evaluate(query),
    ).rejects.toMatchObject({ code: 'local_invalid_response' });
});
it('executes local without a Jev key, saves provenance, excludes raw answers while blind, and never calls providers when grading', async () => {
  const s = new Store(':memory:');
  const f = fetcher();
  const cloud = vi.fn(async () => validateResponse(fixture, initialQuery));
  const app = createApp(s, { evaluate: cloud }, false, [
    new StrandsProvider(
      validateConnection({
        id: 'strands-local',
        label: 'Local · Strands Decider',
        adapter: 'strands',
        endpoint: 'http://127.0.0.1:8000/v1/systemone',
        model: LOCAL_MODEL,
      }),
      f,
    ),
  ]);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const result = await post('/api/runs', {
    title: 'Local',
    query,
    provider: 'strands-local',
    blind: true,
  });
  expect(result.status).toBe(201);
  const blind = await result.json();
  for (const name of [
    'response',
    'rawResponse',
    'execution',
    'usage',
    'latency_ms',
  ])
    expect(blind.run).not.toHaveProperty(name);
  expect(JSON.stringify(blind)).not.toContain('probabilities');
  const run = s.getRun(blind.run.id);
  expect(run.rawResponse).toEqual(wire);
  expect(run.execution).toMatchObject({
    provider: 'strands-local',
    requestedModel: LOCAL_MODEL,
    resolvedModel: model,
    device: 'mps',
    artifactRevision: null,
  });
  const finalize = await post(`/api/runs/${run.id}/finalize`, {
    labels: { is_urgent: true, department: 'billing', frustration: 1 },
  });
  expect(finalize.status).toBe(200);
  expect(f).toHaveBeenCalledTimes(2);
  expect(cloud).not.toHaveBeenCalled();
  await post('/api/experiments', {
    title: 'Local draft',
    query,
    provider: 'strands-local',
  });
  expect(s.listExperiments()[0].provider).toBe('strands-local');
  s.close();
});
it('shares the execution gate across providers and saves the actor chosen at request start', async () => {
  const s = new Store(':memory:');
  const original = s.actor();
  const second = s.addUser('Other').id;
  let release!: () => void;
  const f = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/health')) return Response.json(health);
    await new Promise<void>((r) => {
      release = r;
    });
    return Response.json(wire);
  });
  const cloud = vi.fn(async () => validateResponse(fixture, initialQuery));
  const app = createApp(s, { evaluate: cloud }, true, [
    new StrandsProvider(
      validateConnection({
        id: 'strands-local',
        label: 'Local · Strands Decider',
        adapter: 'strands',
        endpoint: 'http://127.0.0.1:8000/v1/systemone',
        model: LOCAL_MODEL,
      }),
      f,
    ),
  ]);
  const send = (provider: string, q = query, user = original) =>
    app.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Local-User': user },
      body: JSON.stringify({ title: 'Pinned', query: q, provider }),
    });
  const first = send('strands-local');
  await vi.waitFor(() => expect(release).toBeDefined());
  expect((await send('jev', initialQuery, second)).status).toBe(409);
  release();
  const saved = await (await first).json();
  expect(saved.executedByUserId).toBe(original);
  expect(cloud).not.toHaveBeenCalled();
  s.close();
});
it('upgrades schema 2 additively, restores its backup, and rejects future metadata formats', async () => {
  const { mkdtempSync, readdirSync, rmSync, copyFileSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'local-migrate-'));
  const path = join(dir, 'db.sqlite');
  try {
    const s = await Store.open(path);
    const user = s.actor();
    const run = s.saveRun(
      {
        title: 'Old',
        query: initialQuery,
        response: validateResponse(fixture, initialQuery),
        createdAt: '2026-10-04',
        elapsedMs: 1,
      },
      user,
      true,
    );
    s.finalize(run.id, user, {
      labels: { is_urgent: true, department: 'billing', frustration: 1 },
      note: '',
      settings: { threshold: 0.5, tolerance: 0.5 },
    });
    s.saveExperiment('Old draft', initialQuery, user);
    s.close();
    const db = new DatabaseSync(path);
    db.exec(
      'DROP TABLE suite_run_links; DROP TABLE suite_executions; DROP TABLE expected_exposures; DROP TABLE exchange_documents; DROP TABLE run_metadata; DROP TABLE experiment_metadata; PRAGMA user_version=2;',
    );
    const body = db.prepare('SELECT body FROM runs').get()!.body;
    const revisions = db.prepare('SELECT body FROM revisions').all();
    db.close();
    const upgraded = await Store.open(path);
    expect(upgraded.getRun(run.id).execution?.provider).toBe('jev');
    expect(upgraded.listExperiments()[0].provider).toBe('jev');
    expect(upgraded.revisions(run.id)[0].exposure).toBe('blind');
    upgraded.close();
    const inspect = new DatabaseSync(path);
    expect(inspect.prepare('SELECT body FROM runs').get()!.body).toBe(body);
    expect(inspect.prepare('SELECT body FROM revisions').all()).toEqual(
      revisions,
    );
    expect(inspect.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(inspect.prepare('PRAGMA user_version').get()!.user_version).toBe(
      SCHEMA_VERSION,
    );
    inspect.prepare('INSERT INTO run_metadata VALUES (?,?,NULL)').run(
      run.id,
      JSON.stringify({
        formatVersion: 99,
        provider: 'jev',
        requestedModel: 'x',
      }),
    );
    inspect.close();
    const future = await Store.open(path);
    expect(() => future.getRun(run.id)).toThrow();
    future.close();
    copyFileSync(
      join(
        dir,
        readdirSync(dir).find((n) => n.includes('backup-v2'))!,
      ),
      join(dir, 'restore.sqlite'),
    );
    const restored = new DatabaseSync(join(dir, 'restore.sqlite'));
    expect(restored.prepare('PRAGMA user_version').get()!.user_version).toBe(2);
    expect(restored.prepare('SELECT body FROM runs').get()!.body).toBe(body);
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('validates the recorded live MPS three-question response without inventing model/usage', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(
    readFileSync(
      new URL('./fixtures/strands-v19-response.json', import.meta.url),
      'utf8',
    ),
  );
  const result = await new LocalDecisionProvider(
    'http://127.0.0.1:8000',
    LOCAL_MODEL,
    fetcher(raw),
  ).evaluate(query);
  expect(result.model).toBe('strands-decider-2B-hobson-v19');
  expect(result.rawResponse).toEqual(raw);
  expect(result.usage).toEqual(raw.usage);
  expect(Object.values(result.answers).map((a) => a.type)).toEqual([
    'noul',
    'choice',
    'score',
  ]);
});
it('explains runtime criteria incompatibility without reflecting upstream input or internal errors', async () => {
  const provider = new LocalDecisionProvider(
    'http://127.0.0.1:8000',
    LOCAL_MODEL,
    fetcher(
      {
        detail: [
          {
            type: 'string_type',
            loc: [
              'body',
              'questions',
              'department',
              'ChoiceQuestion',
              'criteria',
              'billing',
            ],
            input: 'private contents',
            msg: '/private/internal/path',
          },
        ],
      },
      422,
    ),
  );
  try {
    await provider.evaluate(query);
    throw new Error('Expected rejection');
  } catch (e) {
    expect(e).toMatchObject({ code: 'local_upstream_422' });
    expect((e as Error).message).toContain('structured or null');
    expect((e as Error).message).not.toContain('private');
  }
});
