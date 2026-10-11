import { z } from 'zod';
import {
  inputDocumentSchema,
  suiteExecutionSchema,
  type InputDocument,
  type SavedDocument,
  type SuiteExecution,
} from '../shared/exchange.js';
import {
  executionMetadataSchema,
  providerIdSchema,
  type ExecutionMetadata,
  type ProviderId,
} from '../shared/providers.js';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Run, Query } from '../shared/schema.js';
import {
  emptyDraft,
  validateLabels,
  type Draft,
  type Revision,
  type LocalUser,
  type Labeling,
  type RunSummary,
} from '../shared/evaluation.js';
export class StoreError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const SCHEMA_VERSION = 4;
const legacy = 'legacy-unknown';
const migrations = [
  `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL);
 CREATE TABLE attribution(id TEXT NOT NULL,entity TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),format_version INTEGER NOT NULL DEFAULT 1,blind INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(id,entity));`,
  `CREATE TABLE assignments(run_id TEXT NOT NULL REFERENCES runs(id),user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(run_id,user_id));
 CREATE TABLE annotations(run_id TEXT NOT NULL REFERENCES runs(id),user_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,PRIMARY KEY(run_id,user_id));
 CREATE TABLE exposures(run_id TEXT NOT NULL REFERENCES runs(id),user_id TEXT NOT NULL REFERENCES users(id),revealed_at TEXT NOT NULL,PRIMARY KEY(run_id,user_id));
 CREATE TABLE revisions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,body TEXT NOT NULL);`,
  `CREATE TABLE run_metadata(run_id TEXT PRIMARY KEY REFERENCES runs(id),body TEXT NOT NULL,raw_body TEXT);
 CREATE TABLE experiment_metadata(experiment_id TEXT PRIMARY KEY REFERENCES experiments(id),provider TEXT NOT NULL,format_version INTEGER NOT NULL DEFAULT 1);`,
  `CREATE TABLE exchange_documents(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,UNIQUE(kind,name,version));
 CREATE TABLE suite_executions(id TEXT PRIMARY KEY,suite_id TEXT NOT NULL REFERENCES exchange_documents(id),body TEXT NOT NULL);
 CREATE TABLE suite_run_links(run_id TEXT PRIMARY KEY REFERENCES runs(id),execution_id TEXT NOT NULL REFERENCES suite_executions(id),case_id TEXT NOT NULL,UNIQUE(execution_id,case_id));
 CREATE TABLE expected_exposures(suite_id TEXT NOT NULL REFERENCES exchange_documents(id),user_id TEXT NOT NULL REFERENCES users(id),seen_at TEXT NOT NULL,PRIMARY KEY(suite_id,user_id));`,
];
export class Store {
  private db: DatabaseSync;
  static async open(path: string) {
    if (path === ':memory:') return new Store(path);
    mkdirSync(dirname(path), { recursive: true });
    const existed = existsSync(path);
    const db = new DatabaseSync(path);
    try {
      const version = Number(
        db.prepare('PRAGMA user_version').get()!.user_version,
      );
      if (version > SCHEMA_VERSION)
        throw new Error(
          `Database schema ${version} is newer than supported ${SCHEMA_VERSION}. Upgrade the app or restore a compatible backup.`,
        );
      if (existed && version < SCHEMA_VERSION) {
        const target = `${path}.backup-v${version}-${Date.now()}-${randomUUID()}.sqlite`;
        await backup(db, target);
        console.log(
          `SQLite backup: ${target} (schema ${version} → ${SCHEMA_VERSION})`,
        );
      }
    } finally {
      db.close();
    }
    return new Store(path, true);
  }
  constructor(path: string, backedUp = false) {
    if (path !== ':memory:' && !backedUp)
      throw new Error('Use await Store.open(path) for persistent databases');
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      let version = Number(
        this.db.prepare('PRAGMA user_version').get()!.user_version,
      );
      if (version > SCHEMA_VERSION)
        throw new Error('Database is newer than this app');
      for (; version < SCHEMA_VERSION; version++)
        this.transaction(() => {
          this.db.exec(migrations[version]);
          if (version === 0) {
            this.db
              .prepare('INSERT INTO users VALUES (?,?,?)')
              .run(legacy, '旧データ・作成者不明', 'legacy');
            this.db
              .prepare('INSERT INTO users VALUES (?,?,?)')
              .run(randomUUID(), '自分', 'local');
            this.db.exec(
              `INSERT INTO attribution(id,entity,user_id) SELECT id,'run','${legacy}' FROM runs; INSERT INTO attribution(id,entity,user_id) SELECT id,'experiment','${legacy}' FROM experiments;`,
            );
          }
          this.db.exec(`PRAGMA user_version=${version + 1}`);
        });
      this.db.exec('PRAGMA journal_mode=WAL;');
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const v = fn();
      this.db.exec('COMMIT');
      return v;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  listUsers(): LocalUser[] {
    return this.db
      .prepare('SELECT id,name,kind FROM users ORDER BY rowid')
      .all() as unknown as LocalUser[];
  }
  actor(id?: string) {
    const user = id
      ? this.listUsers().find((u) => u.id === id && u.kind === 'local')
      : this.listUsers().find((u) => u.kind === 'local');
    if (!user) throw new StoreError(400, 'User does not exist.');
    return user.id;
  }
  addUser(name: string) {
    const user: LocalUser = { id: randomUUID(), name, kind: 'local' };
    this.db
      .prepare('INSERT INTO users VALUES (?,?,?)')
      .run(user.id, user.name, user.kind);
    return user;
  }
  attribution(id: string, entity = 'run') {
    const r = this.db
      .prepare('SELECT * FROM attribution WHERE id=? AND entity=?')
      .get(id, entity);
    if (!r) throw new StoreError(404, 'Saved data was not found.');
    if (Number(r.format_version) !== 1)
      throw new StoreError(409, 'Unsupported record format. Update the app.');
    return { userId: String(r.user_id), blind: Boolean(r.blind) };
  }
  saveRun(
    run: Omit<Run, 'id'>,
    actor = this.actor(),
    blind = false,
    execution?: ExecutionMetadata,
    rawResponse?: unknown,
    suiteLink?: { executionId: string; caseId: string; attemptId: string },
  ): Run {
    this.actor(actor);
    const saved = { ...run, id: randomUUID() };
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO runs VALUES (?,?)')
        .run(saved.id, JSON.stringify(saved));
      this.db
        .prepare(
          'INSERT INTO attribution(id,entity,user_id,blind) VALUES (?,?,?,?)',
        )
        .run(saved.id, 'run', actor, Number(blind));
      this.db.prepare('INSERT INTO run_metadata VALUES (?,?,?)').run(
        saved.id,
        JSON.stringify(
          execution ?? {
            formatVersion: 1,
            provider: 'jev',
            requestedModel: saved.query.model,
            resolvedModel: saved.response.model,
            artifactRevision: null,
          },
        ),
        rawResponse === undefined ? null : JSON.stringify(rawResponse),
      );
      if (suiteLink) {
        const execution = this.getSuiteExecution(suiteLink.executionId);
        const item = execution.cases.find((c) => c.caseId === suiteLink.caseId);
        const attempt = item?.attempts.find(
          (a) => a.id === suiteLink.attemptId,
        );
        if (!item || !attempt || attempt.status !== 'running' || item.runId)
          throw new StoreError(409, 'The case execution state changed.');
        item.status = attempt.status = 'succeeded';
        attempt.finishedAt = new Date().toISOString();
        item.runId = saved.id;
        this.db
          .prepare('INSERT INTO suite_run_links VALUES (?,?,?)')
          .run(saved.id, execution.id, item.caseId);
        this.putSuiteExecution(execution);
      }
      this.assign(saved.id, actor);
      if (!blind) this.reveal(saved.id, actor);
    });
    return this.getRun(saved.id);
  }
  getRun(id: string): Run {
    this.attribution(id);
    const r = this.db.prepare('SELECT body FROM runs WHERE id=?').get(id);
    if (!r) throw new StoreError(404, 'Run was not found.');
    const run: Run = JSON.parse(String(r.body));
    const meta = this.db
      .prepare('SELECT body,raw_body FROM run_metadata WHERE run_id=?')
      .get(id);
    const parsedExecution = executionMetadataSchema.safeParse(
      meta
        ? JSON.parse(String(meta.body))
        : {
            formatVersion: 1,
            provider: 'jev',
            requestedModel: run.query.model,
            resolvedModel: run.response.model,
          },
    );
    if (!parsedExecution.success)
      throw new StoreError(409, 'Unsupported record format. Update the app.');
    return {
      ...run,
      execution: parsedExecution.data!,
      ...(meta?.raw_body
        ? { rawResponse: JSON.parse(String(meta.raw_body)) }
        : {}),
    };
  }
  private runIds() {
    return this.db
      .prepare('SELECT id FROM runs ORDER BY rowid DESC LIMIT 100')
      .all()
      .map((r) => String(r.id));
  }
  listRuns(actor = this.actor()) {
    return this.runIds()
      .filter((id) => this.revealed(id, actor))
      .map((id) => {
        this.reveal(id, actor);
        return this.getRun(id);
      });
  }
  listSummaries(actor: string): RunSummary[] {
    this.actor(actor);
    return this.runIds().map((id) => {
      const r = this.getRun(id);
      return {
        id,
        title: r.title,
        createdAt: r.createdAt,
        executedByUserId: this.attribution(id).userId,
        exposure: this.exposure(id, actor),
        revealed: this.revealed(id, actor),
        finalized: this.revisions(id, actor).length > 0,
      };
    });
  }
  saveExperiment(
    title: string,
    query: Query,
    actor = this.actor(),
    provider: ProviderId = 'jev',
  ) {
    const saved = {
      id: randomUUID(),
      title,
      query,
      createdAt: new Date().toISOString(),
    };
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO experiments VALUES (?,?)')
        .run(saved.id, JSON.stringify(saved));
      this.db
        .prepare('INSERT INTO attribution(id,entity,user_id) VALUES (?,?,?)')
        .run(saved.id, 'experiment', this.actor(actor));
      this.db
        .prepare('INSERT INTO experiment_metadata VALUES (?,?,?)')
        .run(saved.id, provider, provider === 'jev' ? 1 : 2);
    });
    return { ...saved, createdByUserId: actor, provider };
  }
  private experimentProvider(id: string): ProviderId {
    const meta = this.db
      .prepare(
        'SELECT provider,format_version FROM experiment_metadata WHERE experiment_id=?',
      )
      .get(id);
    if (meta && ![1, 2].includes(Number(meta.format_version)))
      throw new StoreError(409, 'Unsupported record format.');
    if (!meta) return 'jev';
    const parsed = (
      Number(meta.format_version) === 1
        ? z.enum(['jev', 'strands-local'])
        : providerIdSchema
    ).safeParse(meta.provider);
    if (!parsed.success)
      throw new StoreError(409, 'Unsupported record format.');
    return parsed.data;
  }
  listExperiments() {
    return this.db
      .prepare('SELECT id,body FROM experiments ORDER BY rowid DESC LIMIT 100')
      .all()
      .map((r) => ({
        ...JSON.parse(String(r.body)),
        createdByUserId: this.attribution(String(r.id), 'experiment').userId,
        provider: this.experimentProvider(String(r.id)),
      }));
  }
  assign(id: string, actor: string) {
    this.getRun(id);
    this.actor(actor);
    this.db
      .prepare('INSERT OR IGNORE INTO assignments VALUES (?,?)')
      .run(id, actor);
  }
  assignments(id: string) {
    return this.db
      .prepare(
        'SELECT u.id AS userId,u.name FROM assignments a JOIN users u ON u.id=a.user_id WHERE a.run_id=? ORDER BY a.rowid',
      )
      .all(id)
      .map((r) => ({
        userId: String(r.userId),
        name: String(r.name),
        finalized: this.revisions(id, String(r.userId)).length > 0,
      }));
  }
  exposure(id: string, actor: string): 'blind' | 'exposed' | 'unknown' {
    if (
      this.db
        .prepare('SELECT 1 FROM exposures WHERE run_id=? AND user_id=?')
        .get(id, actor)
    )
      return 'exposed';
    const attr = this.attribution(id);
    return attr.userId === legacy ? 'unknown' : 'blind';
  }
  revealed(id: string, actor: string) {
    return this.exposure(id, actor) === 'exposed';
  }
  reveal(id: string, actor: string) {
    this.assign(id, actor);
    this.db
      .prepare('INSERT OR IGNORE INTO exposures VALUES (?,?,?)')
      .run(id, actor, new Date().toISOString());
    return this.getRun(id);
  }
  revisions(id: string, actor?: string): Revision[] {
    return this.db
      .prepare(
        `SELECT body FROM revisions WHERE run_id=? AND kind='individual' ${actor ? 'AND user_id=?' : ''} ORDER BY rowid`,
      )
      .all(...(actor ? [id, actor] : [id]))
      .map((r) => JSON.parse(String(r.body)));
  }
  labeling(id: string, actor: string): Labeling {
    this.assign(id, actor);
    const {
      response: _,
      rawResponse: _raw,
      execution: _execution,
      ...run
    } = this.getRun(id);
    const r = this.db
      .prepare('SELECT body FROM annotations WHERE run_id=? AND user_id=?')
      .get(id, actor);
    return {
      run,
      draft: r ? JSON.parse(String(r.body)) : emptyDraft(),
      revisions: this.revisions(id, actor),
      exposure: this.exposure(id, actor),
      revealed: this.revealed(id, actor),
      assignments: this.assignments(id),
      executedByUserId: this.attribution(id).userId,
      ...this.expectedExposure(id, actor),
    };
  }
  saveDraft(id: string, actor: string, draft: Draft) {
    this.assign(id, actor);
    try {
      validateLabels(this.getRun(id).query, draft.labels);
    } catch {
      throw new StoreError(400, 'Check the reference labels.');
    }
    this.db
      .prepare(
        'INSERT INTO annotations VALUES (?,?,?) ON CONFLICT(run_id,user_id) DO UPDATE SET body=excluded.body',
      )
      .run(id, actor, JSON.stringify(draft));
    return this.labeling(id, actor);
  }
  finalize(id: string, actor: string, draft: Draft) {
    try {
      validateLabels(this.getRun(id).query, draft.labels, true);
    } catch {
      throw new StoreError(400, 'Label every question before finalizing.');
    }
    return this.transaction(() => {
      this.saveDraft(id, actor, draft);
      const revision: Revision = {
        ...draft,
        id: randomUUID(),
        runId: id,
        userId: actor,
        createdAt: new Date().toISOString(),
        exposure: this.exposure(id, actor),
        kind: 'individual',
        sourceRevisionIds: [],
        ...this.expectedExposure(id, actor),
      };
      this.db
        .prepare('INSERT INTO revisions VALUES (?,?,?,?,?)')
        .run(revision.id, id, actor, 'individual', JSON.stringify(revision));
      this.reveal(id, actor);
      return {
        run: this.getRun(id),
        revisions: this.revisions(id, actor),
        exposure: this.exposure(id, actor),
      };
    });
  }
  evaluation(id: string, actor: string) {
    this.actor(actor);
    if (!this.revealed(id, actor))
      throw new StoreError(403, 'Finalize labels before revealing answers.');
    return {
      run: this.getRun(id),
      revisions: this.revisions(id, actor),
      exposure: this.exposure(id, actor),
    };
  }
  comparison(id: string, actor: string) {
    this.actor(actor);
    const assigned = this.assignments(id);
    if (
      !assigned.some((a) => a.userId === actor) ||
      assigned.some((a) => !a.finalized)
    )
      throw new StoreError(
        409,
        'Wait for all assigned evaluators to finalize.',
      );
    const revisions = assigned.map((a) => this.revisions(id, a.userId).at(-1)!);
    const references = this.db
      .prepare(
        "SELECT body FROM revisions WHERE run_id=? AND kind='reference' ORDER BY rowid",
      )
      .all(id)
      .map((r) => JSON.parse(String(r.body)) as Revision);
    return { revisions, references };
  }
  adopt(id: string, actor: string, draft: Draft, sourceIds: string[]) {
    return this.transaction(() => {
      const comparison = this.comparison(id, actor);
      const expected = comparison.revisions.map((r) => r.id).sort();
      if (JSON.stringify([...sourceIds].sort()) !== JSON.stringify(expected))
        throw new StoreError(409, 'Comparison changed. Reload it.');
      try {
        validateLabels(this.getRun(id).query, draft.labels, true);
      } catch {
        throw new StoreError(400, 'Enter all adopted reference labels.');
      }
      const revision: Revision = {
        ...draft,
        id: randomUUID(),
        runId: id,
        userId: actor,
        createdAt: new Date().toISOString(),
        exposure: 'exposed',
        kind: 'reference',
        sourceRevisionIds: sourceIds,
        ...this.expectedExposure(id, actor),
      };
      this.db
        .prepare('INSERT INTO revisions VALUES (?,?,?,?,?)')
        .run(revision.id, id, actor, 'reference', JSON.stringify(revision));
      return revision;
    });
  }
  private expectedExposure(runId: string, actor: string) {
    const linked = this.suiteForRun(runId);
    return linked
      ? {
          expectedExposure: {
            suiteId: linked.execution.suiteId,
            seenAt: this.expectedSeenAt(linked.execution.suiteId, actor),
          },
        }
      : {};
  }
  listDocuments(): SavedDocument[] {
    return this.db
      .prepare(
        'SELECT id,kind,name,version,created_at AS createdAt,user_id AS createdByUserId FROM exchange_documents ORDER BY rowid DESC',
      )
      .all() as unknown as SavedDocument[];
  }
  getDocument(id: string): InputDocument {
    const row = this.db
      .prepare('SELECT body FROM exchange_documents WHERE id=?')
      .get(id);
    if (!row) throw new StoreError(404, 'Definition or suite was not found.');
    const parsed = inputDocumentSchema.safeParse(JSON.parse(String(row.body)));
    if (!parsed.success)
      throw new StoreError(409, 'Unsupported exchange record format.');
    return parsed.data;
  }
  saveDocuments(documents: InputDocument[], actor: string): SavedDocument[] {
    this.actor(actor);
    const remember = (saved: SavedDocument, document: InputDocument) => {
      if (
        document.kind === 'experiment-suite' &&
        document.cases.some((c) => c.expected && Object.keys(c.expected).length)
      )
        this.noteExpectedSeen(saved.id, actor);
      return saved;
    };
    return this.transaction(() =>
      documents.map((document) => {
        const found = this.listDocuments().find(
          (d) =>
            d.kind === document.kind &&
            d.name === document.name &&
            d.version === document.version,
        );
        if (found) {
          // Ordering is part of the exchanged input, including Choice criteria.
          if (
            JSON.stringify(this.getDocument(found.id)) !==
            JSON.stringify(document)
          )
            throw new StoreError(
              409,
              'Different content exists under this name and version. Increment version.',
            );
          return remember(found, document);
        }
        const saved: SavedDocument = {
          id: randomUUID(),
          kind: document.kind,
          name: document.name,
          version: document.version,
          createdAt: new Date().toISOString(),
          createdByUserId: actor,
        };
        this.db
          .prepare('INSERT INTO exchange_documents VALUES (?,?,?,?,?,?,?)')
          .run(
            saved.id,
            saved.kind,
            saved.name,
            saved.version,
            JSON.stringify(document),
            actor,
            saved.createdAt,
          );
        return remember(saved, document);
      }),
    );
  }
  noteExpectedSeen(suiteId: string, actor: string) {
    this.actor(actor);
    this.db
      .prepare('INSERT OR IGNORE INTO expected_exposures VALUES (?,?,?)')
      .run(suiteId, actor, new Date().toISOString());
  }
  expectedSeenAt(suiteId: string, actor: string): string | null {
    return (
      (this.db
        .prepare(
          'SELECT seen_at FROM expected_exposures WHERE suite_id=? AND user_id=?',
        )
        .get(suiteId, actor)?.seen_at as string | undefined) ?? null
    );
  }
  putSuiteExecution(execution: SuiteExecution) {
    this.db
      .prepare(
        'INSERT INTO suite_executions VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(execution.id, execution.suiteId, JSON.stringify(execution));
  }
  getSuiteExecution(id: string): SuiteExecution {
    const row = this.db
      .prepare('SELECT body FROM suite_executions WHERE id=?')
      .get(id);
    if (!row) throw new StoreError(404, 'Suite execution was not found.');
    const parsed = suiteExecutionSchema.safeParse(JSON.parse(String(row.body)));
    if (!parsed.success)
      throw new StoreError(409, 'Unsupported suite execution record format.');
    return parsed.data;
  }
  listSuiteExecutions(suiteId?: string): SuiteExecution[] {
    return this.db
      .prepare(
        `SELECT body FROM suite_executions ${suiteId ? 'WHERE suite_id=?' : ''} ORDER BY rowid DESC`,
      )
      .all(...(suiteId ? [suiteId] : []))
      .map((r) => {
        const parsed = suiteExecutionSchema.safeParse(
          JSON.parse(String(r.body)),
        );
        if (!parsed.success)
          throw new StoreError(
            409,
            'Unsupported suite execution record format.',
          );
        return parsed.data;
      });
  }
  suiteForRun(runId: string) {
    const row = this.db
      .prepare(
        'SELECT execution_id,case_id FROM suite_run_links WHERE run_id=?',
      )
      .get(runId);
    return row
      ? {
          execution: this.getSuiteExecution(String(row.execution_id)),
          caseId: String(row.case_id),
        }
      : null;
  }
  interruptSuiteExecutions() {
    for (const e of this.listSuiteExecutions().filter(
      (e) => e.status === 'running',
    )) {
      e.status = 'interrupted';
      e.finishedAt = new Date().toISOString();
      for (const c of e.cases.filter((c) => c.status === 'running')) {
        c.status = 'interrupted';
        const a = c.attempts.at(-1)!;
        a.status = 'interrupted';
        a.finishedAt = new Date().toISOString();
        a.error = {
          code: 'interrupted',
          message:
            'Interrupted by a server restart. Check the provider before resending.',
        };
      }
      this.putSuiteExecution(e);
    }
  }
  close() {
    this.db.close();
  }
}
