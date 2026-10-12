import { z } from 'zod';
import { basename } from 'node:path';
import { validateResponse, type DecisionInput } from '../shared/schema.js';
import type { ProviderHealth, ModelIdentity } from '../shared/providers.js';
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
              'Load the model in llama.cpp. Images require a compatible model and loaded multimodal projector on a direct server. The entire prompt, including images and all questions, must fit in --ubatch-size.',
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
                .object({
                  input_modalities: z.array(z.string()).optional(),
                  output_modalities: z.array(z.string()),
                })
                .optional(),
              status: z.unknown().optional(),
            }),
          ),
        })
        .parse(await models.json());
      const selected = list.data.find((m) => m.id === this.connection.model);
      const router = list.data.length !== 1 || selected?.status !== undefined;
      const vision =
        !router &&
        selected?.architecture?.input_modalities?.includes('image') === true;
      let modelArtifact: string | undefined;
      let modelIdentity: ModelIdentity | undefined;
      if (
        !router &&
        selected?.architecture?.output_modalities.includes('decisions')
      ) {
        // Optional display provenance; unavailable props must not block inference.
        try {
          const props = await this.request(origin + '/props', {}, 3000);
          if (props.ok) {
            const parsed = z
              .object({
                model_path: z.string().min(1).max(4096),
                model_alias: z.string().optional(),
              })
              .safeParse(await props.json());
            if (
              parsed.success &&
              (parsed.data.model_alias === undefined ||
                parsed.data.model_alias === selected.id)
            ) {
              const modelPath = parsed.data.model_path.replaceAll('\\', '/');
              const filename = basename(modelPath);
              if (filename && filename !== '.' && filename !== '..') {
                modelArtifact = filename;
                // Cache provenance is runtime-reported, not a verified weight hash.
                const cache = modelPath.match(
                  /(?:^|\/)models--([^/]+)\/snapshots\/([a-f0-9]{40,64})\/[^/]+$/,
                );
                const parts = cache?.[1].split('--');
                const repository =
                  parts &&
                  parts.length === 2 &&
                  parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))
                    ? parts.join('/')
                    : undefined;
                modelIdentity = {
                  name: repository ?? filename,
                  artifact: filename,
                  ...(repository ? { repositoryRevision: cache![2] } : {}),
                  source: 'llamacpp_props',
                };
              }
            }
          }
        } catch {
          /* Metadata is optional; never expose local paths or diagnostics. */
        }
      }
      return selected?.architecture?.output_modalities.includes('decisions')
        ? {
            status: 'ready',
            model: selected.id,
            ...(modelArtifact ? { modelArtifact } : {}),
            ...(modelIdentity ? { modelIdentity } : {}),
            // Router metadata can advertise images without a loaded projector.
            // Image inference is supported only on a fixed-model direct server.
            vision,
            ...(!vision
              ? {
                  imageBlockReason: router
                    ? ('router' as const)
                    : ('missing_image_capability' as const),
                }
              : {}),
          }
        : { status: 'mismatch' };
    } catch {
      return { status: 'unreachable' };
    }
  }
  async evaluate(query: DecisionInput) {
    let modelArtifact: string | undefined;
    let modelIdentity: ModelIdentity | undefined;
    if (query.images?.length && this.connection.adapter !== 'llamacpp')
      throw new ProviderError(
        422,
        'images_unsupported',
        'This connection does not support images.',
      );
    if (this.connection.adapter === 'llamacpp') {
      if (query.model !== this.connection.model)
        throw new ProviderError(
          422,
          'model_mismatch',
          'Use the configured model ID.',
        );
      const health = await this.health();
      modelArtifact = health.modelArtifact;
      modelIdentity = health.modelIdentity;
      if (health.status !== 'ready')
        throw new ProviderError(
          503,
          'model_unavailable',
          'Check the model and decision API compatibility.',
        );
      if (query.images?.length && health.vision !== true)
        throw new ProviderError(
          422,
          'images_unsupported',
          health.imageBlockReason === 'router'
            ? 'This app does not support image runs through llama.cpp router mode. Configure a fixed-model direct endpoint.'
            : 'The selected llama.cpp model did not advertise image input. Check the image-capable model and its matching --mmproj.',
        );
    }
    const { images, ...textInput } = query;
    const response = await this.request(this.connection.endpoint, {
      method: 'POST',
      body: JSON.stringify({
        ...textInput,
        ...(images?.length
          ? {
              images: images.map(
                (image) =>
                  `data:${image.mime};base64,${Buffer.from(image.data).toString('base64')}`,
              ),
            }
          : {}),
      }),
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
      return {
        ...normalized,
        rawResponse: raw,
        ...(modelArtifact
          ? { executionInfo: { modelArtifact, modelIdentity } }
          : {}),
      };
    } catch {
      throw new ProviderError(
        502,
        'invalid_response',
        'The connection returned an unexpected response.',
      );
    }
  }
}
