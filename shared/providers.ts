import { z } from 'zod';
export const providerIdSchema = z.enum(['jev', 'strands-local']);
export type ProviderId = z.infer<typeof providerIdSchema>;
export const LOCAL_MODEL = 'StrandsAgents/strands-decider-2B-hobson-v19';
export interface ProviderHealth {
  status: 'unconfigured' | 'unreachable' | 'ready' | 'mismatch';
  model?: string;
  baseModel?: string;
  device?: string;
  maxLength?: number;
}
export const executionMetadataSchema = z.object({
  formatVersion: z.literal(1),
  provider: providerIdSchema,
  requestedModel: z.string(),
  resolvedModel: z.string().optional(),
  device: z.string().optional(),
  baseModel: z.string().optional(),
  artifactRevision: z.string().nullable().default(null),
});
export type ExecutionMetadata = z.infer<typeof executionMetadataSchema>;
export interface ProviderConfig {
  configured: boolean;
  model: string;
}
export interface AppConfig {
  configured: boolean;
  providers: Record<ProviderId, ProviderConfig>;
}
