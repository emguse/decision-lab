import {
  validateResponse,
  initialQuery,
  type DecisionInput,
} from '../shared/schema';
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { Store, SCHEMA_VERSION } from '../server/store';
import { createApp } from '../server/app';
import { FlowService } from '../server/flows';
import { ProviderError } from '../server/provider';
import { StrandsProvider } from '../server/connection-providers';
import { validateConnection } from '../server/connections';
import { validateImage } from '../server/images';
import {
  flowSchema,
  validateFlow,
  selectBranch,
  gradeFlow,
  type FlowExecution,
  type Flow,
} from '../shared/flows';
import { flowMetrics } from '../shared/flow-metrics';
import {
  exampleFlow,
  exampleFlowDefinition,
  exampleFlowSuite,
} from '../shared/flow-examples';
import { suiteSchema, serializeDocument } from '../shared/exchange';
import { fixture, DROP_FLOW_TABLES } from './fixture';

const context = {
  fingerprint: 'test',
  metadata: {
    formatVersion: 1 as const,
    provider: 'jev' as const,
    requestedModel: 'jev-test',
    artifactRevision: null,
  },
};
function setup(
  store = new Store(':memory:'),
  infer = vi.fn(async (_query: DecisionInput) =>
    validateResponse(fixture, initialQuery),
  ),
) {
  const app = createApp(store, { evaluate: infer }, true),
    actor = store.actor();
  const req = (path: string, body?: unknown, user = actor) =>
    app.request(`/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Local-User': user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  store.saveDocuments([exampleFlowDefinition], actor);
  const service = new FlowService(store),
    saved = service.save(exampleFlow, actor);
  return { store, infer, app, actor, req, service, flowId: saved.id };
}
async function wait(ctx: ReturnType<typeof setup>, id: string) {
  for (let count = 0; count < 100; count++) {
    const e = ctx.store.getFlowExecution(id);
    if (e.status !== 'running') return e;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('Worker did not finish.');
}
const definitionMap = {
  triage: exampleFlowDefinition,
  priority: exampleFlowDefinition,
};
describe('flow validation and routing', () => {
  it('rejects cycles, unreachable cards, missing targets, definitions and invalid conditions', () => {
    expect(() => validateFlow(exampleFlow, definitionMap)).not.toThrow();
    const mutate = (fn: (f: Flow) => void) => {
      const f = structuredClone(exampleFlow);
      fn(f);
      return () => validateFlow(f, definitionMap);
    };
    expect(
      mutate((f) => {
        const n = f.nodes[2];
        if (n.type === 'decision') n.defaultTarget = 'triage';
      }),
    ).toThrow('Cycles');
    expect(
      mutate((f) => {
        f.nodes.push({
          id: 'extra',
          type: 'result',
          title: 'Extra',
          resultId: 'extra',
          description: '',
        });
      }),
    ).toThrow('reachable');
    expect(
      mutate((f) => {
        const n = f.nodes[1];
        if (n.type === 'decision') n.defaultTarget = 'missing';
      }),
    ).toThrow('Invalid connection');
    expect(
      mutate((f) => {
        const n = f.nodes[1];
        if (n.type === 'decision')
          n.branches[0].conditions[0] = {
            type: 'confidence',
            question: 'is_urgent',
            operator: 'lt',
            value: 0.5,
          };
      }),
    ).toThrow('type');
    expect(
      mutate((f) => {
        const n = f.nodes[1];
        if (n.type === 'decision')
          n.branches[0].conditions[0] = {
            type: 'choice',
            question: 'department',
            value: 'unknown',
          };
      }),
    ).toThrow('option');
    expect(
      mutate((f) => {
        const n = f.nodes[1];
        if (n.type === 'decision')
          n.branches[0].conditions[0] = {
            type: 'score',
            question: 'frustration',
            min: 2,
            max: 1,
          };
      }),
    ).toThrow('range');
    expect(() => validateFlow(exampleFlow, {})).toThrow('Missing definition');
    expect(
      flowSchema.safeParse({ ...exampleFlow, schemaVersion: 99 }).success,
    ).toBe(false);
  });
  it('uses first match, inclusive score bounds, AND conditions and the default', () => {
    const node = structuredClone(exampleFlow.nodes[1]);
    if (node.type !== 'decision') throw new Error();
    node.branches = [
      {
        conditions: [
          { type: 'score', question: 'frustration', min: 1.5, max: 1.5 },
          { type: 'choice', question: 'department', value: 'billing' },
        ],
        target: 'urgent',
      },
      {
        conditions: [
          { type: 'noul', question: 'is_urgent', operator: 'gte', value: 0.9 },
        ],
        target: 'billing',
      },
    ];
    expect(
      selectBranch(node, validateResponse(fixture, initialQuery).answers),
    ).toEqual({ branchIndex: 0, target: 'urgent' });
    node.branches[0].conditions[1] = {
      type: 'choice',
      question: 'department',
      value: 'sales',
    };
    expect(
      selectBranch(node, validateResponse(fixture, initialQuery).answers)
        .target,
    ).toBe('billing');
    node.branches[1].conditions[0] = {
      type: 'noul',
      question: 'is_urgent',
      operator: 'lt',
      value: 0.9,
    };
    expect(
      selectBranch(node, validateResponse(fixture, initialQuery).answers),
    ).toEqual({ branchIndex: null, target: 'review' });
  });
});
describe('flow execution, blindness and revisions', () => {
  it('executes only the chosen path, snapshots prior answers and isolates evaluators', async () => {
    const c = setup();
    try {
      const start = await c.req(`flows/${c.flowId}/execute`, {
        provider: 'jev',
        model: 'jev-test',
        state: { message: 'refund', expected: 'untrusted-input' },
      });
      expect(start.status).toBe(202);
      const id = (await start.json()).id;
      const e = await wait(c, id);
      expect(e.path).toEqual(['input', 'triage', 'priority', 'urgent']);
      expect(c.infer).toHaveBeenCalledTimes(2);
      expect(e.steps[0].query.state).toEqual({
        input: { message: 'refund', expected: 'untrusted-input' },
        decisions: {},
      });
      expect(e.steps[1].query.state).toEqual({
        input: { message: 'refund', expected: 'untrusted-input' },
        decisions: { triage: fixture.answers },
      });
      expect(e.result?.resultId).toBe('urgent_billing');
      const summary = await (await c.req(`flow-executions/${id}`)).json();
      expect(summary).not.toHaveProperty('steps');
      expect(summary).not.toHaveProperty('path');
      expect(summary).not.toHaveProperty('result');
      const blind = await (
        await c.req(`flow-executions/${id}/labeling`)
      ).json();
      expect(blind.input.state).toEqual(e.input.state);
      expect(pretty(blind)).not.toContain('probabilities');
      expect(blind.revisions).toEqual([]);
      const other = c.store.addUser('Other evaluator').id;
      await c.req(`flow-executions/${id}/assignments`, { userId: other });
      const labels = exampleFlowSuite.cases[0].expected!;
      const finalized = await (
        await c.req(`flow-executions/${id}/finalize`, { labels })
      ).json();
      expect(finalized.exposure).toBe('blind');
      expect(
        (await (await c.req(`flow-executions/${id}`)).json()).path,
      ).toEqual(e.path);
      expect(
        await (
          await c.req(`flow-executions/${id}/labeling`, undefined, other)
        ).json(),
      ).not.toHaveProperty('steps');
      expect((await c.req(`flow-executions/${id}/comparison`)).status).toBe(
        409,
      );
      await c.req(`flow-executions/${id}/finalize`, { labels }, other);
      const comparison = await (
        await c.req(`flow-executions/${id}/comparison`)
      ).json();
      expect(
        (
          await c.req(`flow-executions/${id}/adopt`, {
            labels,
            sourceRevisionIds: comparison.revisions.map(
              (r: { id: string }) => r.id,
            ),
          })
        ).status,
      ).toBe(201);
      expect(
        c.store.flowRevisions(id).filter((r) => r.kind === 'reference'),
      ).toHaveLength(1);
      await c.req(`flow-executions/${id}/finalize`, {
        labels: { resultId: 'review' },
      });
      expect(
        (
          await c.req(`flow-executions/${id}/adopt`, {
            labels,
            sourceRevisionIds: comparison.revisions.map(
              (r: { id: string }) => r.id,
            ),
          })
        ).status,
      ).toBe(409);
    } finally {
      c.store.close();
    }
  });
  it('distinguishes provider failure from a review result, sanitizes errors and recovers interrupted state', async () => {
    const c = setup(
      undefined,
      vi.fn(async () => {
        throw new ProviderError(502, 'upstream', 'secret response');
      }),
    );
    try {
      const e = c.service.create(
        c.flowId,
        { state: 'input' },
        'jev',
        'jev-test',
        c.actor,
        context,
      );
      await c.service.run(e.id, async () => {
        throw new ProviderError(502, 'upstream', 'secret response');
      });
      const saved = c.store.getFlowExecution(e.id);
      expect(saved.status).toBe('failed');
      expect(saved.attemptedJudgment?.nodeId).toBe('triage');
      expect(saved.attemptedJudgment?.query.state).toEqual({
        input: 'input',
        decisions: {},
      });
      expect(saved.result).toBeUndefined();
      expect(pretty(saved)).not.toContain('secret response');
      const pending = c.service.create(
        c.flowId,
        { state: 'other' },
        'jev',
        'jev-test',
        c.actor,
        context,
      );
      new FlowService(c.store);
      expect(c.store.getFlowExecution(pending.id).status).toBe('interrupted');
      expect(() =>
        c.service.save(
          {
            ...exampleFlow,
            name: exampleFlow.name,
            nodes: [...exampleFlow.nodes].reverse(),
          },
          c.actor,
        ),
      ).toThrow('Increment version');
    } finally {
      c.store.close();
    }
  });
});
const pretty = (value: unknown) => JSON.stringify(value);
describe('image Suites and persistence', () => {
  it('keeps unexecuted suite originals, rejects v1 image input, forwards ordered images and keeps raw responses separate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-images-'));
    const path = join(dir, 'data.sqlite');
    let store = await Store.open(path);
    try {
      const bytes = await sharp({
        create: { width: 2, height: 2, channels: 3, background: 'red' },
      })
        .png()
        .toBuffer();
      const image = store.saveImage(
        bytes,
        await validateImage(bytes),
        store.actor(),
      );
      const c = setup(store);
      const suite = {
        ...exampleFlowSuite,
        cases: [
          { ...exampleFlowSuite.cases[0], imageIds: [image.id, image.id] },
        ],
      };
      const flowSuite = c.service.save(suite, c.actor);
      const textSuite = suiteSchema.parse({
        kind: 'experiment-suite',
        schemaVersion: 2,
        name: 'images',
        version: 1,
        definition: { name: exampleFlowDefinition.name, version: 1 },
        cases: [{ id: 'one', state: 'image', imageIds: [image.id] }],
      });
      store.saveDocuments([textSuite], c.actor);
      expect(
        suiteSchema.safeParse({ ...textSuite, schemaVersion: 1 }).success,
      ).toBe(false);
      store.cleanupImages(Date.now() + 8 * 86400000);
      expect(store.getImage(image.id).data).toEqual(bytes);
      const provider = new StrandsProvider(
        validateConnection({
          id: 'vision',
          adapter: 'strands',
          label: 'Vision',
          model: 'test',
          endpoint: 'http://127.0.0.1:8012/v1/systemone',
        }),
        async (url, init) => {
          if (String(url).endsWith('/health'))
            return Response.json({
              status: 'ok',
              model: 'test',
              vision: true,
              device: 'cpu',
              base_model: 'Qwen/test',
              max_length: 4096,
            });
          const sent = JSON.parse(String(init?.body));
          expect(sent.images).toEqual([
            `data:image/png;base64,${bytes.toString('base64')}`,
            `data:image/png;base64,${bytes.toString('base64')}`,
          ]);
          expect(sent).not.toHaveProperty('imageIds');
          return Response.json({
            ...fixture,
            model: 'test',
            privateNote: 'raw-only',
          });
        },
      );
      const app = createApp(
        store,
        { evaluate: async () => validateResponse(fixture, initialQuery) },
        true,
        [provider],
      );
      const res = await app.request(
        `/api/flow-suites/${flowSuite.id}/execute`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Local-User': c.actor,
          },
          body: JSON.stringify({ provider: 'vision', model: 'test' }),
        },
      );
      expect(res.status).toBe(202);
      const id = (await res.json()).executions[0].id;
      const e = await wait(c, id);
      expect(e.status).toBe('completed');
      expect(e.formatVersion).toBe(2);
      expect(e.steps).toHaveLength(2);
      expect(pretty(c.service.labeling(id, c.actor))).not.toContain('raw-only');
      store.close();
      store = await Store.open(path);
      expect(store.getFlowExecution(id).input.imageIds).toEqual([
        image.id,
        image.id,
      ]);
      expect(store.getImage(image.id).data).toEqual(bytes);
      const db = new DatabaseSync(path);
      expect(
        db.prepare('SELECT count(*) AS n FROM flow_raw_responses').get()!.n,
      ).toBe(2);
      db.close();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('backs up schema 5 before additive migration and preserves old JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-migrate-'));
    const path = join(dir, 'db.sqlite');
    try {
      const store = await Store.open(path);
      const user = store.actor();
      store.saveDocuments([exampleFlowDefinition], user);
      store.close();
      const db = new DatabaseSync(path);
      const body = db.prepare('SELECT body FROM exchange_documents').get()!
        .body;
      db.exec(DROP_FLOW_TABLES + 'PRAGMA user_version=5;');
      db.close();
      const upgraded = await Store.open(path);
      expect(upgraded.getDocument(upgraded.listDocuments()[0].id)).toEqual(
        exampleFlowDefinition,
      );
      upgraded.close();
      const inspect = new DatabaseSync(path);
      expect(
        inspect.prepare('SELECT body FROM exchange_documents').get()!.body,
      ).toBe(body);
      expect(inspect.prepare('PRAGMA user_version').get()!.user_version).toBe(
        SCHEMA_VERSION,
      );
      inspect.close();
      const files = readdirSync(dir).filter((f) => f.includes('backup'));
      expect(files).toHaveLength(1);
      const original = new DatabaseSync(join(dir, files[0]));
      expect(original.prepare('PRAGMA user_version').get()!.user_version).toBe(
        5,
      );
      expect(
        original.prepare('SELECT body FROM exchange_documents').get()!.body,
      ).toBe(body);
      original.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe('flow suite grading', () => {
  it('excludes expectations upstream, gates results by evaluator exposure, revisions sources and partitions', async () => {
    const c = setup();
    try {
      const saved = c.service.save(exampleFlowSuite, c.actor);
      const other = c.store.addUser('Blind').id;
      const start = await c.req(
        `flow-suites/${saved.id}/execute`,
        { provider: 'jev', model: 'jev-test' },
        other,
      );
      expect(start.status).toBe(202);
      const ids: string[] = (await start.json()).executions.map(
        (e: { id: string }) => e.id,
      );
      for (const id of ids) await wait(c, id);
      for (const call of c.infer.mock.calls)
        expect(pretty(call)).not.toContain('urgent_billing');
      expect(
        (
          await c.req(
            `flow-suites/${saved.id}/results`,
            { executionIds: ids, source: 'expected' },
            other,
          )
        ).status,
      ).toBe(403);
      for (const id of ids)
        await c.req(`flow-executions/${id}/reveal`, {}, other);
      const result = await (
        await c.req(
          `flow-suites/${saved.id}/results`,
          { executionIds: ids, source: 'individual' },
          other,
        )
      ).json();
      expect(result.metrics.missingLabels).toBe(2);
      expect(result.suite.cases[0]).not.toHaveProperty('expected');
      expect(c.store.expectedSeenAt(saved.id, other)).toBeNull();
      const expected = await (
        await c.req(
          `flow-suites/${saved.id}/results`,
          { executionIds: ids, source: 'expected' },
          other,
        )
      ).json();
      expect(expected.metrics.accuracy).toBe(1);
      expect(expected.cases[0].grading.pathPass).toBe(true);
      expect(c.store.expectedSeenAt(saved.id, other)).not.toBeNull();
      expect(() =>
        c.service.save(
          {
            ...exampleFlowSuite,
            version: 2,
            cases: [{ ...exampleFlowSuite.cases[0], partition: 'tuning' }],
          },
          c.actor,
        ),
      ).toThrow('evidence group');
      const e = c.store.getFlowExecution(ids[0]);
      const broken = gradeFlow(
        e,
        {
          resultId: 'review',
          path: ['input', 'triage', 'review'],
          judgments: { triage: { department: 'sales' } },
        },
        exampleFlowSuite.settings,
      );
      expect(broken.resultPass).toBe(false);
      expect(broken.pathPass).toBe(false);
      expect(broken.judgments[0].pass).toBe(false);
      expect(flowMetrics([]).accuracy).toBeNull();
      expect(
        (
          await c.req(
            `flow-suites/${saved.id}/results`,
            { executionIds: [ids[0], ids[0]], source: 'expected' },
            other,
          )
        ).status,
      ).toBe(400);
    } finally {
      c.store.close();
    }
  });
});

describe('flow metric calculations', () => {
  it('separates primitive calibration, ignores unused confidence and isolates stability partitions', async () => {
    const c = setup();
    try {
      const e = c.service.create(
        c.flowId,
        { state: 'refund' },
        'jev',
        'jev-test',
        c.actor,
        context,
      );
      await c.service.run(e.id, async (query) => ({
        response: validateResponse(fixture, query),
        metadata: context.metadata,
        elapsedMs: 10,
      }));
      const execution = c.store.getFlowExecution(e.id);
      const row = {
        execution,
        judgments: {
          triage: { department: 'billing', frustration: 2 },
          priority: { is_urgent: true },
        },
        resultPass: true,
        provenance: {
          ...exampleFlowSuite.cases[0].provenance,
          variantGroup: 'refund',
        },
        partition: 'evaluation',
      };
      const metrics = flowMetrics([row]);
      expect(metrics.calibration.noul.brier).toBeCloseTo(0.01);
      expect(metrics.calibration.noul.ece).toBeCloseTo(0.1);
      expect(metrics.calibration.choice.brier).toBeCloseTo(0.06);
      expect(metrics.calibration.choice.ece).toBeCloseTo(0.2);
      expect(metrics.score.mae).toBe(0.5);
      expect(
        metrics.coverageRisk.find((r) => r.threshold === 0.7)?.coverage,
      ).toBe(1);
      expect(
        metrics.coverageRisk.find((r) => r.threshold === 0.8)?.coverage,
      ).toBe(0);
      expect(metrics.latency.p95).toBe(20);
      expect(metrics.cost.amount).toBeNull();
      expect(
        flowMetrics([
          row,
          { ...row, execution: { ...execution, model: 'another-model' } },
        ]).stability.groups,
      ).toBe(0);
      expect(
        flowMetrics([row, { ...row, partition: 'tuning' }]).stability.groups,
      ).toBe(0);
      expect(
        flowMetrics([row, { ...row, resultPass: false }]).stability.consistent,
      ).toBe(1);
      const failed = {
        ...row,
        execution: {
          ...execution,
          status: 'failed' as const,
          result: undefined,
        },
        resultPass: false,
      };
      expect(flowMetrics([row, failed]).coverageRisk[0].coverage).toBe(0.5);
      expect(flowMetrics([row, failed]).accuracy).toBe(0.5);
    } finally {
      c.store.close();
    }
  });
  it('runs only the default review path and accepts a merge without speculative inference', async () => {
    const c = setup(
      undefined,
      vi.fn(async (query) => {
        const response = validateResponse(fixture, query);
        if (response.answers.department.type === 'choice')
          response.answers.department.confidence = 0.1;
        return response;
      }),
    );
    try {
      const merged = structuredClone(exampleFlow);
      merged.name = 'Merged review flow';
      const priority = merged.nodes.find((n) => n.id === 'priority');
      if (priority?.type === 'decision') priority.defaultTarget = 'review';
      merged.nodes = merged.nodes.filter((n) => n.id !== 'billing');
      const mergedId = c.service.save(merged, c.actor).id;
      const e = c.service.create(
        mergedId,
        { state: 'uncertain' },
        'jev',
        'jev-test',
        c.actor,
        context,
      );
      await c.service.run(e.id, async (query) => ({
        response: await c.infer(query),
        metadata: context.metadata,
        elapsedMs: 1,
      }));
      const result = c.store.getFlowExecution(e.id);
      expect(result.path).toEqual(['input', 'triage', 'review']);
      expect(result.result?.resultId).toBe('review');
      expect(result.error).toBeUndefined();
      expect(c.infer).toHaveBeenCalledTimes(1);
      expect(result.steps[0].query.state).toEqual({
        input: 'uncertain',
        decisions: {},
      });
    } finally {
      c.store.close();
    }
  });
});
