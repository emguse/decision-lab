import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConnections,
  parseConnections,
  validateConnection,
} from '../server/connections';
import { createConnectionProvider } from '../server/connection-providers';
import { createApp } from '../server/app';
import { Store } from '../server/store';
import { initialQuery, validateResponse } from '../shared/schema';
import { LOCAL_MODEL } from './fixture';
import { fixture } from './fixture';
import { exampleDefinition, exampleSuite } from '../shared/exchange-examples';
import { serializeDocument } from '../shared/exchange';
const source = `version = 1
[[connections]]
id = "strands-local"
label = "Local · Strands Decider"
adapter = "strands"
endpoint = "http://127.0.0.1:8012/v1/systemone"
model = "${LOCAL_MODEL}"
`;
const connection = parseConnections(source)[0];
function fetcher() {
  return vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        status: 'ok',
        model: LOCAL_MODEL.split('/').at(-1),
        device: 'mps',
        base_model: 'Qwen/Qwen3.5-2B-Base',
        max_length: 4096,
        checkpoint: '/private/weights',
      });
    const input = JSON.parse(String(init?.body));
    const answers = Object.fromEntries(
      Object.entries(input.questions).map(([id, question]) => {
        const q = question as {
          type: string;
          criteria: Record<string, unknown>;
        };
        return [
          id,
          q.type === 'choice'
            ? {
                type: 'choice',
                choice: Object.keys(q.criteria)[0],
                probabilities: Object.fromEntries(
                  Object.keys(q.criteria).map((key, index) => [
                    key,
                    index === 0 ? 1 : 0,
                  ]),
                ),
                confidence: 1,
              }
            : fixture.answers[id as keyof typeof fixture.answers],
        ];
      }),
    );
    return Response.json({
      ...fixture,
      answers,
      model: LOCAL_MODEL.split('/').at(-1),
    });
  });
}
it('validates Strands TOML, derives independent interaction, and rejects unsafe origins, authentication, and unsupported metadata', () => {
  expect(connection.question_interaction).toBe('independent');
  expect(parseConnections(source.replace('127.0.0.1', '[::1]'))).toHaveLength(
    1,
  );
  for (const invalid of [
    source.replace('127.0.0.1', 'localhost'),
    source.replace('127.0.0.1', '192.168.1.2'),
    source.replace('http://127.0.0.1:8012', 'https://example.com'),
    source.replace('/v1/systemone', '/other'),
    source + '\napi_key_env="LOCAL_KEY"',
    source + '\nquestion_interaction="joint"',
    source.replace(LOCAL_MODEL, 'invalid/model/name'),
    source + '\ntimeout_ms=NaN',
  ])
    expect(() => parseConnections(invalid)).toThrow();
});
it('loads only TOML connections and rejects invalid or missing explicit files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strands-config-'));
  vi.stubEnv('LOCAL_DECISION_BASE_URL', 'http://127.0.0.1:8000');
  try {
    const path = join(dir, 'systemone.toml');
    writeFileSync(path, source);
    expect(loadConnections(path)).toEqual([connection]);
    writeFileSync(path, 'version = 1\nconnections = []');
    expect(loadConnections(path)).toEqual([]);
    writeFileSync(path, 'version = 99\nsecret="private-value"');
    expect(() => loadConnections(path)).toThrow('Invalid or unreadable');
    expect(() => loadConnections(join(dir, 'missing.toml'))).toThrow(
      'Invalid or unreadable',
    );
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('supports arbitrary Strands IDs with shared capabilities, model locking, blind persistence and legacy history', async () => {
  const store = new Store(':memory:');
  const f = fetcher(),
    cloud = vi.fn();
  const p = createConnectionProvider(
    validateConnection({ ...connection, id: 'python-a' }),
    { TYPESAFE_API_KEY: 'cloud-secret' },
    f,
  );
  const otherFetch = fetcher();
  const other = createConnectionProvider(
    validateConnection({
      ...connection,
      id: 'python-b',
      endpoint: 'http://127.0.0.1:8000/v1/systemone',
    }),
    {},
    otherFetch,
  );
  const app = createApp(store, { evaluate: cloud }, false, [p, other]);
  const req = (path: string, body?: unknown) =>
    app.request(`/api/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    const config = await (await req('config')).json();
    expect(config.providers).not.toHaveProperty('strands-local');
    expect(config.providers).toHaveProperty('python-b');
    expect(config.providers['python-a']).toMatchObject({
      adapter: 'strands',
      configured: true,
      modelEditable: false,
      healthCheck: true,
      questionInteraction: 'independent',
    });
    expect(await (await req('providers/python-a/health')).json()).toMatchObject(
      { status: 'ready', device: 'mps' },
    );
    expect(
      (
        await req('runs', {
          title: 'Mismatch',
          query: initialQuery,
          provider: 'python-a',
        })
      ).status,
    ).toBe(422);
    expect(f.mock.calls.every((c) => !c[1]?.body)).toBe(true);
    const query = { ...initialQuery, model: LOCAL_MODEL };
    const blind = await (
      await req('runs', {
        title: 'New',
        query,
        provider: 'python-a',
        blind: true,
      })
    ).json();
    expect(JSON.stringify(blind)).not.toMatch(
      /probabilities|checkpoint|rawResponse/,
    );
    expect(store.getRun(blind.run.id).execution).toMatchObject({
      formatVersion: 2,
      provider: 'python-a',
      adapter: 'strands',
      device: 'mps',
      label: connection.label,
    });
    for (const call of f.mock.calls) {
      expect(call[1]?.headers ?? {}).not.toHaveProperty('Authorization');
      expect(call[1]?.redirect).toBe('error');
    }
    expect(JSON.stringify(f.mock.calls)).not.toContain('cloud-secret');
    const old = store.saveRun(
      {
        title: 'Legacy',
        query,
        response: validateResponse(
          { ...fixture, model: LOCAL_MODEL.split('/').at(-1) },
          query,
        ),
        createdAt: '2026-10-04',
        elapsedMs: 1,
      },
      store.actor(),
      true,
      {
        formatVersion: 1,
        provider: 'strands-local',
        requestedModel: LOCAL_MODEL,
        artifactRevision: null,
        device: 'mps',
      },
    );
    expect(store.getRun(old.id).execution?.formatVersion).toBe(1);
    expect((await req(`runs/${old.id}/labeling`)).status).toBe(200);
    expect(
      (
        await req('runs', {
          title: 'Removed',
          query,
          provider: 'strands-local',
        })
      ).status,
    ).toBe(503);
    expect(cloud).not.toHaveBeenCalled();
    expect(otherFetch).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});
it('executes and exports Suites through the Strands connection registry without exposing blind answers', async () => {
  const store = new Store(':memory:'),
    f = fetcher(),
    cloud = vi.fn();
  const app = createApp(store, { evaluate: cloud }, false, [
    createConnectionProvider(connection, {}, f),
  ]);
  const req = (path: string, body?: unknown) =>
    app.request(`/api/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    const imported = await (
      await req('exchange/import', {
        documents: [exampleDefinition, exampleSuite].map((d) => ({
          source: serializeDocument(d, 'yaml'),
          format: 'yaml',
        })),
      })
    ).json();
    const id = imported.find(
      (d: { kind: string }) => d.kind === 'experiment-suite',
    ).id;
    const initial = await (
      await req(`suites/${id}/execute`, {
        provider: 'strands-local',
        model: LOCAL_MODEL,
      })
    ).json();
    await vi.waitFor(() =>
      expect(store.getSuiteExecution(initial.id).status).toBe('completed'),
    );
    expect(
      JSON.stringify(
        await (await req(`suite-executions/${initial.id}`)).json(),
      ),
    ).not.toMatch(/probabilities|rawResponse|grading/);
    expect(
      (
        await req(`suite-executions/${initial.id}/results`, {
          source: 'expected',
        })
      ).status,
    ).toBe(403);
    for (const item of store.getSuiteExecution(initial.id).cases)
      store.reveal(item.runId!, store.actor());
    const results = await (
      await req(`suite-executions/${initial.id}/results`, {
        source: 'expected',
      })
    ).json();
    expect(results.execution).toMatchObject({
      provider: 'strands-local',
      metadata: { formatVersion: 2, adapter: 'strands' },
      questionInteraction: 'independent',
    });
    expect(results.results).toHaveLength(2);
    expect(cloud).not.toHaveBeenCalled();
    expect(f.mock.calls.filter((c) => c[1]?.body)).toHaveLength(2);
  } finally {
    store.close();
  }
});
