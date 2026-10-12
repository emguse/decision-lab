import { it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConnections, loadConnections } from '../server/connections';
import { SystemOneProvider } from '../server/systemone-provider';
import { createApp } from '../server/app';
import { Store } from '../server/store';
import { initialQuery, validateResponse } from '../shared/schema';
import { executionMetadataSchema } from '../shared/providers';
import { fixture } from './fixture';
import sharp from 'sharp';
import { validateImage } from '../server/images';
import { parse as parseYaml } from 'yaml';
import { serializeDocument } from '../shared/exchange';
const source = readFileSync('systemone.example.toml', 'utf8');
const connection = parseConnections(source)[0];
const query = {
  ...initialQuery,
  model: 'clef',
  state: { ticket: ['請求が重複しています'] },
};
const response = { ...fixture, model: 'clef' };
const remote = {
  ...connection,
  adapter: 'systemone' as const,
  endpoint: 'https://example.com/decision',
  api_key_env: 'CUSTOM_KEY',
};
function fetcher(answer: unknown = response) {
  return vi.fn<typeof fetch>(async (url) =>
    Response.json(
      String(url).endsWith('/health')
        ? { status: 'ok' }
        : String(url).endsWith('/v1/models')
          ? {
              data: [
                {
                  id: 'clef',
                  architecture: { output_modalities: ['decisions'] },
                },
              ],
            }
          : answer,
    ),
  );
}
it('loads opt-in TOML, validates security constraints, and omits configuration source from errors', () => {
  expect(connection.question_interaction).toBe('joint');
  expect(connection.timeout_ms).toBe(60000);
  for (const value of [
    source.replace('version = 1', 'version = 2'),
    source.replace('clef-local', 'jev'),
    source +
      '\n[[connections]]\nid="clef-local"\nlabel="Duplicate"\nadapter="systemone"\nendpoint="https://example.com/api"\nmodel="m"',
    source.replace('http://127.0.0.1:8080', 'http://localhost:8080'),
    source.replace('http://127.0.0.1:8080', 'http://192.168.1.1:8080'),
    source.replace('/v1/systemone"', '/other"'),
    source.replace('60000', '1'),
    source + '\napi_key_env="TYPESAFE_API_KEY"',
    source + '\nunknown="secret"',
    source.replace('http://127.0.0.1:8080', 'https://user:pass@example.com'),
    source.replace('/v1/systemone"', '/v1/systemone?secret=x"'),
  ])
    expect(() => parseConnections(value)).toThrow();
  expect(() => loadConnections('/not-present-secret.toml')).toThrow(
    'Invalid or unreadable',
  );
  expect(
    parseConnections(
      source.replace('http://127.0.0.1:8080', 'http://[::1]:8080'),
    ),
  ).toHaveLength(1);
  expect(
    parseConnections(
      source
        .replace('llamacpp', 'systemone')
        .replace(
          'http://127.0.0.1:8080/v1/systemone',
          'https://example.com/custom/path',
        ),
    ),
  ).toHaveLength(1);
});
it('checks native decision readiness, sends unchanged queries without cloud keys, and preserves raw usage', async () => {
  const f = fetcher({ ...response, usage: undefined });
  const p = new SystemOneProvider(connection, undefined, f);
  expect(await p.health()).toEqual({
    status: 'ready',
    model: 'clef',
    vision: false,
    imageBlockReason: 'missing_image_capability',
  });
  const result = await p.evaluate(query);
  expect(result.usage).toEqual({});
  expect(result.rawResponse).not.toHaveProperty('usage');
  const call = f.mock.calls.at(-1)!;
  expect(JSON.parse(String(call[1]!.body))).toEqual(query);
  expect(call[1]!.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(f.mock.calls.every((c) => c[1]?.redirect === 'error')).toBe(true);
  await expect(p.evaluate(initialQuery)).rejects.toMatchObject({
    code: 'model_mismatch',
  });
});
it('rejects missing model or non-decision metadata without running inference', async () => {
  for (const data of [
    [{ id: 'other', architecture: { output_modalities: ['decisions'] } }],
    [{ id: 'clef', architecture: { output_modalities: ['text'] } }],
    [{ id: 'clef' }],
  ]) {
    const f = vi.fn<typeof fetch>(async (url) =>
      Response.json(
        String(url).endsWith('/health') ? { status: 'ok' } : { data },
      ),
    );
    const p = new SystemOneProvider(connection, undefined, f);
    expect(await p.health()).toEqual({ status: 'mismatch' });
    await expect(p.evaluate(query)).rejects.toMatchObject({ status: 503 });
    expect(f.mock.calls.every((c) => !c[1]?.body)).toBe(true);
  }
});
it('keeps generic readiness distinct and supplies only its own Bearer key', async () => {
  const f = fetcher();
  const missing = new SystemOneProvider(remote, undefined, f);
  expect(await missing.health()).toEqual({ status: 'unconfigured' });
  await expect(missing.evaluate(query)).rejects.toMatchObject({ status: 503 });
  expect(f).not.toHaveBeenCalled();
  const p = new SystemOneProvider(remote, 'test-only-key', f);
  expect(await p.health()).toEqual({ status: 'configured' });
  expect(f).not.toHaveBeenCalled();
  await p.evaluate(query);
  expect(f.mock.calls[0][0]).toBe(remote.endpoint);
  expect(f.mock.calls[0][1]?.headers).toHaveProperty(
    'Authorization',
    'Bearer test-only-key',
  );
});
it('rejects invalid answers, redirects, upstream failures and timeout without retries', async () => {
  const c = { ...remote, api_key_env: undefined };
  for (const raw of [
    { ...response, model: 'wrong' },
    { ...response, answers: {} },
    { ...response, usage: null },
  ]) {
    const p = new SystemOneProvider(connection, undefined, fetcher(raw));
    await expect(p.evaluate(query)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  }
  for (const status of [302, 400, 401, 422, 429, 500]) {
    const f = vi.fn<typeof fetch>(
      async () => new Response('private error with credentials', { status }),
    );
    await expect(
      new SystemOneProvider(c, undefined, f).evaluate(query),
    ).rejects.toMatchObject({ code: `upstream_${status}` });
    expect(f).toHaveBeenCalledTimes(1);
  }
  for (const name of ['TimeoutError', 'TypeError']) {
    const f = vi.fn<typeof fetch>(async () => {
      const e = new Error('secret');
      e.name = name;
      throw e;
    });
    await expect(
      new SystemOneProvider(c, undefined, f).evaluate(query),
    ).rejects.toMatchObject({ status: name === 'TimeoutError' ? 504 : 502 });
    expect(f).toHaveBeenCalledTimes(1);
  }
});
it('persists format 2 across reopen and configuration removal; keeps each evaluator blind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'systemone-'));
  let store = await Store.open(join(dir, 'runs.sqlite'));
  try {
    const imageBytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#f00' },
    })
      .png()
      .toBuffer();
    const image = store.saveImage(
      imageBytes,
      await validateImage(imageBytes),
      store.actor(),
    );
    const imageQuery = { ...query, imageIds: [image.id] };
    const f = fetcher();
    const p = new SystemOneProvider(connection, undefined, async (url, init) =>
      String(url).endsWith('/v1/models')
        ? Response.json({
            data: [
              {
                id: 'clef',
                architecture: {
                  input_modalities: ['text', 'image'],
                  output_modalities: ['decisions'],
                },
              },
            ],
          })
        : String(url).endsWith('/props')
          ? Response.json({
              model_alias: 'clef',
              model_path:
                '/private/hub/models--ggml-org--Clef-Flash-GGUF/snapshots/6b4fe4c59098479652d94f0fe11a40facbebd1ec/Clef-Flash-Q4_K_M.gguf',
            })
          : f(url, init),
    );
    const cloud = vi.fn(async () => validateResponse(response, query));
    const app = createApp(store, { evaluate: cloud }, false, [p]);
    const send = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const config = JSON.stringify(
      await (await app.request('/api/config')).json(),
    );
    expect(config).toContain('clef-local');
    expect(config).not.toContain('endpoint');
    expect(config).not.toContain('api_key_env');
    const result = await send('/api/runs', {
      title: 'Clef',
      query: imageQuery,
      provider: connection.id,
      blind: true,
    });
    expect(result.status).toBe(201);
    const blind = await result.json();
    expect(JSON.stringify(blind)).not.toContain('probabilities');
    const id = blind.run.id;
    expect(store.getRun(id).execution).toMatchObject({
      formatVersion: 2,
      provider: connection.id,
      questionInteraction: 'joint',
      modelArtifact: 'Clef-Flash-Q4_K_M.gguf',
    });
    expect(store.getRun(id).rawResponse).toEqual(response);
    const other = store.addUser('Second evaluator');
    store.assign(id, other.id);
    store.reveal(id, store.actor());
    expect(JSON.stringify(store.labeling(id, other.id))).not.toContain(
      'probabilities',
    );
    await send('/api/experiments', {
      title: 'Saved',
      query: imageQuery,
      provider: connection.id,
    });
    expect(cloud).not.toHaveBeenCalled();
    store.close();
    store = await Store.open(join(dir, 'runs.sqlite'));
    expect(store.getRun(id).query).toEqual(imageQuery);
    expect(store.getRun(id).execution?.modelArtifact).toBe(
      'Clef-Flash-Q4_K_M.gguf',
    );
    const identity = {
      name: 'ggml-org/Clef-Flash-GGUF',
      artifact: 'Clef-Flash-Q4_K_M.gguf',
      repositoryRevision: '6b4fe4c59098479652d94f0fe11a40facbebd1ec',
      source: 'llamacpp_props',
    };
    const recorded = store.getRun(id).execution!;
    expect(recorded.modelIdentity).toEqual(identity);
    expect(recorded.requestedModel).toBe('clef');
    expect(recorded.resolvedModel).toBe('clef');
    for (const format of ['json', 'yaml'] as const) {
      const exported = serializeDocument(recorded, format);
      expect(exported).not.toContain('/private');
      expect(
        executionMetadataSchema.parse(
          format === 'json' ? JSON.parse(exported) : parseYaml(exported),
        ).modelIdentity,
      ).toEqual(identity);
    }
    expect(store.getImage(image.id).data).toEqual(imageBytes);
    expect(store.listExperiments()[0].query.imageIds).toEqual([image.id]);
    expect(store.listExperiments()[0].provider).toBe(connection.id);
    const removed = createApp(store, { evaluate: cloud }, false);
    expect(
      (
        await removed.request('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Removed',
            query,
            provider: connection.id,
          }),
        })
      ).status,
    ).toBe(503);
    expect(cloud).not.toHaveBeenCalled();
    expect(
      executionMetadataSchema.safeParse({
        ...store.getRun(id).execution,
        formatVersion: 99,
      }).success,
    ).toBe(false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

it('treats model-file metadata as optional, preserves aliases, and never exposes local paths', async () => {
  for (const props of [
    {
      model_path: '/private/models/Clef-Flash-Q4_K_M.gguf',
      model_alias: 'clef',
    },
    {
      model_path: 'C:\\private\\models\\Clef-Flash-Q4_K_M.gguf',
      model_alias: 'clef',
    },
    { model_path: '/private/models/other.gguf', model_alias: 'other' },
    { model_path: 123 },
    null,
  ]) {
    const f = fetcher();
    const p = new SystemOneProvider(connection, undefined, async (url, init) =>
      String(url).endsWith('/props') ? Response.json(props) : f(url, init),
    );
    const health = await p.health();
    expect(health.status).toBe('ready');
    expect(JSON.stringify(health)).not.toContain('private');
    const result = await p.evaluate(query);
    expect(result.model).toBe('clef');
    expect(result.rawResponse).toEqual(response);
    expect(JSON.parse(String(f.mock.calls.at(-1)?.[1]?.body)).model).toBe(
      'clef',
    );
    expect(result.executionInfo?.modelArtifact).toBe(
      props &&
        typeof props.model_path === 'string' &&
        props.model_alias === 'clef'
        ? 'Clef-Flash-Q4_K_M.gguf'
        : undefined,
    );
  }
  const f = fetcher();
  const p = new SystemOneProvider(connection, undefined, async (url, init) => {
    if (String(url).endsWith('/props'))
      throw new Error('Unavailable private path');
    return f(url, init);
  });
  expect((await p.health()).status).toBe('ready');
  expect((await p.evaluate(query)).model).toBe('clef');
});

it('preserves structured instructions and criteria, including native structured Score legends', async () => {
  const q = {
    ...query,
    questions: {
      ...query.questions,
      department: {
        type: 'choice' as const,
        instructions: { question: '担当部署' },
        criteria: {
          billing: null,
          technical: { scope: '技術' },
          sales: ['販売'],
        },
      },
      frustration: {
        type: 'score' as const,
        instructions: ['不満の程度'],
        criteria: [{ level: 'Calm' }, ['Frustrated'], 'Very angry'],
      },
    },
  };
  const raw = {
    ...response,
    answers: {
      ...response.answers,
      frustration: {
        ...response.answers.frustration,
        legend: {
          '0': { level: 'Calm' },
          '1': ['Frustrated'],
          '2': 'Very angry',
        },
      },
    },
  };
  const f = fetcher(raw);
  const result = await new SystemOneProvider(connection, undefined, f).evaluate(
    q,
  );
  expect(result.answers.frustration).toHaveProperty(
    'legend',
    raw.answers.frustration.legend,
  );
  expect(JSON.parse(String(f.mock.calls.at(-1)![1]?.body))).toEqual(q);
  expect(result.rawResponse).toEqual(raw);
});

it('rechecks image capability before each request and rejects router metadata, missing projectors and changed models', async () => {
  const imageInput = {
    ...query,
    images: [{ mime: 'image/png', data: new Uint8Array([1, 2, 3]) }],
  };
  const capable = {
    id: 'clef',
    architecture: {
      input_modalities: ['text', 'image'],
      output_modalities: ['decisions'],
    },
  };
  let data: unknown[] = [capable];
  let returnedModel = 'clef';
  const f = vi.fn<typeof fetch>(async (url) =>
    Response.json(
      String(url).endsWith('/health')
        ? { status: 'ok' }
        : String(url).endsWith('/v1/models')
          ? { data }
          : { ...response, model: returnedModel },
    ),
  );
  const p = new SystemOneProvider(connection, undefined, f);
  expect(await p.health()).toMatchObject({ status: 'ready', vision: true });
  await p.evaluate(imageInput);
  for (const models of [
    [{ id: 'clef', architecture: { output_modalities: ['decisions'] } }],
    [
      {
        ...capable,
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['decisions'],
        },
      },
    ],
    [{ ...capable, status: { value: 'unloaded' } }],
    [{ ...capable, status: { value: 'loaded' } }],
    [capable, { ...capable, id: 'other' }],
    [{ ...capable, id: 'other' }],
    [
      {
        ...capable,
        architecture: {
          input_modalities: ['image'],
          output_modalities: ['text'],
        },
      },
    ],
  ]) {
    data = models;
    f.mockClear();
    await expect(p.evaluate(imageInput)).rejects.toMatchObject({
      code: expect.stringMatching(/^(images_unsupported|model_unavailable)$/),
    });
    expect(f.mock.calls.every((call) => !call[1]?.body)).toBe(true);
  }
  data = [capable];
  returnedModel = 'changed';
  await expect(p.evaluate(imageInput)).rejects.toMatchObject({
    code: 'invalid_response',
  });
  await expect(
    p.evaluate({ ...imageInput, model: 'other' }),
  ).rejects.toMatchObject({ code: 'model_mismatch' });
});
