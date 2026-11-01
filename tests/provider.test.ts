import { describe, it, expect, vi } from 'vitest';
import {
  initialQuery,
  requestSchema,
  validateResponse,
  type DecisionImage,
} from '../shared/schema';
import { JevProvider, ProviderError, toJevWire } from '../server/provider';
import { LocalDecisionProvider } from '../server/local-provider';
import { SystemOneProvider } from '../server/systemone-provider';
import { validateConnection } from '../server/connections';
import { fixture } from './fixture';
describe('Jev contract', () => {
  it('accepts all three questions and structured descriptions', () => {
    expect(requestSchema.parse(initialQuery)).toEqual(initialQuery);
    expect(
      requestSchema.safeParse({
        ...initialQuery,
        state: { ticket: ['urgent'] },
      }).success,
    ).toBe(true);
  });
  it('rejects empty questions and invalid score criteria', () => {
    expect(
      requestSchema.safeParse({ ...initialQuery, questions: {} }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        ...initialQuery,
        questions: {
          x: { type: 'score', instructions: 'rate', criteria: ['one'] },
        },
      }).success,
    ).toBe(false);
  });
  it('validates answers against question IDs and options', () => {
    expect(validateResponse(fixture, initialQuery)).toEqual(fixture);
    expect(() =>
      validateResponse({ ...fixture, answers: {} }, initialQuery),
    ).toThrow();
    expect(() =>
      validateResponse(
        {
          ...fixture,
          answers: {
            ...fixture.answers,
            department: { ...fixture.answers.department, choice: 'missing' },
          },
        },
        initialQuery,
      ),
    ).toThrow();
  });
  it('preserves extension fields and raw numbers', () =>
    expect(
      validateResponse({ ...fixture, trace_id: 'test' }, initialQuery).trace_id,
    ).toBe('test'));
  it.each([401, 403, 422, 429, 529, 500])(
    'handles HTTP %s without retry or credential leakage',
    async (status) => {
      const fetcher = vi.fn(async () => new Response('secret-key', { status }));
      const provider = new JevProvider('secret-key', fetcher);
      await expect(provider.evaluate(initialQuery)).rejects.toMatchObject({
        code: `upstream_${status}`,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects missing credentials without network access', async () => {
    const fetcher = vi.fn();
    await expect(
      new JevProvider(undefined, fetcher).evaluate(initialQuery),
    ).rejects.toMatchObject({ code: 'not_configured' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('handles malformed JSON and mismatched answer types', async () => {
    await expect(
      new JevProvider('key', async () => new Response('invalid')).evaluate(
        initialQuery,
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('handles network and timeout errors', async () => {
    for (const [name, code] of [
      ['Error', 'network_error'],
      ['TimeoutError', 'timeout'],
    ]) {
      await expect(
        new JevProvider('key', async () => {
          throw new DOMException('failed', name);
        }).evaluate(initialQuery),
      ).rejects.toMatchObject({ code });
    }
  });
});
describe('Jev experimental images', () => {
  const png = (over: Partial<DecisionImage> = {}): DecisionImage => ({
    mime: 'image/png',
    width: 400,
    height: 300,
    data: Buffer.from('image-bytes'),
    ...over,
  });
  const enabled = (fetcher: typeof fetch) =>
    new JevProvider('secret-key', fetcher, 60000, { experimentalImages: true });
  const capture = (response: () => Response = () => Response.json(fixture)) => {
    const calls: { body: string; headers: Record<string, string> }[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      calls.push({
        body: String(init?.body),
        headers: init?.headers as Record<string, string>,
      });
      return response();
    };
    return { calls, fetcher };
  };
  const expectBinding = (wire: ReturnType<typeof toJevWire>) => {
    const { state, assets } = wire as unknown as {
      state: { images: string[] };
      assets: Record<string, unknown>;
    };
    expect(Object.keys(assets)).toEqual(state.images);
    return state;
  };
  it('binds ordered images to a documented state path for every state shape', () => {
    const images = [png(), png({ mime: 'image/jpeg' })];
    const text = expectBinding(
      toJevWire({ ...initialQuery, state: 'hello', images }),
    );
    expect(text).toMatchObject({ text: 'hello' });
    expect(text.images).toHaveLength(2);
    expect(
      expectBinding(
        toJevWire({ ...initialQuery, state: { ticket: 'a' }, images }),
      ),
    ).toMatchObject({ ticket: 'a' });
    expect(
      expectBinding(toJevWire({ ...initialQuery, state: ['a'], images })),
    ).toMatchObject({ items: ['a'] });
    const wire = toJevWire({ ...initialQuery, images }) as unknown as {
      state: { images: string[] };
      assets: Record<string, unknown>;
    };
    expect(wire.assets[wire.state.images[0]]).toEqual({
      type: 'image',
      format: 'png',
      data_base64: Buffer.from('image-bytes').toString('base64'),
    });
    expect(wire.assets[wire.state.images[1]]).toMatchObject({ format: 'jpg' });
    expect(wire).not.toHaveProperty('images');
  });
  it('refuses a conflicting images field instead of renaming it', () => {
    expect(() =>
      toJevWire({
        ...initialQuery,
        state: { images: 'mine' },
        images: [png()],
      }),
    ).toThrow(expect.objectContaining({ code: 'jev_state_conflict' }));
  });
  it('sends only documented fields, never application image IDs', async () => {
    const { calls, fetcher } = capture();
    const image = Object.assign(png(), { id: 'application-image-id' });
    const result = await enabled(fetcher).evaluate({
      ...initialQuery,
      images: [image],
    });
    expect(calls[0].body).not.toContain('application-image-id');
    expect(calls[0].headers['TypeSafe-Danger-Zone-Images']).toBe('true');
    expect(result.rawResponse).toEqual(fixture);
    expect(result).toMatchObject({
      executionInfo: { imageBinding: 'state.images/v1' },
    });
  });
  it('keeps text-only requests byte-identical without the header', async () => {
    const { calls, fetcher } = capture();
    const result = await enabled(fetcher).evaluate(initialQuery);
    expect(calls[0].body).toBe(JSON.stringify(initialQuery));
    expect(calls[0].headers).not.toHaveProperty('TypeSafe-Danger-Zone-Images');
    expect(result).not.toHaveProperty('rawResponse');
  });
  it('refuses images without opt-in and without network access', async () => {
    const fetcher = vi.fn();
    await expect(
      new JevProvider('key', fetcher).evaluate({
        ...initialQuery,
        images: [png()],
      }),
    ).rejects.toMatchObject({ code: 'images_unsupported', status: 422 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [{ width: 280, height: 280 }, true],
    [{ width: 1568, height: 1568 }, true],
    [{ width: 279, height: 400 }, false],
    [{ width: 400, height: 279 }, false],
    [{ width: 1569, height: 400 }, false],
  ])('checks dimensions %j', async (size, valid) => {
    const { calls, fetcher } = capture();
    const run = enabled(fetcher).evaluate({
      ...initialQuery,
      images: [png(size)],
    });
    if (valid) await expect(run).resolves.toBeDefined();
    else
      await expect(run).rejects.toMatchObject({ code: 'jev_image_dimensions' });
    expect(calls).toHaveLength(valid ? 1 : 0);
  });
  it('rejects formats and sizes Jev does not accept before sending', async () => {
    const { calls, fetcher } = capture();
    const provider = enabled(fetcher);
    await expect(
      provider.evaluate({
        ...initialQuery,
        images: [png({ mime: 'image/webp' })],
      }),
    ).rejects.toMatchObject({ code: 'jev_image_unsupported' });
    await expect(
      provider.evaluate({
        ...initialQuery,
        images: [png({ data: Buffer.alloc(16 * 1024 * 1024 + 1) })],
      }),
    ).rejects.toMatchObject({ code: 'jev_image_too_large', status: 413 });
    await expect(
      provider.evaluate({
        ...initialQuery,
        images: [1, 2, 3].map(() =>
          png({ data: Buffer.alloc(9 * 1024 * 1024) }),
        ),
      }),
    ).rejects.toMatchObject({ code: 'jev_request_too_large', status: 413 });
    expect(calls).toHaveLength(0);
  });
  it.each([
    [400, 422, 'detail echoing private state', 'rejected the request'],
    [400, 422, '{"detail":"max_tokens_exceeded"}', 'context length'],
    [413, 413, 'private state', 'size limit'],
  ])(
    'maps HTTP %i to %i without forwarding the body',
    async (upstream, status, body, message) => {
      const { fetcher } = capture(
        () => new Response(body, { status: upstream }),
      );
      const error = await enabled(fetcher)
        .evaluate({ ...initialQuery, images: [png()] })
        .catch((e: ProviderError) => e);
      expect(error).toMatchObject({ status, code: `upstream_${upstream}` });
      expect((error as ProviderError).message).toContain(message);
      expect((error as ProviderError).message).not.toContain('private');
    },
  );
});
describe('Jev Box questions', () => {
  const boxQuery = {
    model: 'jev-latest',
    state: 'A desk',
    questions: {
      present: {
        type: 'noul' as const,
        instructions: 'Is a mug in images[0]?',
      },
      mug: { type: 'box' as const, instructions: 'the mug in `images[0]`' },
    },
  };
  const box = { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 };
  const answer = (over: object = {}) => ({
    model: 'jev-1.14.0',
    answers: {
      present: { type: 'noul', noul: 0.9 },
      mug: { type: 'box', box, confidence: 0.92, ...over },
    },
    usage: { input_tokens: 290, output_tokens: 21 },
  });
  const image: DecisionImage = {
    mime: 'image/jpeg',
    width: 400,
    height: 300,
    data: Buffer.from('x'),
  };
  it('accepts a documented answer, including null confidence', () => {
    expect(validateResponse(answer(), boxQuery).answers.mug).toMatchObject({
      box,
    });
    expect(
      validateResponse(answer({ confidence: null }), boxQuery).answers.mug,
    ).toMatchObject({ confidence: null });
  });
  it.each([
    ['inverted horizontally', { ...box, left: 0.9 }],
    ['inverted vertically', { ...box, top: 0.9 }],
    ['zero width', { ...box, left: box.right }],
    ['out of range', { ...box, bottom: 1.2 }],
    ['missing edge', { top: 0.1, bottom: 0.2, left: 0.1 }],
  ])('rejects a box that is %s', (_name, value) => {
    expect(() => validateResponse(answer({ box: value }), boxQuery)).toThrow();
  });
  it('rejects an answer of another type and criteria on the question', () => {
    expect(() =>
      validateResponse(
        {
          ...answer(),
          answers: { ...answer().answers, mug: { type: 'noul', noul: 0.5 } },
        },
        boxQuery,
      ),
    ).toThrow();
    expect(
      requestSchema.safeParse({
        ...boxQuery,
        questions: {
          mug: { type: 'box', instructions: 'mug', criteria: ['a', 'b'] },
        },
      }).success,
    ).toBe(false);
  });
  it('sends the header and refuses without opt-in or exactly one image', async () => {
    const calls: RequestInit[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      calls.push(init!);
      return Response.json(answer());
    };
    const on = new JevProvider('key', fetcher, 60000, {
      experimentalImages: true,
    });
    const off = new JevProvider('key', fetcher);
    await expect(
      off.evaluate({ ...boxQuery, images: [image] }),
    ).rejects.toMatchObject({ code: 'images_unsupported' });
    await expect(off.evaluate(boxQuery)).rejects.toMatchObject({
      code: 'box_unsupported',
    });
    await expect(on.evaluate(boxQuery)).rejects.toMatchObject({
      code: 'box_image_count',
    });
    await expect(
      on.evaluate({ ...boxQuery, images: [image, image] }),
    ).rejects.toMatchObject({ code: 'box_image_count' });
    expect(calls).toHaveLength(0);
    const result = await on.evaluate({ ...boxQuery, images: [image] });
    expect(result.answers.mug).toMatchObject({ type: 'box', box });
    expect(
      (calls[0].headers as Record<string, string>)[
        'TypeSafe-Danger-Zone-Images'
      ],
    ).toBe('true');
  });
  it('rejects Box on every other adapter without network access', async () => {
    const fetcher = vi.fn();
    const input = { ...boxQuery, images: [image] };
    await expect(
      new LocalDecisionProvider(
        'http://127.0.0.1:8012',
        'jev-latest',
        fetcher,
      ).evaluate(input),
    ).rejects.toMatchObject({ code: 'box_unsupported' });
    for (const adapter of ['llamacpp', 'systemone'] as const)
      await expect(
        new SystemOneProvider(
          validateConnection({
            id: 'other',
            label: 'Other',
            adapter,
            model: 'jev-latest',
            endpoint: 'http://127.0.0.1:8012/v1/systemone',
          }),
          undefined,
          fetcher,
        ).evaluate(input),
      ).rejects.toMatchObject({ code: 'box_unsupported' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
