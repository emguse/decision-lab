import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  parseInput,
  validateSuite,
  serializeDocument,
  gradePartial,
  aggregateGrades,
  resultsSchema,
  type InputDocument,
  type SuiteExecution,
  type SuiteProgress,
  type ExperimentResults,
  type LabelSource,
} from '../shared/exchange.js';
import type { Query, Run } from '../shared/schema.js';
import type { ExecutionMetadata, ProviderId } from '../shared/providers.js';
import { settingsSchema, type Settings } from '../shared/evaluation.js';
import { ProviderError } from './provider.js';
import { Store, StoreError } from './store.js';

export const importSchema = z
  .object({
    documents: z
      .array(
        z
          .object({ source: z.string(), format: z.enum(['yaml', 'json']) })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict();
export const gradingSelectionSchema = z
  .object({
    source: z.enum(['expected', 'individual', 'reference']).default('expected'),
    settings: settingsSchema.strict().optional(),
  })
  .strict();
export interface ExecutionContext {
  fingerprint: string;
  metadata: ExecutionMetadata;
}
export type ExecuteQuery = (
  query: Query,
  title: string,
  provider: ProviderId,
  actor: string,
  blind: boolean,
  link?: { executionId: string; caseId: string; attemptId: string },
) => Promise<Run>;
export class ExchangeService {
  constructor(private store: Store) {
    store.interruptSuiteExecutions();
  }
  parseImport(input: z.infer<typeof importSchema>): InputDocument[] {
    let documents: InputDocument[];
    try {
      documents = input.documents.map((d) => parseInput(d.source, d.format));
    } catch (error) {
      throw new StoreError(
        400,
        error instanceof z.ZodError
          ? 'Check the exchange schema.'
          : error instanceof Error
            ? error.message
            : 'Check the input format.',
      );
    }
    const keys = documents.map((d) => `${d.kind}:${d.name}:${d.version}`);
    if (new Set(keys).size !== keys.length)
      throw new StoreError(400, 'The same document cannot be supplied twice.');
    for (const document of documents) {
      const existing = this.store
        .listDocuments()
        .find(
          (d) =>
            d.kind === document.kind &&
            d.name === document.name &&
            d.version === document.version,
        );
      if (
        existing &&
        JSON.stringify(this.store.getDocument(existing.id)) !==
          JSON.stringify(document)
      )
        throw new StoreError(
          409,
          'Different content exists under this name and version. Increment version.',
        );
      if (document.kind !== 'experiment-suite') continue;
      const definition =
        documents.find(
          (d) =>
            d.kind === 'decision-definition' &&
            d.name === document.definition.name &&
            d.version === document.definition.version,
        ) ??
        this.store
          .listDocuments()
          .filter(
            (d) =>
              d.kind === 'decision-definition' &&
              d.name === document.definition.name &&
              d.version === document.definition.version,
          )
          .map((d) => this.store.getDocument(d.id))[0];
      if (!definition || definition.kind !== 'decision-definition')
        throw new StoreError(
          400,
          'Import the referenced definition first or in the same request.',
        );
      try {
        validateSuite(document, definition);
      } catch {
        throw new StoreError(
          400,
          'Check the case expectations against the decision definition.',
        );
      }
    }
    return documents;
  }
  import(input: z.infer<typeof importSchema>, actor: string) {
    const documents = this.parseImport(input);
    return this.store.saveDocuments(documents, actor);
  }
  suite(id: string) {
    const suite = this.store.getDocument(id);
    if (suite.kind !== 'experiment-suite')
      throw new StoreError(400, 'Select a suite.');
    return suite;
  }
  progress(execution: SuiteExecution, actor: string): SuiteProgress {
    this.store.actor(actor);
    return {
      id: execution.id,
      suiteId: execution.suiteId,
      userId: execution.userId,
      createdAt: execution.createdAt,
      finishedAt: execution.finishedAt,
      status: execution.status,
      provider: execution.provider,
      model: execution.model,
      cases: execution.cases.map((c) => ({
        ...c,
        revealed: c.runId ? this.store.revealed(c.runId, actor) : false,
        finalized: c.runId
          ? this.store.revisions(c.runId, actor).length > 0
          : false,
      })),
    };
  }
  create(
    suiteId: string,
    provider: ProviderId,
    model: string,
    actor: string,
    context: ExecutionContext,
  ) {
    const suite = this.suite(suiteId);
    const id = this.store
      .listDocuments()
      .find(
        (d) =>
          d.kind === 'decision-definition' &&
          d.name === suite.definition.name &&
          d.version === suite.definition.version,
      )?.id;
    if (!id)
      throw new StoreError(
        409,
        'The referenced decision definition version was not found.',
      );
    const definition = this.store.getDocument(id);
    if (definition.kind !== 'decision-definition')
      throw new StoreError(409, 'The decision definition is invalid.');
    const execution: SuiteExecution = {
      formatVersion: 1,
      id: randomUUID(),
      suiteId,
      userId: this.store.actor(actor),
      createdAt: new Date().toISOString(),
      status: 'running',
      suite,
      definition,
      provider,
      model,
      connectionFingerprint: context.fingerprint,
      metadata: context.metadata,
      questionInteraction:
        context.metadata.formatVersion === 2
          ? context.metadata.questionInteraction
          : 'independent',
      cases: suite.cases.map((c) => ({
        caseId: c.id,
        status: 'pending',
        attempts: [],
      })),
    };
    this.store.putSuiteExecution(execution);
    return execution;
  }
  resume(id: string, actor: string, context: ExecutionContext) {
    const e = this.store.getSuiteExecution(id);
    if (e.userId !== actor)
      throw new StoreError(
        403,
        'Resume as the user who started this execution.',
      );
    if (!['stopped', 'interrupted'].includes(e.status))
      throw new StoreError(
        409,
        'Only stopped or interrupted executions can be resumed.',
      );
    if (e.connectionFingerprint !== context.fingerprint)
      throw new StoreError(
        409,
        'Connection settings changed. Start a new suite execution.',
      );
    e.status = 'running';
    delete e.finishedAt;
    this.store.putSuiteExecution(e);
    return e;
  }
  async run(id: string, execute: ExecuteQuery) {
    let e = this.store.getSuiteExecution(id);
    try {
      for (const caseId of e.cases.map((c) => c.caseId)) {
        const item = e.cases.find((c) => c.caseId === caseId)!;
        if (item.status === 'succeeded') continue;
        const input = e.suite.cases.find((c) => c.id === item.caseId)!;
        const attempt = {
          id: randomUUID(),
          startedAt: new Date().toISOString(),
          status: 'running' as const,
        };
        item.attempts.push(attempt);
        item.status = 'running';
        this.store.putSuiteExecution(e);
        try {
          await execute(
            {
              model: e.model,
              state: input.state,
              questions: e.definition.questions,
            },
            `${e.suite.name} / ${item.caseId}`.slice(0, 120),
            e.provider,
            e.userId,
            true,
            { executionId: e.id, caseId: item.caseId, attemptId: attempt.id },
          );
        } catch (error) {
          e = this.store.getSuiteExecution(id);
          const c = e.cases.find((c) => c.caseId === item.caseId)!;
          c.status = 'failed';
          const a = c.attempts.at(-1)!;
          a.status = 'failed';
          a.finishedAt = new Date().toISOString();
          // Never retain arbitrary provider bodies or exception text.
          a.error = {
            code:
              error instanceof ProviderError ? error.code : 'execution_failed',
            message:
              'Case execution or persistence failed. Check the connection and resume explicitly.',
          };
          e.status = 'stopped';
          e.finishedAt = a.finishedAt;
          this.store.putSuiteExecution(e);
          return;
        }
        // saveRun updates the case and run link in one transaction.
        e = this.store.getSuiteExecution(id);
      }
      e.status = 'completed';
      e.finishedAt = new Date().toISOString();
      this.store.putSuiteExecution(e);
    } catch {
      e = this.store.getSuiteExecution(id);
      e.status = 'interrupted';
      e.finishedAt = new Date().toISOString();
      for (const c of e.cases.filter((c) => c.status === 'running')) {
        c.status = 'interrupted';
        const a = c.attempts.at(-1)!;
        a.status = 'interrupted';
        a.finishedAt = e.finishedAt;
        a.error = {
          code: 'interrupted',
          message: 'Execution management was interrupted. Resume explicitly.',
        };
      }
      this.store.putSuiteExecution(e);
    }
  }
  reference(runId: string, actor: string) {
    if (!this.store.revealed(runId, actor))
      throw new StoreError(
        403,
        'Finalize labels or explicitly reveal answers first.',
      );
    const linked = this.store.suiteForRun(runId);
    if (!linked) return null;
    const item = linked.execution.suite.cases.find(
      (c) => c.id === linked.caseId,
    )!;
    if (item.expected && Object.keys(item.expected).length)
      this.store.noteExpectedSeen(linked.execution.suiteId, actor);
    return {
      suiteId: linked.execution.suiteId,
      caseId: item.id,
      expected: item.expected ?? {},
      settings: linked.execution.suite.settings,
      note: item.note ?? '',
      expectedSeenAt: this.store.expectedSeenAt(
        linked.execution.suiteId,
        actor,
      ),
    };
  }
  results(
    id: string,
    actor: string,
    source: LabelSource,
    override?: Settings,
  ): ExperimentResults {
    const e = this.store.getSuiteExecution(id);
    if (e.status === 'running')
      throw new StoreError(409, 'Export after execution stops or completes.');
    if (e.cases.some((c) => c.runId && !this.store.revealed(c.runId, actor)))
      throw new StoreError(
        403,
        'Finalize or explicitly reveal all successful cases as the exporting user before export.',
      );
    this.store.actor(actor);
    // Resolve references first so failed comparison checks do not mark expectations as seen.
    const results = e.cases.map((c) => {
      const input = e.suite.cases.find((input) => input.id === c.caseId)!;
      const run = c.runId ? this.store.getRun(c.runId) : null;
      const revision =
        run && source === 'individual'
          ? this.store.revisions(run.id, actor).at(-1)
          : run && source === 'reference'
            ? this.store.comparison(run.id, actor).references.at(-1)
            : undefined;
      const labels = source === 'expected' ? input.expected : revision?.labels;
      const settings = override ?? revision?.settings ?? e.suite.settings;
      return {
        ...c,
        input: {
          model: e.model,
          state: input.state,
          questions: e.definition.questions,
        },
        ...(run
          ? {
              response: run.response,
              execution: run.execution,
              createdAt: run.createdAt,
              elapsedMs: run.elapsedMs,
            }
          : {}),
        grading:
          run && labels && Object.keys(labels).length
            ? gradePartial(run, labels, settings, source, revision?.id ?? null)
            : null,
        modelExposure: run
          ? this.store.exposure(run.id, actor)
          : ('unknown' as const),
        expectedSeenAt: this.store.expectedSeenAt(e.suiteId, actor),
        ...(revision ? { revision } : {}),
      };
    });
    if (e.suite.cases.some((c) => c.expected && Object.keys(c.expected).length))
      this.store.noteExpectedSeen(e.suiteId, actor);
    results.forEach((r) => {
      r.expectedSeenAt = this.store.expectedSeenAt(e.suiteId, actor);
    });
    const {
      definition,
      suite,
      connectionFingerprint: _fingerprint,
      cases: _cases,
      ...execution
    } = e;
    return resultsSchema.parse({
      kind: 'experiment-results',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      exportedByUserId: actor,
      gradingSelection: { source, settingsOverride: override ?? null },
      definition,
      suite,
      execution,
      results,
      summary: aggregateGrades(
        results,
        Object.keys(definition.questions).length,
      ),
    });
  }
  exportInput(id: string, actor: string, format: 'yaml' | 'json') {
    const document = this.store.getDocument(id);
    if (
      document.kind === 'experiment-suite' &&
      document.cases.some((c) => c.expected && Object.keys(c.expected).length)
    )
      this.store.noteExpectedSeen(id, actor);
    return {
      text: serializeDocument(document, format),
      format,
      filename: `${document.kind}-v${document.version}.${format}`,
    };
  }
}
