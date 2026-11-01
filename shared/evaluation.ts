import { z } from 'zod';
import type { Query, Run } from './schema.js';
export const labelsSchema = z.record(
  z.string(),
  z.union([z.boolean(), z.string(), z.number().int()]),
);
export const settingsSchema = z.object({
  threshold: z.number().min(0).max(1).default(0.5),
  tolerance: z.number().nonnegative().finite().default(0.5),
});
export const draftSchema = z.object({
  labels: labelsSchema,
  note: z.string().max(4000).default(''),
  settings: settingsSchema.default({ threshold: 0.5, tolerance: 0.5 }),
});
export type Labels = z.infer<typeof labelsSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Draft = z.infer<typeof draftSchema>;
export const boxReviewInputSchema = z
  .object({
    question: z.string(),
    verdict: z.enum(['correct', 'incorrect']),
    note: z.string().max(4000).default(''),
  })
  .strict();
export type BoxReviewInput = z.infer<typeof boxReviewInputSchema>;
export interface BoxReview extends BoxReviewInput {
  id: string;
  runId: string;
  userId: string;
  createdAt: string;
}
export interface LocalUser {
  id: string;
  name: string;
  kind: 'local' | 'legacy';
}
export interface Revision extends Draft {
  id: string;
  runId: string;
  userId: string;
  createdAt: string;
  exposure: 'blind' | 'exposed' | 'unknown';
  kind: 'individual' | 'reference';
  sourceRevisionIds: string[];
  expectedExposure?: { suiteId: string; seenAt: string | null };
}
export interface RunSummary {
  id: string;
  title: string;
  createdAt: string;
  executedByUserId: string;
  exposure: 'blind' | 'exposed' | 'unknown';
  revealed: boolean;
  finalized: boolean;
}
export interface Labeling {
  run: Omit<Run, 'response' | 'rawResponse' | 'execution'>;
  draft: Draft;
  exposure: RunSummary['exposure'];
  revealed: boolean;
  revisions: Revision[];
  assignments: { userId: string; name: string; finalized: boolean }[];
  executedByUserId: string;
  expectedExposure?: { suiteId: string; seenAt: string | null };
}
export interface Evaluation {
  run: Run;
  revisions: Revision[];
  exposure: RunSummary['exposure'];
  boxReviews: BoxReview[];
}
export const emptyDraft = (): Draft => ({
  labels: {},
  note: '',
  settings: { threshold: 0.5, tolerance: 0.5 },
});
/** Box answers are judged after reveal, not labeled in advance. */
export const labelableQuestionCount = (questions: Query['questions']) =>
  Object.values(questions).filter((q) => q.type !== 'box').length;
export function validateLabels(query: Query, labels: Labels, complete = false) {
  for (const [id, v] of Object.entries(labels)) {
    const q = query.questions[id];
    if (!q) throw new Error('Unknown question');
    if (q.type === 'box') throw new Error('Box questions take no labels');
    if (q.type === 'noul' && typeof v !== 'boolean')
      throw new Error('Expected Yes/No');
    if (
      q.type === 'choice' &&
      (typeof v !== 'string' || !Object.hasOwn(q.criteria, v))
    )
      throw new Error('Unknown option');
    if (
      q.type === 'score' &&
      (typeof v !== 'number' ||
        !Number.isInteger(v) ||
        v < 0 ||
        v >= q.criteria.length)
    )
      throw new Error('Invalid level');
  }
  if (
    complete &&
    Object.keys(labels).length !== labelableQuestionCount(query.questions)
  )
    throw new Error('Label every question');
}
export function grade(run: Run, labels: Labels, settings: Settings) {
  validateLabels(run.query, labels, true);
  const rows = Object.entries(run.query.questions).flatMap(([id, q]) => {
    const a = run.response.answers[id];
    if (a.type === 'box' || q.type === 'box') return [];
    const expected = labels[id];
    const predicted =
      a.type === 'noul'
        ? a.noul >= settings.threshold
        : a.type === 'choice'
          ? a.choice
          : a.score;
    const error =
      a.type === 'score' ? Math.abs(a.score - Number(expected)) : null;
    return [
      {
        id,
        type: q.type,
        expected,
        predicted,
        error,
        pass:
          error === null ? predicted === expected : error <= settings.tolerance,
      },
    ];
  });
  const metric = (type: string) => {
    const rs = rows.filter((r) => r.type === type);
    return {
      correct: rs.filter((r) => r.pass).length,
      total: rs.length,
      accuracy: rs.length ? rs.filter((r) => r.pass).length / rs.length : null,
    };
  };
  const scores = rows.filter((r) => r.type === 'score');
  return {
    rows,
    noul: metric('noul'),
    choice: metric('choice'),
    score: {
      ...metric('score'),
      mae: scores.length
        ? scores.reduce((sum, r) => sum + r.error!, 0) / scores.length
        : null,
    },
    allPass: rows.every((r) => r.pass),
  };
}
