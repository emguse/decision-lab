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
  evaluate(query: Query): Promise<DecisionResponse>;
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
        'TYPESAFE_API_KEY をサーバー側に設定してください。',
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
          ? 'Jev API がタイムアウトしました。'
          : 'Jev API に接続できませんでした。',
      );
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'Jev API キーが無効です。',
        403: 'Jev API へのアクセスが拒否されました。',
        422: 'Jev API が入力を受け付けませんでした。',
        429: 'レート制限に達しました。時間をおいて再実行してください。',
        529: 'Jev API が混雑しています。',
      };
      throw new ProviderError(
        response.status === 429 ? 429 : 502,
        `upstream_${response.status}`,
        messages[response.status] ?? `Jev API エラー (${response.status})`,
      );
    }
    try {
      return validateResponse(await response.json(), query);
    } catch {
      throw new ProviderError(
        502,
        'invalid_response',
        'Jev API から想定外のレスポンスが返りました。',
      );
    }
  }
}
