import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, StoreError } from './store.js';
import { ProviderError } from './provider.js';
import {
  requestSchema,
  validateResponse,
  type Query,
  type Run,
} from '../shared/schema.js';
import {
  flowDocumentSchema,
  flowSchema,
  flowSuiteSchema,
  validateFlow,
  validateExpectation,
  selectBranch,
  gradeFlow,
  type Flow,
  type FlowDocument,
  type FlowExecution,
  type FlowExpectation,
} from '../shared/flows.js';
import { flowMetrics } from '../shared/flow-metrics.js';
import { type Definition, type LabelSource } from '../shared/exchange.js';
import { type Settings } from '../shared/evaluation.js';
import { type ExecutionContext } from './exchange.js';
import {
  type ExecutionMetadata,
  type ProviderId,
} from '../shared/providers.js';

export type InferFlow = (
  query: Query,
  provider: ProviderId,
) => Promise<{
  response: Run['response'];
  metadata: ExecutionMetadata;
  elapsedMs: number;
  rawResponse?: unknown;
}>;
export class FlowService {
  constructor(private store: Store) {
    for (const execution of store.listFlowExecutions())
      if (execution.status === 'running') {
        execution.status = 'interrupted';
        execution.finishedAt = new Date().toISOString();
        execution.error = {
          code: 'interrupted',
          message: 'Server restarted. Start a new execution explicitly.',
        };
        store.putFlowExecution(execution);
      }
  }
  definitions(flow: Flow) {
    const definitions: Record<string, Definition> = {};
    for (const node of flow.nodes)
      if (node.type === 'decision') {
        const saved = this.store
          .listDocuments()
          .find(
            (d) =>
              d.kind === 'decision-definition' &&
              d.name === node.definition.name &&
              d.version === node.definition.version,
          );
        if (!saved)
          throw new StoreError(
            400,
            `Import definition ${node.definition.name} v${node.definition.version}.`,
          );
        const definition = this.store.getDocument(saved.id);
        if (definition.kind !== 'decision-definition')
          throw new StoreError(400, 'Invalid decision definition.');
        definitions[node.id] = definition;
      }
    return definitions;
  }
  flow(id: string) {
    const document = this.store.getFlowDocument(id);
    if (document.kind !== 'decision-flow')
      throw new StoreError(400, 'Select a flow.');
    return document;
  }
  validate(document: FlowDocument) {
    try {
      if (document.kind === 'decision-flow')
        validateFlow(document, this.definitions(document));
      else {
        const saved = this.store
          .listFlowDocuments()
          .find(
            (d) =>
              d.kind === 'decision-flow' &&
              d.name === document.flow.name &&
              d.version === document.flow.version,
          );
        if (!saved) throw new Error('Save the referenced flow first.');
        const flow = this.flow(saved.id),
          definitions = this.definitions(flow);
        if (
          new Set(document.cases.map((c) => c.id)).size !==
          document.cases.length
        )
          throw new Error('Duplicate case ID.');
        const groups = new Map<string, string>();
        const suites = this.store
          .listFlowDocuments()
          .filter((d) => d.kind === 'flow-suite')
          .map((d) => this.store.getFlowDocument(d.id))
          .filter((d) => d.kind === 'flow-suite');
        for (const item of [
          ...suites.flatMap((s) => s.cases),
          ...document.cases,
        ]) {
          const key = JSON.stringify([
            item.provenance.source,
            item.provenance.revision,
            item.provenance.evidenceGroup,
          ]);
          if (groups.has(key) && groups.get(key) !== item.partition)
            throw new Error(
              'An evidence group cannot appear in tuning and evaluation partitions.',
            );
          groups.set(key, item.partition);
        }
        for (const item of document.cases) {
          this.store.resolveImages(item.imageIds);
          if (item.expected)
            validateExpectation(flow, definitions, item.expected);
        }
      }
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError(
        400,
        error instanceof Error ? error.message : 'Invalid flow.',
      );
    }
  }
  save(input: unknown, actor: string) {
    const document = flowDocumentSchema.parse(input);
    this.validate(document);
    return this.store.saveFlowDocument(document, actor);
  }
  create(
    flowId: string,
    input: FlowExecution['input'],
    provider: ProviderId,
    model: string,
    actor: string,
    context: ExecutionContext,
    suiteId?: string,
    caseId?: string,
  ): FlowExecution {
    const flow = flowSchema.parse(this.flow(flowId)),
      definitions = this.definitions(flow);
    validateFlow(flow, definitions);
    this.store.resolveImages(input.imageIds);
    const execution: FlowExecution = {
      formatVersion: input.imageIds?.length ? 2 : 1,
      id: randomUUID(),
      flowId,
      userId: this.store.actor(actor),
      createdAt: new Date().toISOString(),
      status: 'running',
      flow,
      definitions,
      provider,
      model,
      connectionFingerprint: context.fingerprint,
      metadata: context.metadata,
      input,
      path: [],
      steps: [],
      ...(suiteId ? { suiteId, caseId } : {}),
    };
    this.store.putFlowExecution(execution);
    return execution;
  }
  async run(id: string, infer: InferFlow) {
    const e = this.store.getFlowExecution(id);
    if (e.status !== 'running')
      throw new StoreError(409, 'Execution is not running.');
    const decisions: Record<string, Run['response']['answers']> = {};
    let next = e.flow.nodes.find((n) => n.type === 'input')!.id;
    try {
      for (let count = 0; count < e.flow.nodes.length; count++) {
        const node = e.flow.nodes.find((n) => n.id === next)!;
        e.path.push(node.id);
        this.store.putFlowExecution(e);
        if (node.type === 'input') {
          next = node.next;
          continue;
        }
        if (node.type === 'result') {
          e.result = { resultId: node.resultId, description: node.description };
          e.status = 'completed';
          break;
        }
        const query = requestSchema.parse({
          model: e.model,
          state: { input: e.input.state, decisions },
          ...(e.input.imageIds?.length ? { imageIds: e.input.imageIds } : {}),
          questions: e.definitions[node.id].questions,
        });
        e.attemptedJudgment = { nodeId: node.id, query };
        this.store.putFlowExecution(e);
        const output = await infer(query, e.provider);
        const response = validateResponse(output.response, query);
        const route = selectBranch(node, response.answers);
        e.steps.push({
          nodeId: node.id,
          query,
          response,
          elapsedMs: output.elapsedMs,
          metadata: output.metadata,
          ...route,
        });
        if (output.rawResponse !== undefined)
          this.store.saveFlowRaw(e.id, node.id, output.rawResponse);
        delete e.attemptedJudgment;
        decisions[node.id] = response.answers;
        next = route.target;
        this.store.putFlowExecution(e);
      }
      if (e.status !== 'completed')
        throw new Error('Flow did not reach a result.');
    } catch (error) {
      e.status = 'failed';
      e.error = {
        code: error instanceof ProviderError ? error.code : 'execution_failed',
        message:
          'Decision execution or persistence failed. Check the connection and start a new execution.',
      };
    }
    e.finishedAt = new Date().toISOString();
    this.store.putFlowExecution(e);
    return e;
  }
  summary(e: FlowExecution, actor: string) {
    return {
      id: e.id,
      flowId: e.flowId,
      flowName: e.flow.name,
      flowVersion: e.flow.version,
      createdAt: e.createdAt,
      finishedAt: e.finishedAt,
      status: e.status,
      suiteId: e.suiteId,
      caseId: e.caseId,
      userId: e.userId,
      provider: e.provider,
      model: e.model,
      revealed: this.store.flowRevealed(e.id, actor),
      finalized: this.store
        .flowRevisions(e.id, actor)
        .some((r) => r.kind === 'individual'),
    };
  }
  labeling(id: string, actor: string) {
    const e = this.store.getFlowExecution(id);
    this.store.assignFlow(id, actor);
    return {
      ...this.summary(e, actor),
      flow: e.flow,
      definitions: e.definitions,
      input: e.input,
      revisions: this.store
        .flowRevisions(id, actor)
        .filter((r) => r.kind === 'individual'),
      expectedExposure: e.suiteId
        ? {
            suiteId: e.suiteId,
            seenAt: this.store.expectedSeenAt(e.suiteId, actor),
          }
        : undefined,
    };
  }
  finalize(
    id: string,
    actor: string,
    labels: FlowExpectation,
    settings: Settings,
    kind: 'individual' | 'reference' = 'individual',
    sourceRevisionIds: string[] = [],
  ) {
    const e = this.store.getFlowExecution(id);
    if (e.status === 'running')
      throw new StoreError(409, 'Wait for execution to finish.');
    try {
      validateExpectation(e.flow, e.definitions, labels);
    } catch (error) {
      throw new StoreError(
        400,
        error instanceof Error ? error.message : 'Invalid labels.',
      );
    }
    this.store.assignFlow(id, actor);
    if (kind === 'reference') {
      const assigned = this.store.flowAssignments(id);
      const latest = assigned.map((user) =>
        this.store
          .flowRevisions(id, user)
          .filter((r) => r.kind === 'individual')
          .at(-1),
      );
      if (
        latest.some((r) => !r) ||
        JSON.stringify(latest.map((r) => r!.id).sort()) !==
          JSON.stringify([...sourceRevisionIds].sort())
      )
        throw new StoreError(
          409,
          'Finalize every assigned evaluator and use their latest revision IDs.',
        );
    }
    const revision = {
      formatVersion: 1 as const,
      id: randomUUID(),
      executionId: id,
      userId: this.store.actor(actor),
      createdAt: new Date().toISOString(),
      kind,
      labels,
      settings,
      sourceRevisionIds,
      exposure: this.store.flowRevealed(id, actor)
        ? ('exposed' as const)
        : ('blind' as const),
      ...(e.suiteId
        ? {
            expectedExposure: {
              suiteId: e.suiteId,
              seenAt: this.store.expectedSeenAt(e.suiteId, actor),
            },
          }
        : {}),
    };
    this.store.finalizeFlowRevision(revision);
    return revision;
  }
  results(suiteId: string, ids: string[], actor: string, source: LabelSource) {
    const suite = flowSuiteSchema.parse(this.store.getFlowDocument(suiteId));
    const executions = ids.map((id) => this.store.getFlowExecution(id));
    if (
      new Set(ids).size !== ids.length ||
      new Set(executions.map((e) => e.caseId)).size !== executions.length
    )
      throw new StoreError(400, 'Select one execution per case.');
    if (executions.some((e) => e.suiteId !== suiteId))
      throw new StoreError(400, 'Execution does not belong to this suite.');
    if (executions.some((e) => e.status === 'running'))
      throw new StoreError(409, 'Wait for execution to finish.');
    if (executions.some((e) => !this.store.flowRevealed(e.id, actor)))
      throw new StoreError(
        403,
        'Reveal each execution before inspecting results.',
      );
    if (source === 'expected') this.store.noteExpectedSeen(suiteId, actor);
    const rows = executions.map((execution) => {
      const item = suite.cases.find((c) => c.id === execution.caseId)!;
      let revision =
        source === 'individual'
          ? this.store
              .flowRevisions(execution.id, actor)
              .filter((r) => r.kind === 'individual')
              .at(-1)
          : undefined;
      if (source === 'reference') {
        const assigned = this.store.flowAssignments(execution.id);
        if (
          assigned.some(
            (user) =>
              !this.store
                .flowRevisions(execution.id, user)
                .some((r) => r.kind === 'individual'),
          )
        )
          throw new StoreError(
            409,
            'Wait for assigned evaluators to finalize.',
          );
        revision = this.store
          .flowRevisions(execution.id)
          .filter((r) => r.kind === 'reference')
          .at(-1);
      }
      const labels = source === 'expected' ? item.expected : revision?.labels;
      const settings = revision?.settings ?? suite.settings;
      return {
        execution,
        labels: labels ?? null,
        revisionId: revision?.id ?? null,
        settings,
        grading: labels ? gradeFlow(execution, labels, settings) : null,
        provenance: item.provenance,
        partition: item.partition,
      };
    });
    return {
      kind: 'flow-results',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      suite:
        source === 'expected'
          ? suite
          : {
              ...suite,
              cases: suite.cases.map(
                ({ expected: _expected, ...item }) => item,
              ),
            },
      source,
      cases: rows,
      metrics: flowMetrics(
        rows.map((r) => ({
          ...r,
          judgments: r.labels?.judgments,
          resultPass: r.grading?.resultPass ?? null,
        })),
      ),
      missingCases: suite.cases
        .filter((c) => !executions.some((e) => e.caseId === c.id))
        .map((c) => c.id),
    };
  }
}
