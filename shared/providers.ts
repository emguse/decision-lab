import { z } from 'zod';
export const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);
export type ProviderId = z.infer<typeof providerIdSchema>;
export const LOCAL_MODEL = 'StrandsAgents/strands-decider-2B-hobson-v19';
export interface ProviderHealth {
  status: 'unconfigured' | 'unreachable' | 'ready' | 'mismatch' | 'configured';
  model?: string;
  baseModel?: string;
  device?: string;
  maxLength?: number;
}
const metadata = {
  requestedModel: z.string(),
  resolvedModel: z.string().optional(),
  device: z.string().optional(),
  baseModel: z.string().optional(),
  artifactRevision: z.string().nullable().default(null),
};
export const executionMetadataSchema = z.discriminatedUnion('formatVersion', [
  z.object({
    ...metadata,
    formatVersion: z.literal(1),
    provider: z.enum(['jev', 'strands-local']),
  }),
  z.object({
    ...metadata,
    formatVersion: z.literal(2),
    provider: providerIdSchema,
    label: z.string(),
    adapter: z.enum(['llamacpp', 'systemone']),
    questionInteraction: z.enum(['independent', 'joint', 'unknown']),
  }),
]);
export type ExecutionMetadata = z.infer<typeof executionMetadataSchema>;
export interface ProviderConfig {
  configured: boolean;
  model: string;
  label?: string;
  modelEditable?: boolean;
  healthCheck?: boolean;
  questionInteraction?: 'independent' | 'joint' | 'unknown';
}
export interface AppConfig {
  configured: boolean;
  providers: Record<ProviderId, ProviderConfig>;
}
