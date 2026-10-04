import { it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../server/store';
import { createApp } from '../server/app';
import { initialQuery, validateResponse, type Run } from '../shared/schema';
import {
  grade,
  emptyDraft,
  validateLabels,
  type Draft,
} from '../shared/evaluation';
import { fixture } from './fixture';
const run: Omit<Run, 'id'> = {
  title: 'Blind test',
  query: initialQuery,
  response: validateResponse(fixture, initialQuery),
  createdAt: new Date().toISOString(),
  elapsedMs: 10,
};
const draft: Draft = {
  ...emptyDraft(),
  labels: { is_urgent: true, department: 'billing', frustration: 1 },
};
it('migrates v0 with exact payload preservation and a restorable backup; repeated startup is stable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-migrate-'));
  const path = join(dir, 'db.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(
      'PRAGMA journal_mode=WAL;CREATE TABLE runs(id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE experiments(id TEXT PRIMARY KEY,body TEXT NOT NULL);',
    );
    const payload = JSON.stringify({ ...run, id: 'old' }, null, 2);
    db.prepare('INSERT INTO runs VALUES (?,?)').run('old', payload);
    db.prepare('INSERT INTO experiments VALUES (?,?)').run(
      'experiment',
      JSON.stringify({ id: 'experiment', query: initialQuery, title: 'Old' }),
    );
    const store = await Store.open(path);
    expect(store.getRun('old').title).toBe('Blind test');
    expect(store.attribution('old').userId).toBe('legacy-unknown');
    expect(store.labeling('old', store.actor()).exposure).toBe('unknown');
    store.close();
    db.close();
    const inspect = new DatabaseSync(path);
    expect(inspect.prepare('SELECT body FROM runs').get()!.body).toBe(payload);
    expect(inspect.prepare('PRAGMA user_version').get()!.user_version).toBe(
      SCHEMA_VERSION,
    );
    inspect.close();
    const backups = readdirSync(dir).filter((p) => p.includes('backup'));
    expect(backups).toHaveLength(1);
    copyFileSync(join(dir, backups[0]), join(dir, 'restore.sqlite'));
    const restored = new DatabaseSync(join(dir, 'restore.sqlite'));
    expect(restored.prepare('SELECT body FROM runs').get()!.body).toBe(payload);
    expect(restored.prepare('PRAGMA user_version').get()!.user_version).toBe(0);
    restored.close();
    const again = await Store.open(path);
    expect(again.listUsers()).toHaveLength(2);
    again.close();
    expect(readdirSync(dir).filter((p) => p.includes('backup'))).toHaveLength(
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('refuses future schemas unchanged and rolls back a failed migration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-future-'));
  try {
    const path = join(dir, 'future.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version=99;');
    db.close();
    await expect(Store.open(path)).rejects.toThrow('newer');
    const check = new DatabaseSync(path);
    expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(99);
    check.close();
    const bad = join(dir, 'bad.sqlite');
    const d = new DatabaseSync(bad);
    d.exec('CREATE TABLE users(x);');
    d.close();
    await expect(Store.open(bad)).rejects.toThrow();
    const inspect = new DatabaseSync(bad);
    expect(inspect.prepare('PRAGMA user_version').get()!.user_version).toBe(0);
    expect(
      inspect
        .prepare("SELECT name FROM sqlite_master WHERE name='attribution'")
        .get(),
    ).toBeUndefined();
    inspect.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('isolates evaluator drafts/exposure; gates comparison and preserves adoption and label revisions', () => {
  const s = new Store(':memory:');
  try {
    const a = s.actor(),
      b = s.addUser('Reviewer').id;
    const r = s.saveRun(run, a, true);
    s.assign(r.id, b);
    s.saveDraft(r.id, a, draft);
    expect(s.labeling(r.id, b).draft.labels).toEqual({});
    expect(() => s.comparison(r.id, a)).toThrow();
    expect(() => s.finalize(r.id, b, emptyDraft())).toThrow();
    s.finalize(r.id, a, draft);
    expect(s.labeling(r.id, b).exposure).toBe('blind');
    expect(s.listRuns(b)).toHaveLength(0);
    expect(() => s.evaluation(r.id, b)).toThrow();
    s.finalize(r.id, b, {
      ...draft,
      labels: { ...draft.labels, is_urgent: false },
    });
    const comparison = s.comparison(r.id, a);
    expect(comparison.revisions).toHaveLength(2);
    const adopted = s.adopt(
      r.id,
      a,
      draft,
      comparison.revisions.map((r) => r.id),
    );
    expect(adopted.kind).toBe('reference');
    expect(s.revisions(r.id, b)[0].labels.is_urgent).toBe(false);
    s.finalize(r.id, a, { ...draft, note: 'Changed after reveal' });
    expect(s.revisions(r.id, a).map((r) => r.exposure)).toEqual([
      'blind',
      'exposed',
    ]);
    expect(() =>
      s.adopt(
        r.id,
        a,
        draft,
        comparison.revisions.map((r) => r.id),
      ),
    ).toThrow('更新');
    const c = s.addUser('Third').id;
    s.assign(r.id, c);
    expect(() => s.comparison(r.id, a)).toThrow();
    expect(() => s.assign(r.id, 'missing')).toThrow();
  } finally {
    s.close();
  }
});
it('grades threshold equality, unrounded score error, zero denominators, and invalid labels', () => {
  const full = { ...run, id: 'test' };
  const g = grade(full, draft.labels, { threshold: 0.9, tolerance: 0.5 });
  expect(g.allPass).toBe(true);
  expect(g.score.mae).toBe(0.5);
  expect(
    grade(full, draft.labels, { threshold: 0.91, tolerance: 0.49 }).allPass,
  ).toBe(false);
  expect(() => validateLabels(initialQuery, { frustration: 3 })).toThrow();
  expect(() => validateLabels(initialQuery, { department: 'none' })).toThrow();
  expect(() => validateLabels(initialQuery, { is_urgent: 'yes' })).toThrow();
  const only = {
    ...full,
    query: {
      ...initialQuery,
      questions: { is_urgent: initialQuery.questions.is_urgent },
    },
  };
  expect(
    grade(only, { is_urgent: true }, { threshold: 0.5, tolerance: 0.5 }).score
      .mae,
  ).toBeNull();
});
it('blind endpoints return no answers or scoring; draft/regrade routes do not call the provider', async () => {
  const s = new Store(':memory:');
  try {
    const provider = { evaluate: vi.fn(async () => run.response) },
      app = createApp(s, provider, true);
    const a = s.actor(),
      b = s.addUser('Other').id;
    const req = (path: string, body?: unknown, user = a, method = 'POST') =>
      app.request(`/api/${path}`, {
        method: body ? method : 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Local-User': user },
        body: body ? JSON.stringify(body) : undefined,
      });
    const res = await req('runs', {
      title: run.title,
      query: run.query,
      blind: true,
    });
    expect(res.status).toBe(201);
    const safe = await res.json();
    const id = safe.run.id;
    expect(JSON.stringify(safe)).not.toMatch(
      /"(answers|response|confidence|probabilities|usage)"/,
    );
    expect(await (await req('runs')).json()).toEqual([]);
    expect((await req(`runs/${id}/evaluation`)).status).toBe(403);
    expect((await req(`runs/${id}/labels`, draft, a, 'PUT')).status).toBe(200);
    expect((await req(`runs/${id}/finalize`, emptyDraft())).status).toBe(400);
    expect((await req(`runs/${id}/finalize`, draft)).status).toBe(200);
    expect((await req(`runs/${id}/evaluation`, undefined, b)).status).toBe(403);
    expect(
      JSON.stringify(
        await (await req(`runs/${id}/labeling`, undefined, b)).json(),
      ),
    ).not.toContain('probabilities');
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
  } finally {
    s.close();
  }
});
it('annotations and provenance survive restart without another provider request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-reopen-'));
  try {
    const path = join(dir, 'db.sqlite');
    let s = await Store.open(path);
    const actor = s.actor(),
      other = s.addUser('Second').id;
    const saved = s.saveRun(run, actor, true);
    s.assign(saved.id, other);
    s.saveDraft(saved.id, other, {
      ...emptyDraft(),
      labels: { is_urgent: false },
    });
    s.finalize(saved.id, actor, draft);
    s.close();
    s = await Store.open(path);
    expect(s.labeling(saved.id, other).draft.labels).toEqual({
      is_urgent: false,
    });
    expect(s.labeling(saved.id, other).revealed).toBe(false);
    expect(s.evaluation(saved.id, actor).revisions[0].exposure).toBe('blind');
    s.close();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys=ON');
    expect(() =>
      db
        .prepare('INSERT INTO assignments VALUES (?,?)')
        .run('nonexistent', actor),
    ).toThrow();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('pins the execution actor before awaiting inference and never trusts an unknown actor', async () => {
  const s = new Store(':memory:');
  try {
    const a = s.actor(),
      b = s.addUser('Second').id;
    let release!: () => void;
    const provider = {
      evaluate: vi.fn(async () => {
        await new Promise<void>((r) => (release = r));
        return run.response;
      }),
    };
    const app = createApp(s, provider, true);
    const req = (actor: string) =>
      app.request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Local-User': actor },
        body: JSON.stringify({
          title: run.title,
          query: run.query,
          blind: true,
        }),
      });
    expect((await req('missing')).status).toBe(400);
    expect(provider.evaluate).not.toHaveBeenCalled();
    const pending = req(a);
    await new Promise((r) => setTimeout(r, 5));
    expect(
      (
        await app.request('/api/runs/summaries', {
          headers: { 'X-Local-User': b },
        })
      ).status,
    ).toBe(200);
    release();
    const result = await (await pending).json();
    expect(s.attribution(result.run.id).userId).toBe(a);
  } finally {
    s.close();
  }
});
