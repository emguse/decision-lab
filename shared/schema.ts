import { z } from 'zod';
import type { ExecutionMetadata } from './providers.js';
const content = z.union([
  z.string(),
  z.record(z.string(), z.json()),
  z.array(z.json()),
]);
const name = z.string().trim().min(1).max(128);
const common = { instructions: content };
export const questionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    ...common,
    criteria: z
      .object({ true: content.optional(), false: content.optional() })
      .optional(),
  }),
  z.object({
    type: z.literal('choice'),
    ...common,
    criteria: z
      .record(name, content.nullable())
      .refine(
        (v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 255,
        'Choice requires 1–255 options',
      ),
  }),
  z.object({
    type: z.literal('score'),
    ...common,
    criteria: z.array(content).min(2).max(10),
  }),
]);
export const requestSchema = z
  .object({
    model: name,
    state: content,
    questions: z
      .record(name, questionSchema)
      .refine((v) => Object.keys(v).length > 0, 'Add at least one question'),
  })
  .strict();
export type Query = z.infer<typeof requestSchema>;
export type Question = z.infer<typeof questionSchema>;
const probability = z.number().min(0).max(1);
const probabilities = z
  .record(z.string(), probability)
  .refine(
    (v) =>
      Object.keys(v).length > 0 &&
      Math.abs(Object.values(v).reduce((a, b) => a + b, 0) - 1) <= 0.03,
    'Invalid probability distribution',
  );
export const responseSchema = z
  .object({
    model: z.string(),
    answers: z.record(
      z.string(),
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('noul'), noul: probability }).passthrough(),
        z
          .object({
            type: z.literal('choice'),
            choice: z.string(),
            confidence: probability,
            probabilities,
          })
          .passthrough(),
        z
          .object({
            type: z.literal('score'),
            score: z.number().finite(),
            confidence: probability,
            probabilities,
            legend: z.record(z.string(), content),
          })
          .passthrough(),
      ]),
    ),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type DecisionResponse = z.infer<typeof responseSchema>;
export interface Run {
  id: string;
  title: string;
  createdAt: string;
  query: Query;
  response: DecisionResponse;
  elapsedMs: number;
  execution?: ExecutionMetadata;
  rawResponse?: unknown;
}
export const initialQuery: Query = {
  model: 'jev-latest',
  state: 'Help! My payouts have been failing for 3 days.',
  questions: {
    is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: {
        billing: 'Payments, invoicing, refunds',
        technical: 'Bugs, outages, integrations',
        sales: 'Pricing and upgrades',
      },
    },
    frustration: {
      type: 'score',
      instructions: 'How frustrated is the customer?',
      criteria: ['Calm', 'Frustrated', 'Very angry'],
    },
  },
};
export function validateResponse(raw: unknown, query: Query): DecisionResponse {
  const result = responseSchema.parse(raw);
  if (
    Object.keys(result.answers).length !== Object.keys(query.questions).length
  )
    throw new Error('Answer count mismatch');
  for (const [id, q] of Object.entries(query.questions)) {
    const a = result.answers[id];
    if (!a || a.type !== q.type) throw new Error('Answer type mismatch');
    if (a.type !== 'noul' && q.type !== 'noul') {
      const expected =
        q.type === 'choice'
          ? Object.keys(q.criteria)
          : q.criteria.map((_, i) => String(i));
      if (
        Object.keys(a.probabilities).length !== expected.length ||
        expected.some((k) => !(k in a.probabilities))
      )
        throw new Error('Option mismatch');
      if (a.type === 'choice' && !expected.includes(a.choice))
        throw new Error('Unknown choice');
      if (
        a.type === 'score' &&
        (a.score < 0 ||
          a.score > expected.length - 1 ||
          expected.some((k) => !(k in a.legend)))
      )
        throw new Error('Invalid score');
    }
  }
  return result;
}
