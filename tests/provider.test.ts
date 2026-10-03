import { describe, it, expect, vi } from 'vitest';
import {
  initialQuery,
  requestSchema,
  validateResponse,
} from '../shared/schema';
import { JevProvider } from '../server/provider';
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
