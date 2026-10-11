import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { providerIdSchema } from '../shared/providers.js';
import { localBaseUrl } from './local-provider.js';

export function validateEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port === '0'
  )
    throw new Error('Invalid System One endpoint');
  if (url.protocol === 'http:') {
    const suffix = '/v1/systemone';
    if (!value.endsWith(suffix))
      throw new Error('Local endpoint must end with /v1/systemone');
    localBaseUrl(value.slice(0, -suffix.length));
  } else if (url.protocol !== 'https:')
    throw new Error('Use HTTPS or explicit loopback HTTP');
  return value;
}
const connectionSchema = z
  .object({
    id: providerIdSchema.refine((id) => id !== 'jev', 'Reserved connection ID'),
    label: z.string().trim().min(1).max(120),
    adapter: z.enum(['llamacpp', 'systemone', 'strands']),
    endpoint: z.string().transform(validateEndpoint),
    model: z.string().trim().min(1).max(128),
    api_key_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    timeout_ms: z.number().int().min(100).max(600000).default(60000),
    question_interaction: z
      .enum(['independent', 'joint', 'unknown'])
      .optional(),
  })
  .strict()
  .transform((v) => ({
    ...v,
    question_interaction:
      v.question_interaction ??
      (v.adapter === 'strands'
        ? ('independent' as const)
        : ('unknown' as const)),
  }))
  .superRefine((v, ctx) => {
    const url = new URL(v.endpoint);
    if (v.adapter === 'strands') {
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.pathname !== '/v1/systemone' ||
        v.api_key_env !== undefined
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Strands requires unauthenticated loopback HTTP at /v1/systemone',
        });
      if (!/^(?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(v.model))
        ctx.addIssue({ code: 'custom', message: 'Invalid Strands model ID' });
      if (v.question_interaction !== 'independent')
        ctx.addIssue({
          code: 'custom',
          message: 'Strands requires independent question interaction',
        });
    }
    if (v.adapter === 'llamacpp' && url.pathname !== '/v1/systemone')
      ctx.addIssue({
        code: 'custom',
        message: 'llamacpp requires /v1/systemone',
      });
    if (
      v.api_key_env === 'TYPESAFE_API_KEY' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Never send the Jev key locally',
      });
  });
const configSchema = z
  .object({ version: z.literal(1), connections: z.array(connectionSchema) })
  .strict()
  .refine(
    (v) =>
      new Set(v.connections.map((c) => c.id)).size === v.connections.length,
    'Duplicate connection ID',
  );
export type Connection = z.infer<typeof connectionSchema>;
export function validateConnection(value: unknown): Connection {
  return connectionSchema.parse(value);
}
export function parseConnections(source: string): Connection[] {
  return configSchema.parse(parse(source, { unsafeKeyBehaviour: 'throw' }))
    .connections;
}
export function loadConnections(
  path = process.env.SYSTEMONE_CONFIG_PATH,
): Connection[] {
  try {
    return parseConnections(readFileSync(path ?? 'systemone.toml', 'utf8'));
  } catch (error) {
    if (!path && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // Do not expose parser diagnostics containing source lines or URLs.
    throw new Error(
      'Invalid or unreadable System One configuration. Check the TOML file.',
    );
  }
}
