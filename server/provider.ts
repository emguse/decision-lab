import { randomUUID } from 'node:crypto';
import type { Connection } from './connections.js';
import type {
  ProviderConfig,
  ProviderHealth,
  ModelIdentity,
  ImageBinding,
} from '../shared/providers.js';
import {
  boxImageProblem,
  hasBoxQuestion,
  validateResponse,
  type DecisionImage,
  type DecisionInput,
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
export function boxUnsupported() {
  return new ProviderError(
    422,
    'box_unsupported',
    'This connection does not support Box questions.',
  );
}
export interface DecisionProvider {
  readonly capabilities?: { images?: boolean; box?: boolean };
  evaluate(query: DecisionInput): Promise<
    DecisionResponse & {
      rawResponse?: unknown;
      executionInfo?: {
        device?: string;
        baseModel?: string;
        modelArtifact?: string;
        modelIdentity?: ModelIdentity;
        imageBinding?: ImageBinding;
      };
    }
  >;
}
export interface ConfiguredDecisionProvider extends DecisionProvider {
  readonly connection: Connection;
  readonly config: ProviderConfig;
  health(): Promise<ProviderHealth>;
}
// Documented limits for the experimental image API; recheck on each Jev release.
const JEV_IMAGE_LIMITS = {
  minSide: 280,
  maxSide: 1568,
  minPixels: 78_400,
  maxPixels: 2_458_624,
  maxFileBytes: 16 * 1024 * 1024,
  maxBodyBytes: 32 * 1024 * 1024,
};
const JEV_IMAGE_FORMATS: Record<string, 'png' | 'jpg'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};
const JEV_IMAGE_BINDING: ImageBinding = 'state.images/v1';
function validateJevImage(image: DecisionImage, position: number) {
  const { minSide, maxSide, minPixels, maxPixels, maxFileBytes } =
    JEV_IMAGE_LIMITS;
  const label = `Image ${position + 1}`;
  if (!JEV_IMAGE_FORMATS[image.mime])
    throw new ProviderError(
      422,
      'jev_image_unsupported',
      `${label}: Jev accepts PNG or JPEG only.`,
    );
  if (image.data.length > maxFileBytes)
    throw new ProviderError(
      413,
      'jev_image_too_large',
      `${label}: Jev accepts files up to 16 MiB.`,
    );
  const pixels = image.width * image.height;
  if (
    image.width < minSide ||
    image.height < minSide ||
    image.width > maxSide ||
    image.height > maxSide ||
    pixels < minPixels ||
    pixels > maxPixels
  )
    throw new ProviderError(
      422,
      'jev_image_dimensions',
      `${label}: Jev requires ${minSide}–${maxSide} px per side and ${minPixels.toLocaleString('en-US')}–${maxPixels.toLocaleString('en-US')} total pixels. Images are not resized.`,
    );
}
/** Builds the System One request; only image requests differ from the query. */
export function toJevWire(query: DecisionInput) {
  const { images, ...text } = query;
  if (!images?.length) return text;
  images.forEach(validateJevImage);
  const { state } = text;
  if (
    typeof state === 'object' &&
    !Array.isArray(state) &&
    Object.hasOwn(state, 'images')
  )
    throw new ProviderError(
      422,
      'jev_state_conflict',
      'State already has an "images" field, which attached images use. Rename that field.',
    );
  const references = images.map(() => randomUUID());
  return {
    ...text,
    state:
      typeof state === 'string'
        ? { text: state, images: references }
        : Array.isArray(state)
          ? { items: state, images: references }
          : { ...state, images: references },
    assets: Object.fromEntries(
      images.map((image, index) => [
        references[index],
        {
          type: 'image',
          format: JEV_IMAGE_FORMATS[image.mime],
          data_base64: Buffer.from(image.data).toString('base64'),
        },
      ]),
    ),
  };
}
export class JevProvider implements DecisionProvider {
  readonly capabilities: { images: boolean; box: boolean };
  constructor(
    private key: string | undefined,
    private fetcher: typeof fetch = fetch,
    private timeoutMs = 60000,
    options: { experimentalImages?: boolean } = {},
  ) {
    const enabled = options.experimentalImages === true;
    this.capabilities = { images: enabled, box: enabled };
  }
  async evaluate(query: DecisionInput) {
    const box = hasBoxQuestion(query.questions);
    const experimental = box || Boolean(query.images?.length);
    if (query.images?.length && !this.capabilities.images)
      throw new ProviderError(
        422,
        'images_unsupported',
        'This connection does not support images.',
      );
    if (box && !this.capabilities.box) throw boxUnsupported();
    const boxProblem = boxImageProblem(
      query.questions,
      query.images?.length ?? 0,
    );
    if (boxProblem) throw new ProviderError(422, 'box_image_count', boxProblem);
    if (!this.key)
      throw new ProviderError(
        503,
        'not_configured',
        'Set TYPESAFE_API_KEY on the server.',
      );
    const body = JSON.stringify(toJevWire(query));
    if (experimental && Buffer.byteLength(body) > JEV_IMAGE_LIMITS.maxBodyBytes)
      throw new ProviderError(
        413,
        'jev_request_too_large',
        'The request exceeds the 32 MiB Jev limit. Use fewer or smaller images.',
      );
    let response: Response;
    try {
      response = await this.fetcher('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.key}`,
          'Content-Type': 'application/json',
          ...(experimental ? { 'TypeSafe-Danger-Zone-Images': 'true' } : {}),
        },
        body,
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
        400: 'The Jev API rejected the request. Check the input and any images.',
        401: 'The Jev API key is invalid.',
        403: 'Access to the Jev API was denied.',
        413: 'The request exceeds a Jev size limit. Use fewer or smaller images.',
        422: 'The Jev API rejected the input.',
        429: 'Rate limit reached. Wait before trying again.',
        529: 'The Jev API is busy.',
      };
      // The field holding this code is undocumented, so match the body text.
      // The body itself is never forwarded because it may echo the input.
      const tooLong =
        response.status === 400 &&
        (await response.text().catch(() => '')).includes('max_tokens_exceeded');
      throw new ProviderError(
        response.status === 429
          ? 429
          : response.status === 400
            ? 422
            : response.status === 413
              ? 413
              : 502,
        `upstream_${response.status}`,
        tooLong
          ? 'The images and text exceed the Jev context length. Shorten the input or use fewer images.'
          : (messages[response.status] ?? `Jev API error (${response.status})`),
      );
    }
    try {
      const raw: unknown = await response.json();
      const normalized = validateResponse(raw, query);
      return experimental
        ? {
            ...normalized,
            rawResponse: raw,
            executionInfo: { imageBinding: JEV_IMAGE_BINDING },
          }
        : normalized;
    } catch {
      throw new ProviderError(
        502,
        'invalid_response',
        'The Jev API returned an unexpected response.',
      );
    }
  }
}
