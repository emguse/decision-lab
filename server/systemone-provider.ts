import { z } from 'zod';
import { validateResponse, type Query } from '../shared/schema.js';
import type { ProviderHealth } from '../shared/providers.js';
import { ProviderError, type ConfiguredDecisionProvider } from './provider.js';
import type { Connection } from './connections.js';
export class SystemOneProvider implements ConfiguredDecisionProvider {
  readonly configured: boolean;
  constructor(
    readonly connection: Connection,
    private key?: string,
    private fetcher: typeof fetch = fetch,
  ) {
    if (connection.adapter === 'strands')
      throw new Error('Use the Strands adapter');
    this.configured = !connection.api_key_env || Boolean(key);
  }
  get config() {
    return {
      configured: this.configured,
      model: this.connection.model,
      adapter: this.connection.adapter,
      label: this.connection.label,
      modelEditable: this.connection.adapter === 'systemone',
      healthCheck: this.connection.adapter === 'llamacpp',
      questionInteraction: this.connection.question_interaction,
      ...(this.connection.adapter === 'llamacpp'
        ? {
            guidance:
              'Load the model in llama.cpp. The entire prompt must fit in the runtime batch.',
          }
        : {}),
    };
  }
  private async request(
    url: string,
    init: RequestInit = {},
    timeout = this.connection.timeout_ms,
  ) {
    if (!this.configured)
      throw new ProviderError(
        503,
        'not_configured',
        'Set connection credentials on the server.',
      );
    try {
      return await this.fetcher(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const timeout =
        error instanceof Error &&
        ['TimeoutError', 'AbortError'].includes(error.name);
      throw new ProviderError(
        timeout ? 504 : 502,
        timeout ? 'timeout' : 'network_error',
        timeout ? 'Connection timed out.' : 'Could not reach the connection.',
      );
    }
  }
  async health(): Promise<ProviderHealth> {
    if (!this.configured) return { status: 'unconfigured' };
    if (this.connection.adapter === 'systemone')
      return { status: 'configured' };
    try {
      const origin = new URL(this.connection.endpoint).origin;
      const health = await this.request(origin + '/health', {}, 3000);
      if (
        !health.ok ||
        !z.object({ status: z.literal('ok') }).safeParse(await health.json())
          .success
      )
        return { status: 'unreachable' };
      const models = await this.request(origin + '/v1/models', {}, 3000);
      if (!models.ok) return { status: 'unreachable' };
      const list = z
        .object({
          data: z.array(
            z.object({
              id: z.string(),
              architecture: z
                .object({ output_modalities: z.array(z.string()) })
                .optional(),
            }),
          ),
        })
        .parse(await models.json());
      const selected = list.data.find((m) => m.id === this.connection.model);
      return selected?.architecture?.output_modalities.includes('decisions')
        ? { status: 'ready', model: selected.id }
        : { status: 'mismatch' };
    } catch {
      return { status: 'unreachable' };
    }
  }
  async evaluate(query: Query) {
    if (this.connection.adapter === 'llamacpp') {
      if (query.model !== this.connection.model)
        throw new ProviderError(
          422,
          'model_mismatch',
          'Use the configured model ID.',
        );
      const health = await this.health();
      if (health.status !== 'ready')
        throw new ProviderError(
          503,
          'model_unavailable',
          'Check the model and decision API compatibility.',
        );
    }
    const response = await this.request(this.connection.endpoint, {
      method: 'POST',
      body: JSON.stringify(query),
    });
    if (!response.ok)
      throw new ProviderError(
        response.status === 429
          ? 429
          : [400, 422].includes(response.status)
            ? 422
            : 502,
        `upstream_${response.status}`,
        `The connection rejected the request (${response.status})。`,
      );
    try {
      const raw: unknown = await response.json();
      const object = z.record(z.string(), z.unknown()).parse(raw);
      const normalized = validateResponse(
        { ...object, usage: object.usage === undefined ? {} : object.usage },
        query,
      );
      if (
        this.connection.adapter === 'llamacpp' &&
        normalized.model !== query.model
      )
        throw new Error('Model changed');
      return { ...normalized, rawResponse: raw };
    } catch {
      throw new ProviderError(
        502,
        'invalid_response',
        'The connection returned an unexpected response.',
      );
    }
  }
}
