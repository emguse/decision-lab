import { z } from 'zod';
import { validateResponse, type Query } from '../shared/schema.js';
import { LOCAL_MODEL, type ProviderHealth } from '../shared/providers.js';
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
    throw new Error('LOCAL_DECISION_BASE_URL must be an HTTP loopback origin');
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
    readonly model = LOCAL_MODEL,
    private fetcher: typeof fetch = fetch,
    private timeoutMs = 60000,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000)
      throw new Error('LOCAL_DECISION_TIMEOUT_MS must be 100–600000');
    if (
      model.length > 128 ||
      !/^(?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(model)
    )
      throw new Error('LOCAL_DECISION_MODEL must be a model ID');
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
        'LOCAL_DECISION_BASE_URL をサーバー側に設定してください。',
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
          ? 'ローカル推論がタイムアウトしました。Python側で処理が続く可能性があります。'
          : 'ローカルPythonサーバーに接続できません。起動とポートを確認してください。',
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
        'ローカルモデルはPythonサーバー起動時に指定します。設定されたモデルIDを使ってください。',
      );
    for (const q of Object.values(query.questions)) {
      if (q.type === 'choice' && Object.keys(q.criteria).length < 2)
        throw new ProviderError(
          422,
          'local_capability',
          'ローカル Choice は2個以上の選択肢が必要です。',
        );
      if (q.type === 'score' && q.criteria.some((v) => typeof v !== 'string'))
        throw new ProviderError(
          422,
          'local_capability',
          '現在の Strands ランタイムでは Score の各基準を文字列にしてください。',
        );
    }
    const health = await this.health();
    if (health.status !== 'ready')
      throw new ProviderError(
        503,
        `local_${health.status}`,
        health.status === 'mismatch'
          ? 'Pythonサーバーのモデルと LOCAL_DECISION_MODEL が一致しません。'
          : 'ローカルPythonサーバーの接続設定と起動を確認してください。',
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
          ? '接続中のPythonランタイムは構造化・nullの基準説明に対応していません。基準を文字列にするか、対応版へ更新してください。入力は保持されています。'
          : response.status === 422
            ? 'ローカルサーバーが入力を拒否しました。入力の長さ・形式とランタイムの対応範囲を確認してください。'
            : 'ローカル推論に失敗しました。Pythonサーバーのメモリーと状態を確認してください。',
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
        'ローカルサーバーから想定外のレスポンスが返りました。',
      );
    }
  }
}
