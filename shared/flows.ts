import { z } from 'zod';
import { definitionSchema, type Definition } from './exchange.js';
import {
  labelsSchema,
  settingsSchema,
  validateLabels,
  grade,
} from './evaluation.js';
import { requestSchema, responseSchema, type Run } from './schema.js';
import { executionMetadataSchema, providerIdSchema } from './providers.js';

const id = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
  .refine(
    (value) => !['constructor', 'prototype', '__proto__'].includes(value),
    'Reserved ID',
  );
const identity = {
  name: z.string().trim().min(1).max(128),
  version: z.number().int().positive(),
};
export const conditionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('choice'),
      question: z.string(),
      value: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('noul'),
      question: z.string(),
      operator: z.enum(['gte', 'lt']),
      value: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('score'),
      question: z.string(),
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('confidence'),
      question: z.string(),
      operator: z.enum(['gte', 'lt']),
      value: z.number().min(0).max(1),
    })
    .strict(),
]);
export const nodeSchema = z.discriminatedUnion('type', [
  z
    .object({
      id,
      type: z.literal('input'),
      title: z.string().trim().min(1).max(120),
      next: id,
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('decision'),
      title: z.string().trim().min(1).max(120),
      definition: z.object(identity).strict(),
      branches: z
        .array(
          z
            .object({
              conditions: z.array(conditionSchema).min(1).max(10),
              target: id,
            })
            .strict(),
        )
        .max(30),
      defaultTarget: id,
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('result'),
      title: z.string().trim().min(1).max(120),
      resultId: id,
      description: z.string().max(4000),
    })
    .strict(),
]);
export const flowSchema = z
  .object({
    kind: z.literal('decision-flow'),
    schemaVersion: z.literal(1),
    ...identity,
    nodes: z.array(nodeSchema).min(2).max(50),
    positions: z
      .record(
        id,
        z
          .object({
            x: z.number().min(0).max(15000),
            y: z.number().min(0).max(15000),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type Flow = z.infer<typeof flowSchema>;
export type FlowNode = Flow['nodes'][number];
export type Condition = z.infer<typeof conditionSchema>;
export const expectationSchema = z
  .object({
    resultId: id,
    path: z.array(id).max(50).optional(),
    judgments: z.record(id, labelsSchema).optional(),
  })
  .strict();
export type FlowExpectation = z.infer<typeof expectationSchema>;
const provenanceSchema = z
  .object({
    source: z.string().min(1).max(2000),
    revision: z.string().min(1).max(200),
    sourceCaseId: z.string().min(1).max(200),
    license: z.string().min(1).max(1000),
    transformVersion: z.string().min(1).max(100),
    language: z.string().min(1).max(80),
    domain: z.string().min(1).max(120),
    evidenceGroup: z.string().min(1).max(200),
    variantGroup: z.string().min(1).max(200).optional(),
    variant: z.enum(['original', 'paraphrase', 'option-order']).optional(),
    labelOrigin: z.enum(['source', 'human', 'synthetic']),
  })
  .strict();
export const flowSuiteSchema = z
  .object({
    kind: z.literal('flow-suite'),
    schemaVersion: z.literal(1),
    ...identity,
    flow: z.object(identity).strict(),
    cases: z
      .array(
        z
          .object({
            id,
            state: requestSchema.shape.state,
            imageIds: requestSchema.shape.imageIds,
            partition: z.enum(['tuning', 'evaluation']),
            provenance: provenanceSchema,
            expected: expectationSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    settings: settingsSchema
      .strict()
      .default({ threshold: 0.5, tolerance: 0.5 }),
  })
  .strict();
export type FlowSuite = z.infer<typeof flowSuiteSchema>;
export const flowDocumentSchema = z.discriminatedUnion('kind', [
  flowSchema,
  flowSuiteSchema,
]);
export type FlowDocument = z.infer<typeof flowDocumentSchema>;
export const flowExecutionSchema = z
  .object({
    formatVersion: z.union([z.literal(1), z.literal(2)]),
    id: z.string().uuid(),
    flowId: z.string().uuid(),
    userId: z.string(),
    createdAt: z.string(),
    finishedAt: z.string().optional(),
    status: z.enum(['running', 'completed', 'failed', 'interrupted']),
    flow: flowSchema,
    definitions: z.record(id, definitionSchema),
    provider: providerIdSchema,
    model: requestSchema.shape.model,
    connectionFingerprint: z.string(),
    metadata: executionMetadataSchema,
    input: z
      .object({
        state: requestSchema.shape.state,
        imageIds: requestSchema.shape.imageIds,
      })
      .strict(),
    suiteId: z.string().uuid().optional(),
    caseId: id.optional(),
    path: z.array(id).max(50),
    attemptedJudgment: z
      .object({ nodeId: id, query: requestSchema })
      .strict()
      .optional(),
    steps: z
      .array(
        z
          .object({
            nodeId: id,
            query: requestSchema,
            response: responseSchema,
            elapsedMs: z.number().nonnegative(),
            metadata: executionMetadataSchema,
            branchIndex: z.number().int().nonnegative().nullable(),
            target: id,
          })
          .strict(),
      )
      .max(50),
    result: z
      .object({ resultId: id, description: z.string() })
      .strict()
      .optional(),
    error: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.formatVersion === 2 ||
      !(
        value.input.imageIds?.length ||
        value.steps.some((step) => step.query.imageIds?.length)
      ),
    'Image-bearing executions require formatVersion 2',
  );
export type FlowExecution = z.infer<typeof flowExecutionSchema>;
export const flowRevisionSchema = z
  .object({
    formatVersion: z.literal(1),
    id: z.string().uuid(),
    executionId: z.string().uuid(),
    userId: z.string(),
    createdAt: z.string(),
    kind: z.enum(['individual', 'reference']),
    labels: expectationSchema,
    settings: settingsSchema,
    exposure: z.enum(['blind', 'exposed']),
    sourceRevisionIds: z.array(z.string().uuid()),
    expectedExposure: z
      .object({ suiteId: z.string(), seenAt: z.string().nullable() })
      .optional(),
  })
  .strict();
export type FlowRevision = z.infer<typeof flowRevisionSchema>;

export function targets(node: FlowNode): string[] {
  return node.type === 'input'
    ? [node.next]
    : node.type === 'decision'
      ? [...node.branches.map((b) => b.target), node.defaultTarget]
      : [];
}
export function validateFlow(
  flow: Flow,
  definitions: Record<string, Definition>,
) {
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
  if (nodes.size !== flow.nodes.length) throw new Error('Duplicate node ID.');
  const inputs = flow.nodes.filter((n) => n.type === 'input');
  if (inputs.length !== 1) throw new Error('Use exactly one input card.');
  const resultIds = flow.nodes
    .filter((n) => n.type === 'result')
    .map((n) => n.resultId);
  if (new Set(resultIds).size !== resultIds.length)
    throw new Error('Result IDs must be unique.');
  for (const node of flow.nodes) {
    for (const target of targets(node)) {
      if (!nodes.has(target) || nodes.get(target)?.type === 'input')
        throw new Error(`Invalid connection from ${node.id}.`);
    }
    if (node.type !== 'decision') continue;
    const definition = definitions[node.id];
    if (
      !definition ||
      definition.name !== node.definition.name ||
      definition.version !== node.definition.version
    )
      throw new Error(`Missing definition for ${node.id}.`);
    for (const branch of node.branches)
      for (const condition of branch.conditions) {
        const q = definition.questions[condition.question];
        if (
          !q ||
          (condition.type === 'confidence'
            ? q.type === 'noul'
            : q.type !== condition.type)
        )
          throw new Error(
            `Condition type does not match ${node.id}/${condition.question}.`,
          );
        if (
          condition.type === 'choice' &&
          q.type === 'choice' &&
          !Object.hasOwn(q.criteria, condition.value)
        )
          throw new Error('Unknown Choice option.');
        if (condition.type === 'score' && q.type === 'score') {
          if (condition.min === undefined && condition.max === undefined)
            throw new Error('Specify a Score bound.');
          if (
            (condition.min ?? 0) < 0 ||
            (condition.max ?? q.criteria.length - 1) > q.criteria.length - 1 ||
            (condition.min ?? 0) > (condition.max ?? q.criteria.length - 1)
          )
            throw new Error('Invalid Score range.');
        }
      }
  }
  const visited = new Set<string>(),
    active = new Set<string>();
  function visit(key: string) {
    if (active.has(key)) throw new Error('Cycles are not supported.');
    if (visited.has(key)) return;
    active.add(key);
    targets(nodes.get(key)!).forEach(visit);
    active.delete(key);
    visited.add(key);
  }
  visit(inputs[0].id);
  if (visited.size !== nodes.size)
    throw new Error('Every card must be reachable from the input.');
}
export function matches(
  condition: Condition,
  answers: Run['response']['answers'],
) {
  const a = answers[condition.question];
  if (!a) throw new Error('Missing answer.');
  if (condition.type === 'choice')
    return a.type === 'choice' && a.choice === condition.value;
  if (condition.type === 'score')
    return (
      a.type === 'score' &&
      a.score >= (condition.min ?? -Infinity) &&
      a.score <= (condition.max ?? Infinity)
    );
  const value =
    condition.type === 'noul'
      ? a.type === 'noul'
        ? a.noul
        : NaN
      : a.type === 'noul'
        ? NaN
        : a.confidence;
  return condition.operator === 'gte'
    ? value >= condition.value
    : value < condition.value;
}
export function selectBranch(
  node: Extract<FlowNode, { type: 'decision' }>,
  answers: Run['response']['answers'],
) {
  const index = node.branches.findIndex((b) =>
    b.conditions.every((c) => matches(c, answers)),
  );
  return {
    branchIndex: index < 0 ? null : index,
    target: index < 0 ? node.defaultTarget : node.branches[index].target,
  };
}
export function validateExpectation(
  flow: Flow,
  definitions: Record<string, Definition>,
  labels: FlowExpectation,
) {
  if (
    !flow.nodes.some(
      (n) => n.type === 'result' && n.resultId === labels.resultId,
    )
  )
    throw new Error('Unknown result ID.');
  if (labels.path) {
    const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
    if (nodes.get(labels.path[0])?.type !== 'input')
      throw new Error('Expected path must start at input.');
    for (let i = 1; i < labels.path.length; i++)
      if (!targets(nodes.get(labels.path[i - 1])!).includes(labels.path[i]))
        throw new Error('Expected path has an invalid connection.');
    const last = nodes.get(labels.path.at(-1)!);
    if (last?.type !== 'result' || last.resultId !== labels.resultId)
      throw new Error('Expected path must end at the expected result.');
  }
  for (const [nodeId, values] of Object.entries(labels.judgments ?? {})) {
    const definition = definitions[nodeId];
    if (!definition) throw new Error('Unknown judgment card.');
    validateLabels(
      { model: 'validation', state: '', questions: definition.questions },
      values,
    );
  }
}
export function gradeFlow(
  execution: FlowExecution,
  labels: FlowExpectation,
  settings: z.infer<typeof settingsSchema>,
) {
  const judgments = Object.entries(labels.judgments ?? {}).flatMap(
    ([nodeId, expected]) => {
      const step = execution.steps.find((s) => s.nodeId === nodeId);
      if (!step)
        return Object.keys(expected).map((question) => ({
          nodeId,
          question,
          pass: false,
          missing: true,
        }));
      const query = {
        ...step.query,
        questions: Object.fromEntries(
          Object.entries(step.query.questions).filter(([key]) =>
            Object.hasOwn(expected, key),
          ),
        ),
      };
      return grade(
        {
          id: execution.id,
          title: nodeId,
          createdAt: execution.createdAt,
          elapsedMs: step.elapsedMs,
          query,
          response: step.response,
        },
        expected,
        settings,
      ).rows.map((r) => ({
        nodeId,
        question: r.id,
        pass: r.pass,
        missing: false,
      }));
    },
  );
  const routing = Object.entries(labels.judgments ?? {}).flatMap(
    ([nodeId, expected]) => {
      const node = execution.flow.nodes.find((n) => n.id === nodeId);
      const step = execution.steps.find((s) => s.nodeId === nodeId);
      if (node?.type !== 'decision' || !step) return [];
      const deterministic = (c: Condition): boolean | undefined => {
        const value = expected[c.question];
        if (value === undefined || c.type === 'confidence') return undefined;
        if (c.type === 'choice') return value === c.value;
        if (c.type === 'noul')
          return c.operator === 'gte'
            ? Number(value) >= c.value
            : Number(value) < c.value;
        return (
          Number(value) >= (c.min ?? -Infinity) &&
          Number(value) <= (c.max ?? Infinity)
        );
      };
      let target = node.defaultTarget;
      for (const b of node.branches) {
        const values = b.conditions.map(deterministic);
        if (values.some((v) => v === false)) continue;
        if (values.some((v) => v === undefined))
          return [
            {
              nodeId,
              expectedTarget: null,
              actualTarget: step.target,
              pass: null,
            },
          ];
        target = b.target;
        break;
      }
      const pathIndex = labels.path?.indexOf(nodeId) ?? -1;
      const expectedTarget =
        pathIndex >= 0 ? labels.path?.[pathIndex + 1] : undefined;
      return [
        {
          nodeId,
          expectedTarget: expectedTarget ?? null,
          actualTarget: target,
          pass: expectedTarget ? target === expectedTarget : null,
        },
      ];
    },
  );
  return {
    resultPass:
      execution.status === 'completed' &&
      execution.result?.resultId === labels.resultId,
    pathPass: labels.path
      ? JSON.stringify(labels.path) === JSON.stringify(execution.path)
      : null,
    judgments,
    routing,
  };
}
