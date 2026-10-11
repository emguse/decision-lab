import { z } from 'zod';
import { validateResponse, type Query } from '../shared/schema.js';
import type { ProviderHealth } from '../shared/providers.js';
import { ProviderError, type DecisionProvider } from './provider.js';
export function localBaseUrl(value: string) {
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/.test(value))
    throw new Error('Use an explicit loopback HTTP origin');
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    url.port === '0'
  )
    throw new Error('Strands endpoint must be an HTTP loopback origin');
  return url.origin;
}
const healthSchema = z.object({
  status: z.literal('ok'),
  model: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.-]+$/),
  device: z.enum(['cpu', 'mps', 'cuda', 'mlx']),
  base_model: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  max_length: z.number().int().positive(),
});
export class LocalDecisionProvider implements DecisionProvider {
  readonly baseUrl?: string;
  constructor(
    url: string | undefined,
    readonly model: string,
    private fetcher: typeof fetch = fetch,
    private timeoutMs = 60000,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000)
      throw new Error('Strands timeout must be 100–600000');
    if (
      model.length > 128 ||
      !/^(?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(model)
    )
      throw new Error('Strands model must be a model ID');
    this.baseUrl = url ? localBaseUrl(url) : undefined;
  }
  get configured() {
    return Boolean(this.baseUrl);
  }
  private async fetch(path: string, init: RequestInit = {}) {
    if (!this.baseUrl)
      throw new ProviderError(
        503,
        'local_not_configured',
        'Configure a Strands connection in systemone.toml.',
      );
    try {
      return await this.fetcher(this.baseUrl + path, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(path === '/health' ? 3000 : this.timeoutMs),
      });
    } catch (e) {
      const timeout =
        e instanceof Error && ['TimeoutError', 'AbortError'].includes(e.name);
      throw new ProviderError(
        timeout ? 504 : 502,
        timeout ? 'local_timeout' : 'local_unreachable',
        timeout
          ? 'Local inference timed out. Processing may still be running in Python.'
          : 'Cannot reach the local Python service. Check its process and port.',
      );
    }
  }
  async health(): Promise<ProviderHealth> {
    if (!this.configured) return { status: 'unconfigured' };
    try {
      const response = await this.fetch('/health');
      if (!response.ok) return { status: 'unreachable' };
      const v = healthSchema.parse(await response.json());
      return {
        status: v.model === this.model.split('/').at(-1) ? 'ready' : 'mismatch',
        model: v.model,
        baseModel: v.base_model,
        device: v.device,
        maxLength: v.max_length,
      };
    } catch {
      return { status: 'unreachable' };
    }
  }
  async evaluate(query: Query) {
    if (query.model !== this.model)
      throw new ProviderError(
        422,
        'local_model_mismatch',
        'The Python service loads its model at startup. Use the configured model ID.',
      );
    for (const q of Object.values(query.questions)) {
      if (q.type === 'choice' && Object.keys(q.criteria).length < 2)
        throw new ProviderError(
          422,
          'local_capability',
          'Local Choice requires at least two options.',
        );
      if (q.type === 'score' && q.criteria.some((v) => typeof v !== 'string'))
        throw new ProviderError(
          422,
          'local_capability',
          'The current Strands runtime requires string descriptions for Score criteria.',
        );
    }
    const health = await this.health();
    if (health.status !== 'ready')
      throw new ProviderError(
        503,
        `local_${health.status}`,
        health.status === 'mismatch'
          ? 'The Python service model does not match the configured model ID.'
          : 'Check the local Python service configuration and process.',
      );
    const response = await this.fetch('/v1/systemone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
    });
    if (!response.ok) {
      let criteriaMismatch = false;
      if (response.status === 422) {
        try {
          const error = await response.json();
          criteriaMismatch =
            Array.isArray(error.detail) &&
            error.detail.some((v: unknown) => {
              const item = z
                .object({
                  type: z.string(),
                  loc: z.array(z.union([z.string(), z.number()])),
                })
                .safeParse(v);
              return (
                item.success &&
                item.data.type === 'string_type' &&
                item.data.loc.includes('criteria')
              );
            });
        } catch {
          /* Never forward an upstream error body. */
        }
      }
      throw new ProviderError(
        response.status === 422 ? 422 : 502,
        `local_upstream_${response.status}`,
        criteriaMismatch
          ? 'The connected Python runtime does not support structured or null criteria. Use string descriptions or a compatible runtime. Your input is retained.'
          : response.status === 422
            ? 'The local service rejected the input. Check its length, format, and runtime compatibility.'
            : 'Local inference failed. Check the Python service memory and status.',
      );
    }
    try {
      const raw = await response.json();
      // Preserve raw wire data; absent usage is represented as unavailable in normalized output.
      const normalized = validateResponse(
        { ...raw, usage: raw.usage ?? {} },
        query,
      );
      if (normalized.model !== health.model) throw new Error('Model changed');
      return {
        ...normalized,
        rawResponse: raw,
        executionInfo: { device: health.device, baseModel: health.baseModel },
      };
    } catch {
      throw new ProviderError(
        502,
        'local_invalid_response',
        'The local service returned an unexpected response.',
      );
    }
  }
}
