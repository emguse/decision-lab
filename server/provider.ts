import type { Connection } from './connections.js';
import type { ProviderConfig, ProviderHealth } from '../shared/providers.js';
import {
  validateResponse,
  type Query,
  type DecisionResponse,
} from '../shared/schema.js';
export class ProviderError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface DecisionProvider {
  evaluate(query: Query): Promise<
    DecisionResponse & {
      rawResponse?: unknown;
      executionInfo?: { device?: string; baseModel?: string };
    }
  >;
}
export interface ConfiguredDecisionProvider extends DecisionProvider {
  readonly connection: Connection;
  readonly config: ProviderConfig;
  health(): Promise<ProviderHealth>;
}
export class JevProvider implements DecisionProvider {
  constructor(
    private key: string | undefined,
    private fetcher: typeof fetch = fetch,
    private timeoutMs = 60000,
  ) {}
  async evaluate(query: Query) {
    if (!this.key)
      throw new ProviderError(
        503,
        'not_configured',
        'Set TYPESAFE_API_KEY on the server.',
      );
    let response: Response;
    try {
      response = await this.fetcher('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timeout =
        error instanceof Error &&
        ['TimeoutError', 'AbortError'].includes(error.name);
      throw new ProviderError(
        timeout ? 504 : 502,
        timeout ? 'timeout' : 'network_error',
        timeout
          ? 'The Jev API timed out.'
          : 'Could not connect to the Jev API.',
      );
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'The Jev API key is invalid.',
        403: 'Access to the Jev API was denied.',
        422: 'The Jev API rejected the input.',
        429: 'Rate limit reached. Wait before trying again.',
        529: 'The Jev API is busy.',
      };
      throw new ProviderError(
        response.status === 429 ? 429 : 502,
        `upstream_${response.status}`,
        messages[response.status] ?? `Jev API error (${response.status})`,
      );
    }
    try {
      return validateResponse(await response.json(), query);
    } catch {
      throw new ProviderError(
        502,
        'invalid_response',
        'The Jev API returned an unexpected response.',
      );
    }
  }
}
