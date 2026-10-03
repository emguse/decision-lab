import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Run, Query } from '../shared/schema.js';
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY, body TEXT NOT NULL);`,
    );
  }
  saveRun(run: Omit<Run, 'id'>): Run {
    const saved = { ...run, id: randomUUID() };
    this.db
      .prepare('INSERT INTO runs VALUES (?,?)')
      .run(saved.id, JSON.stringify(saved));
    return saved;
  }
  listRuns(): Run[] {
    return this.db
      .prepare('SELECT body FROM runs ORDER BY rowid DESC LIMIT 100')
      .all()
      .map((r) => JSON.parse(String(r.body)));
  }
  saveExperiment(title: string, query: Query) {
    const saved = {
      id: randomUUID(),
      title,
      query,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO experiments VALUES (?,?)')
      .run(saved.id, JSON.stringify(saved));
    return saved;
  }
  listExperiments() {
    return this.db
      .prepare('SELECT body FROM experiments ORDER BY rowid DESC LIMIT 100')
      .all()
      .map((r) => JSON.parse(String(r.body)));
  }
  close() {
    this.db.close();
  }
}
