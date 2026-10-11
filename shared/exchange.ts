import { z } from 'zod';
import { parseDocument, stringify, visit, isAlias, isScalar } from 'yaml';
import {
  requestSchema,
  questionSchema,
  responseSchema,
  type Query,
  type Run,
} from './schema.js';
import {
  labelsSchema,
  settingsSchema,
  validateLabels,
  grade,
  type Settings,
  type Revision,
} from './evaluation.js';
import {
  executionMetadataSchema,
  providerIdSchema,
  type ExecutionMetadata,
  type ProviderId,
} from './providers.js';

export const exchangeFormatSchema = z.enum(['yaml', 'json']);
export type ExchangeFormat = z.infer<typeof exchangeFormatSchema>;
const identifier = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => value === value.trim(),
    'Identifiers must not have surrounding whitespace',
  );
const identity = {
  name: identifier,
  version: z.number().int().positive(),
};
const strictQuestion = z.discriminatedUnion('type', [
  questionSchema.options[0].strict().extend({
    criteria: questionSchema.options[0].shape.criteria
      .unwrap()
      .strict()
      .optional(),
  }),
  questionSchema.options[1].strict().extend({
    criteria: z
      .record(identifier, questionSchema.options[1].shape.criteria.valueType)
      .refine(
        (value) =>
          Object.keys(value).length >= 1 && Object.keys(value).length <= 255,
        'Choice requires 1–255 options',
      ),
  }),
  questionSchema.options[2].strict(),
]);
export const definitionSchema = z
  .object({
    kind: z.literal('decision-definition'),
    schemaVersion: z.literal(1),
    ...identity,
    questions: z
      .record(identifier, strictQuestion)
      .refine((v) => Object.keys(v).length > 0, 'Add a question'),
  })
  .strict();
export const suiteSchema = z
  .object({
    kind: z.literal('experiment-suite'),
    schemaVersion: z.literal(1),
    ...identity,
    definition: z.object(identity).strict(),
    cases: z
      .array(
        z
          .object({
            id: identifier,
            state: requestSchema.shape.state,
            expected: labelsSchema.optional(),
            note: z.string().max(4000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine(
        (v) => new Set(v.map((c) => c.id)).size === v.length,
        'Duplicate case ID',
      ),
    settings: settingsSchema
      .strict()
      .default({ threshold: 0.5, tolerance: 0.5 }),
  })
  .strict();
export const inputDocumentSchema = z.discriminatedUnion('kind', [
  definitionSchema,
  suiteSchema,
]);
export type Definition = z.infer<typeof definitionSchema>;
export type Suite = z.infer<typeof suiteSchema>;
export type InputDocument = Definition | Suite;
export interface SavedDocument {
  id: string;
  kind: InputDocument['kind'];
  name: string;
  version: number;
  createdAt: string;
  createdByUserId: string;
}
export interface Attempt {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  error?: { code: string; message: string };
}
export interface SuiteCaseExecution {
  caseId: string;
  status: 'pending' | Attempt['status'];
  runId?: string;
  attempts: Attempt[];
}
export interface SuiteExecution {
  formatVersion: 1;
  id: string;
  suiteId: string;
  userId: string;
  createdAt: string;
  finishedAt?: string;
  status: 'running' | 'stopped' | 'interrupted' | 'completed';
  definition: Definition;
  suite: Suite;
  provider: ProviderId;
  model: string;
  connectionFingerprint: string;
  metadata: ExecutionMetadata;
  questionInteraction: 'independent' | 'joint' | 'unknown';
  cases: SuiteCaseExecution[];
}
export interface SuiteProgress {
  id: string;
  suiteId: string;
  userId: string;
  createdAt: string;
  finishedAt?: string;
  status: SuiteExecution['status'];
  provider: ProviderId;
  model: string;
  cases: (SuiteCaseExecution & { revealed: boolean; finalized: boolean })[];
}
export type LabelSource = 'expected' | 'individual' | 'reference';
export interface CaseGrade {
  source: LabelSource;
  revisionId: string | null;
  settings: Settings;
  labels: z.infer<typeof labelsSchema>;
  rows: ReturnType<typeof grade>['rows'];
  missingLabels: number;
}
export function validateSuite(suite: Suite, definition: Definition) {
  if (
    suite.definition.name !== definition.name ||
    suite.definition.version !== definition.version
  )
    throw new Error('Decision definition reference does not match.');
  for (const c of suite.cases) {
    requestSchema.parse({
      model: 'validation',
      state: c.state,
      questions: definition.questions,
    });
    validateLabels(
      { model: 'validation', state: c.state, questions: definition.questions },
      c.expected ?? {},
    );
  }
}
export function parseInput(
  source: string,
  format: ExchangeFormat,
): InputDocument {
  if (new TextEncoder().encode(source).byteLength > 1024 * 1024)
    throw new Error('Input must be 1 MiB or smaller.');
  // The YAML JSON schema also catches duplicate JSON keys, unlike JSON.parse.
  const doc = parseDocument(source, {
    version: '1.2',
    schema: format === 'json' ? 'json' : 'core',
    uniqueKeys: true,
    merge: false,
  });
  if (doc.directives.yaml.version !== '1.2') throw new Error('Use YAML 1.2.');
  if (doc.errors.length || doc.warnings.length)
    throw new Error('Check syntax, duplicate keys, and tags.');
  visit(doc, {
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
        throw new Error('Mapping keys must be strings.');
    },
    Node(_key, node, path) {
      if (path.length > 128) throw new Error('Input nesting is too deep.');
      if (isAlias(node) || node.anchor || node.tag)
        throw new Error('Tags, anchors, and aliases are not supported.');
    },
  });
  if (format === 'json') {
    try {
      JSON.parse(source);
    } catch {
      throw new Error('Check the JSON syntax.');
    }
  }
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  assertJson(value);
  return inputDocumentSchema.parse(value);
}
function assertJson(value: unknown, depth = 0): void {
  if (depth > 64) throw new Error('Input nesting is too deep.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((v) => assertJson(v, depth + 1));
    return;
  }
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    for (const [key, v] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error('Unsupported key.');
      assertJson(v, depth + 1);
    }
    return;
  }
  throw new Error('Use JSON-compatible values.');
}
export function serializeDocument(
  value: unknown,
  format: ExchangeFormat,
): string {
  return format === 'json'
    ? JSON.stringify(value, null, 2) + '\n'
    : stringify(value, {
        version: '1.2',
        lineWidth: 0,
        aliasDuplicateObjects: false,
      });
}
export function gradePartial(
  run: Run,
  labels: z.infer<typeof labelsSchema>,
  settings: Settings,
  source: LabelSource,
  revisionId: string | null,
): CaseGrade {
  validateLabels(run.query, labels);
  const questions = Object.fromEntries(
    Object.entries(run.query.questions).filter(([id]) =>
      Object.hasOwn(labels, id),
    ),
  );
  const rows = Object.keys(questions).length
    ? grade({ ...run, query: { ...run.query, questions } }, labels, settings)
        .rows
    : [];
  return {
    source,
    revisionId,
    labels,
    settings,
    rows,
    missingLabels: Object.keys(run.query.questions).length - rows.length,
  };
}
export function aggregateGrades(
  cases: { status: SuiteCaseExecution['status']; grading?: CaseGrade | null }[],
  questionCount: number,
) {
  const rows = cases.flatMap((c) => c.grading?.rows ?? []);
  const metric = (type: string) => {
    const r = rows.filter((row) => row.type === type);
    return {
      correct: r.filter((row) => row.pass).length,
      total: r.length,
      accuracy: r.length ? r.filter((row) => row.pass).length / r.length : null,
    };
  };
  const scores = rows.filter((row) => row.type === 'score');
  return {
    noul: metric('noul'),
    choice: metric('choice'),
    score: {
      ...metric('score'),
      mae: scores.length
        ? scores.reduce((sum, row) => sum + row.error!, 0) / scores.length
        : null,
    },
    succeededCases: cases.filter((c) => c.status === 'succeeded').length,
    failedCases: cases.filter(
      (c) => c.status === 'failed' || c.status === 'interrupted',
    ).length,
    pendingCases: cases.filter(
      (c) => c.status === 'pending' || c.status === 'running',
    ).length,
    missingLabels: cases
      .filter((c) => c.status === 'succeeded')
      .reduce((sum, c) => sum + (c.grading?.missingLabels ?? questionCount), 0),
  };
}
export interface ExperimentResults {
  kind: 'experiment-results';
  schemaVersion: 1;
  exportedAt: string;
  exportedByUserId: string;
  gradingSelection: { source: LabelSource; settingsOverride: Settings | null };
  definition: Definition;
  suite: Suite;
  execution: Omit<
    SuiteExecution,
    'definition' | 'suite' | 'connectionFingerprint' | 'cases'
  >;
  results: (SuiteCaseExecution & {
    input: Query;
    response?: Run['response'];
    execution?: ExecutionMetadata;
    createdAt?: string;
    elapsedMs?: number;
    grading: CaseGrade | null;
    modelExposure: 'blind' | 'exposed' | 'unknown';
    expectedSeenAt: string | null;
    revision?: Revision;
  })[];
  summary: ReturnType<typeof aggregateGrades>;
}

const attemptSchema = z
  .object({
    id: z.string(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    status: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
    error: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .optional(),
  })
  .strict();
const caseExecutionSchema = z
  .object({
    caseId: z.string(),
    status: z.enum([
      'pending',
      'running',
      'succeeded',
      'failed',
      'interrupted',
    ]),
    runId: z.string().optional(),
    attempts: z.array(attemptSchema),
  })
  .strict();
export const suiteExecutionSchema = z
  .object({
    formatVersion: z.literal(1),
    id: z.string(),
    suiteId: z.string(),
    userId: z.string(),
    createdAt: z.string(),
    finishedAt: z.string().optional(),
    status: z.enum(['running', 'stopped', 'interrupted', 'completed']),
    definition: definitionSchema,
    suite: suiteSchema,
    provider: providerIdSchema,
    model: z.string(),
    connectionFingerprint: z.string(),
    metadata: executionMetadataSchema,
    questionInteraction: z.enum(['independent', 'joint', 'unknown']),
    cases: z.array(caseExecutionSchema),
  })
  .strict();
const labelValue = z.union([z.boolean(), z.string(), z.number().finite()]);
const caseGradeSchema = z
  .object({
    source: z.enum(['expected', 'individual', 'reference']),
    revisionId: z.string().nullable(),
    settings: settingsSchema.strict(),
    labels: labelsSchema,
    rows: z.array(
      z
        .object({
          id: z.string(),
          type: z.enum(['noul', 'choice', 'score']),
          expected: labelValue,
          predicted: labelValue,
          error: z.number().nonnegative().nullable(),
          pass: z.boolean(),
        })
        .strict(),
    ),
    missingLabels: z.number().int().nonnegative(),
  })
  .strict();
const revisionSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    userId: z.string(),
    createdAt: z.string(),
    exposure: z.enum(['blind', 'exposed', 'unknown']),
    kind: z.enum(['individual', 'reference']),
    sourceRevisionIds: z.array(z.string()),
    labels: labelsSchema,
    settings: settingsSchema.strict(),
    note: z.string(),
    expectedExposure: z
      .object({ suiteId: z.string(), seenAt: z.string().nullable() })
      .strict()
      .optional(),
  })
  .strict();
const metricSchema = z
  .object({
    correct: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    accuracy: z.number().min(0).max(1).nullable(),
  })
  .strict();
export const resultsSchema = z
  .object({
    kind: z.literal('experiment-results'),
    schemaVersion: z.literal(1),
    exportedAt: z.string(),
    exportedByUserId: z.string(),
    gradingSelection: z
      .object({
        source: z.enum(['expected', 'individual', 'reference']),
        settingsOverride: settingsSchema.strict().nullable(),
      })
      .strict(),
    definition: definitionSchema,
    suite: suiteSchema,
    execution: suiteExecutionSchema.omit({
      definition: true,
      suite: true,
      connectionFingerprint: true,
      cases: true,
    }),
    results: z.array(
      caseExecutionSchema.extend({
        input: requestSchema,
        response: responseSchema.optional(),
        execution: executionMetadataSchema.optional(),
        createdAt: z.string().optional(),
        elapsedMs: z.number().nonnegative().optional(),
        grading: caseGradeSchema.nullable(),
        modelExposure: z.enum(['blind', 'exposed', 'unknown']),
        expectedSeenAt: z.string().nullable(),
        revision: revisionSchema.optional(),
      }),
    ),
    summary: z
      .object({
        noul: metricSchema,
        choice: metricSchema,
        score: metricSchema.extend({
          mae: z.number().nonnegative().nullable(),
        }),
        succeededCases: z.number().int().nonnegative(),
        failedCases: z.number().int().nonnegative(),
        pendingCases: z.number().int().nonnegative(),
        missingLabels: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
