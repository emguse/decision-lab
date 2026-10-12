import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { validateImage, MAX_IMAGE_BYTES } from '../server/images';
import { Store } from '../server/store';
import { createApp } from '../server/app';
import { StrandsProvider } from '../server/connection-providers';
import { validateConnection } from '../server/connections';
import { JevProvider } from '../server/provider';
import { SystemOneProvider } from '../server/systemone-provider';
import { requestSchema, initialQuery } from '../shared/schema';
import { fixture } from './fixture';
const model = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';
const connection = validateConnection({
  id: 'vision',
  label: 'Vision',
  adapter: 'strands',
  model,
  endpoint: 'http://127.0.0.1:8012/v1/systemone',
});
async function png(width = 2, height = 2) {
  return sharp({
    create: { width, height, channels: 3, background: '#ff0000' },
  })
    .png()
    .toBuffer();
}
async function context(vision?: boolean, status = 200, clef = false) {
  const store = new Store(':memory:');
  const sent: Record<string, unknown>[] = [];
  const headers: HeadersInit[] = [];
  const configuredModel = clef ? 'clef' : model;
  const fetcher: typeof fetch = async (url, init) => {
    headers.push(init?.headers ?? {});
    if (String(url).endsWith('/v1/models'))
      return Response.json({
        data: [
          {
            id: configuredModel,
            architecture: {
              input_modalities: vision ? ['text', 'image'] : ['text'],
              output_modalities: ['decisions'],
            },
          },
        ],
      });
    if (String(url).endsWith('/health'))
      return Response.json({
        status: 'ok',
        model: model.split('/').at(-1),
        device: 'cpu',
        base_model: 'Qwen/Qwen3.5-2B-Base',
        max_length: 4096,
        ...(vision === undefined ? {} : { vision }),
      });
    sent.push(JSON.parse(String(init?.body)));
    return Response.json(
      { ...fixture, model: configuredModel.split('/').at(-1) },
      { status },
    );
  };
  const provider = clef
    ? new SystemOneProvider(
        validateConnection({
          ...connection,
          adapter: 'llamacpp',
          model: configuredModel,
          question_interaction: 'joint',
        }),
        undefined,
        fetcher,
      )
    : new StrandsProvider(connection, fetcher);
  const app = createApp(
    store,
    {
      evaluate: async () => {
        throw new Error('Cloud must not run');
      },
    },
    true,
    [provider],
  );
  const bytes = await png();
  const image = store.saveImage(
    bytes,
    await validateImage(bytes),
    store.actor(),
  );
  const query = {
    ...initialQuery,
    model: configuredModel,
    imageIds: [image.id],
    state: '',
  };
  const post = (path: string, body: unknown) =>
    app.request(`http://127.0.0.1:8787/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { store, app, sent, headers, image, query, post };
}
describe('image validation', () => {
  it.each(['png', 'jpeg', 'webp'] as const)(
    'detects %s from bytes and retains dimensions',
    async (format) => {
      const bytes = await sharp(await png())
        .toFormat(format)
        .toBuffer();
      expect(await validateImage(bytes)).toMatchObject({
        mime: `image/${format}`,
        width: 2,
        height: 2,
        bytes: bytes.length,
      });
    },
  );
  it('accepts the dimension boundary and rejects oversized, corrupt, SVG and GIF inputs', async () => {
    expect((await validateImage(await png(4096, 1))).width).toBe(4096);
    for (const bytes of [
      await png(4097, 1),
      Buffer.from('broken'),
      Buffer.from('<svg width="2" height="2"></svg>'),
      await sharp(await png())
        .gif()
        .toBuffer(),
      Buffer.alloc(MAX_IMAGE_BYTES + 1),
      (await png()).subarray(0, 40),
    ])
      await expect(validateImage(bytes)).rejects.toThrow();
  });
  it('rejects animated WebP and PNG', async () => {
    const raw = Buffer.alloc(2 * 2 * 3 * 2, 255);
    raw.fill(0, 0, 2 * 2 * 3);
    for (const format of ['webp'] as const) {
      const animated = await sharp(raw, {
        raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
      })
        .toFormat(format, { loop: 0, delay: [100, 100] })
        .toBuffer();
      expect((await sharp(animated).metadata()).pages).toBe(2);
      await expect(validateImage(animated)).rejects.toThrow();
    }
    const original = await png();
    const control = Buffer.alloc(20);
    control.writeUInt32BE(8, 0);
    control.write('acTL', 4);
    control.writeUInt32BE(2, 8);
    await expect(
      validateImage(
        Buffer.concat([
          original.subarray(0, 33),
          control,
          original.subarray(33),
        ]),
      ),
    ).rejects.toThrow();
  });
  it('validates image ID type and count without changing legacy queries', () => {
    expect(requestSchema.parse(initialQuery)).toEqual(initialQuery);
    expect(
      requestSchema.safeParse({
        ...initialQuery,
        imageIds: Array.from({ length: 5 }, randomUUID),
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        ...initialQuery,
        imageIds: ['https://example.com/a.png'],
      }).success,
    ).toBe(false);
    expect(
      requestSchema.parse({
        ...initialQuery,
        imageIds: Array.from({ length: 4 }, randomUUID),
      }).imageIds,
    ).toHaveLength(4);
  });
});
describe('image API and inference', () => {
  it('uploads original bytes, deduplicates, retrieves without exposing answers, and keeps JSON body limits', async () => {
    const c = await context(true);
    try {
      expect(
        (await c.post('images', { url: 'https://example.com/image.png' }))
          .status,
      ).toBe(400);
      const bytes = await png();
      const form = new FormData();
      form.append(
        'file',
        new File([new Uint8Array(bytes)], 'misleading.jpg', {
          type: 'image/jpeg',
        }),
      );
      const upload = await c.app.request('/api/images', {
        method: 'POST',
        body: form,
      });
      expect(upload.status).toBe(201);
      const info = await upload.json();
      expect(info).toMatchObject({
        id: c.image.id,
        mime: 'image/png',
        bytes: bytes.length,
      });
      const response = await c.app.request(`/api/images/${info.id}`);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(c.sent).toHaveLength(0);
      expect(
        (
          await c.app.request('/api/images', {
            method: 'POST',
            body: new FormData(),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await c.post('experiments', {
            title: 'Huge',
            query: { ...initialQuery, state: 'a'.repeat(1024 * 1024) },
          })
        ).status,
      ).toBe(413);
      expect(
        (
          await c.app.request('/api/images', {
            method: 'POST',
            body: new Uint8Array(6 * 1024 * 1024 + 1),
          })
        ).status,
      ).toBe(413);
    } finally {
      c.store.close();
    }
  });
  it.each([false, true])(
    'forwards ordered images with no app fields or credentials and preserves blind projections (Clef=%s)',
    async (clef) => {
      const c = await context(true, 200, clef);
      try {
        const bytes = await png(3, 1);
        const second = c.store.saveImage(
          bytes,
          await validateImage(bytes),
          c.store.actor(),
        );
        c.query.imageIds = [second.id, c.image.id];
        const response = await c.post('runs', {
          title: 'Image run',
          query: c.query,
          provider: 'vision',
          blind: true,
        });
        expect(response.status).toBe(201);
        const body = await response.json();
        expect(body.run.query.imageIds).toEqual(c.query.imageIds);
        for (const field of ['response', 'rawResponse', 'execution'])
          expect(body.run).not.toHaveProperty(field);
        expect(c.sent[0]).not.toHaveProperty('imageIds');
        expect(c.sent[0].images).toEqual(
          c.store
            .resolveImages(c.query.imageIds)
            .map(
              (image) =>
                `data:${image.mime};base64,${image.data.toString('base64')}`,
            ),
        );
        expect(
          c.headers.every((h) => !new Headers(h).has('Authorization')),
        ).toBe(true);
        const user = c.store.addUser('Another evaluator');
        const projected = c.store.labeling(body.run.id, user.id);
        await c.app.request(`/api/images/${c.image.id}`, {
          headers: { 'X-Local-User': user.id },
        });
        expect(c.store.exposure(body.run.id, user.id)).toBe('blind');
        expect(projected.run).not.toHaveProperty('response');
        expect(c.store.listExperiments()).toEqual([]);
        expect(JSON.stringify(c.store.listSummaries(user.id))).not.toContain(
          'base64',
        );
      } finally {
        c.store.close();
      }
    },
  );
  it.each([false, undefined])(
    'refuses images when vision=%s without an inference call',
    async (vision) => {
      const c = await context(vision);
      try {
        expect(
          (
            await c.post('runs', {
              title: 'Unsupported',
              query: c.query,
              provider: 'vision',
            })
          ).status,
        ).toBe(422);
        expect(c.sent).toHaveLength(0);
      } finally {
        c.store.close();
      }
    },
  );
  it('refuses images for cloud connections and missing references before inference', async () => {
    const c = await context(true);
    try {
      expect(
        (
          await c.post('runs', {
            title: 'Cloud',
            query: c.query,
            provider: 'jev',
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await c.post('runs', {
            title: 'Missing',
            query: { ...c.query, imageIds: [randomUUID()] },
            provider: 'vision',
          })
        ).status,
      ).toBe(404);
      expect(c.sent).toHaveLength(0);
      const input = {
        ...initialQuery,
        images: [{ mime: 'image/png', data: Buffer.from('image') }],
      };
      await expect(
        new JevProvider('unused', async () => {
          throw new Error('Must not fetch');
        }).evaluate(input),
      ).rejects.toMatchObject({ code: 'images_unsupported' });
      await expect(
        new SystemOneProvider(
          validateConnection({
            ...connection,
            id: 'other',
            adapter: 'systemone',
          }),
          undefined,
          async () => {
            throw new Error('Must not fetch');
          },
        ).evaluate(input),
      ).rejects.toMatchObject({ code: 'images_unsupported' });
    } finally {
      c.store.close();
    }
  });
  it('saves an experiment without inference and rolls back records with missing images', async () => {
    const c = await context(true);
    try {
      expect(
        (
          await c.post('experiments', {
            title: 'Saved',
            query: c.query,
            provider: 'vision',
          })
        ).status,
      ).toBe(201);
      expect(c.store.listExperiments()[0].query.imageIds).toEqual(
        c.query.imageIds,
      );
      expect(
        (
          await c.post('experiments', {
            title: 'Missing',
            query: { ...c.query, imageIds: [randomUUID()] },
            provider: 'vision',
          })
        ).status,
      ).toBe(404);
      expect(c.store.listExperiments()).toHaveLength(1);
      expect(c.sent).toHaveLength(0);
    } finally {
      c.store.close();
    }
  });
  it.each([
    [400, true],
    [422, true],
    [501, true],
    [422, false],
  ] as const)(
    'preserves images and saves no run on upstream failure %s (Clef=%s)',
    async (status, clef) => {
      const c = await context(true, status, clef);
      try {
        expect(
          (
            await c.post('runs', {
              title: 'Failed',
              query: c.query,
              provider: 'vision',
            })
          ).status,
        ).toBe(status === 501 ? 502 : 422);
        expect(c.store.listSummaries(c.store.actor())).toEqual([]);
        expect(c.store.getImage(c.image.id).bytes).toBeGreaterThan(0);
      } finally {
        c.store.close();
      }
    },
  );
});
it('migrates schema 4, preserves JSON, restores backup, and cleans only expired unlinked images', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'image-db-'));
  const path = join(dir, 'db.sqlite');
  try {
    let store = await Store.open(path);
    const old = store.saveExperiment('Legacy', initialQuery);
    store.close();
    let db = new DatabaseSync(path);
    const legacy = db.prepare('SELECT body FROM experiments').get()!.body;
    db.exec(
      'DROP TABLE run_images; DROP TABLE experiment_images; DROP TABLE image_uploads; DROP TABLE image_blobs; PRAGMA user_version=4;',
    );
    db.close();
    store = await Store.open(path);
    const bytes = await png();
    const info = await validateImage(bytes);
    const image = store.saveImage(bytes, info, store.actor());
    store.saveExperiment('Linked', { ...initialQuery, imageIds: [image.id] });
    const otherBytes = await png(3, 2);
    const unlinked = store.saveImage(
      otherBytes,
      await validateImage(otherBytes),
      store.actor(),
    );
    store.cleanupImages(Date.now() + 8 * 86400000);
    expect(store.getImage(image.id).data).toEqual(bytes);
    expect(() => store.getImage(unlinked.id)).toThrow('Image was not found');
    const snapshot = join(dir, 'image-snapshot.sqlite');
    const snapshotSource = new DatabaseSync(path);
    await backup(snapshotSource, snapshot);
    snapshotSource.close();
    const restored = await Store.open(snapshot);
    expect(restored.getImage(image.id).data).toEqual(bytes);
    restored.close();
    store.close();
    store = await Store.open(path);
    expect(store.getImage(image.id).data).toEqual(bytes);
    store.close();
    db = new DatabaseSync(path);
    expect(
      db.prepare('SELECT body FROM experiments WHERE id=?').get(old.id)!.body,
    ).toBe(legacy);
    expect(
      db
        .prepare('SELECT format_version FROM attribution WHERE id=?')
        .get(old.id)!.format_version,
    ).toBe(1);
    expect(
      db
        .prepare('SELECT format_version FROM attribution WHERE id!=?')
        .all(old.id)
        .some((r) => r.format_version === 2),
    ).toBe(true);
    db.close();
    const migrationBackup = new DatabaseSync(
      join(
        dir,
        readdirSync(dir).find((f) => f.includes('backup-v4'))!,
      ),
    );
    expect(
      migrationBackup.prepare('PRAGMA user_version').get()!.user_version,
    ).toBe(4);
    expect(
      migrationBackup.prepare('SELECT body FROM experiments').get()!.body,
    ).toBe(legacy);
    migrationBackup.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
