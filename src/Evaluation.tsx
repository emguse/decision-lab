import { displayUserName } from './user-name';
import { gradePartial, aggregateGrades } from '../shared/exchange';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { api } from './api';
import { ResultView } from './ResultView';
import {
  emptyDraft,
  grade,
  type Draft,
  type Labels,
  type Labeling,
  type Evaluation,
  type LocalUser,
  type Revision,
} from '../shared/evaluation';
import type { ProviderId } from '../shared/providers';
import type { Query } from '../shared/schema';
const pretty = (v: unknown) =>
  typeof v === 'string' ? v : JSON.stringify(v, null, 2);
function LabelControls({
  query,
  labels,
  change,
}: {
  query: Query;
  labels: Labels;
  change: (labels: Labels) => void;
}) {
  return (
    <>
      {Object.entries(query.questions).map(([id, q]) => (
        <article className="question" key={id}>
          <div className="answer-heading">
            <h3>{id}</h3>
            <span className="badge">{q.type}</span>
          </div>
          <p className="instructions">{pretty(q.instructions)}</p>
          {q.type === 'noul' ? (
            <>
              <p className="hint">
                {q.criteria
                  ? pretty(q.criteria)
                  : 'Choose Yes if the condition holds, otherwise No'}
              </p>
              <div className="yes-no">
                {[true, false].map((v) => (
                  <label key={String(v)}>
                    <input
                      type="radio"
                      name={`label-${id}`}
                      aria-label={`${id} ${v ? 'Yes' : 'No'}`}
                      checked={labels[id] === v}
                      onChange={() => change({ ...labels, [id]: v })}
                    />
                    {v ? 'Yes' : 'No'}
                  </label>
                ))}
              </div>
            </>
          ) : (
            <label>
              Reference label
              <select
                aria-label={`Reference ${id}`}
                value={labels[id] === undefined ? '' : String(labels[id])}
                onChange={(e) => {
                  const next = { ...labels };
                  if (e.target.value === '') delete next[id];
                  else
                    next[id] =
                      q.type === 'score'
                        ? Number(e.target.value)
                        : e.target.value;
                  change(next);
                }}
              >
                <option value="">Not selected</option>
                {Object.entries(q.criteria).map(([k, v]) => (
                  <option key={k} value={k}>
                    {k} · {pretty(v) ?? 'No description'}
                  </option>
                ))}
              </select>
            </label>
          )}
        </article>
      ))}
    </>
  );
}
export function EvaluationWorkspace({
  runId,
  user,
  users,
  beforeSwitch,
  onCopy,
  onChanged,
}: {
  runId: string | null;
  user: LocalUser;
  users: LocalUser[];
  beforeSwitch: MutableRefObject<null | (() => Promise<void>)>;
  onCopy: (q: Query, t: string, provider?: ProviderId) => void;
  onChanged: () => Promise<void>;
}) {
  const [suiteReference, setSuiteReference] = useState<{
    expected: Labels;
    settings: Draft['settings'];
    note: string;
    expectedSeenAt: string | null;
  } | null>(null);
  const [data, setData] = useState<Labeling | null>(null),
    [draft, setDraft] = useState<Draft>(emptyDraft),
    [evaluation, setEvaluation] = useState<Evaluation | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [onlyWrong, setOnlyWrong] = useState(false),
    [revisionId, setRevisionId] = useState('');
  const [comparison, setComparison] = useState<{
      revisions: Revision[];
      references: Revision[];
    } | null>(null),
    [adoptLabels, setAdoptLabels] = useState<Labels>({});
  const draftRef = useRef(draft),
    dirty = useRef(false),
    lock = useRef(false),
    mounted = useRef(true);
  draftRef.current = draft;
  const request = <T,>(path: string, body?: unknown, method = 'POST') =>
    api<T>(path, body, method, user.id);
  async function save() {
    if (!runId || !dirty.current) return;
    await request(`runs/${runId}/labels`, draftRef.current, 'PUT');
    dirty.current = false;
  }
  useEffect(() => {
    mounted.current = true;
    beforeSwitch.current = save;
    return () => {
      mounted.current = false;
      beforeSwitch.current = null;
    };
  }, [runId, user.id]);
  async function load() {
    if (!runId) return;
    const v = await request<Labeling>(`runs/${runId}/labeling`);
    if (!mounted.current) return;
    setData(v);
    setDraft(v.draft);
    dirty.current = false;
    if (v.revealed) {
      const e = await request<Evaluation>(`runs/${runId}/evaluation`);
      const reference = await request<typeof suiteReference>(
        `runs/${runId}/suite-reference`,
      );
      if (mounted.current) setSuiteReference(reference);
      if (mounted.current) {
        setEvaluation(e);
        setRevisionId(e.revisions.at(-1)?.id ?? '');
      }
    }
  }
  useEffect(() => {
    load().catch((e) => {
      if (mounted.current) setError(e.message);
    });
  }, [runId]);
  function change(labels: Labels) {
    dirty.current = true;
    setDraft((d) => ({ ...d, labels }));
  }
  async function action(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      if (mounted.current) await onChanged();
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : 'The operation failed.');
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (!runId)
    return (
      <div className="panel empty">
        <h1>Evaluation</h1>
        <p>Select a saved run to add reference labels.</p>
        <p>For blind runs, answers remain hidden until you finalize labels.</p>
      </div>
    );
  if (!data)
    return (
      <div className="panel">
        {error ? <p role="alert">{error}</p> : 'Loading evaluation…'}
      </div>
    );
  const selected =
    evaluation?.revisions.find((r) => r.id === revisionId) ??
    comparison?.references.find((r) => r.id === revisionId);
  const graded =
    selected && evaluation
      ? grade(evaluation.run, selected.labels, draft.settings)
      : null;
  const expectedGrade =
    evaluation && suiteReference && Object.keys(suiteReference.expected).length
      ? gradePartial(
          evaluation.run,
          suiteReference.expected,
          suiteReference.settings,
          'expected',
          null,
        )
      : null;
  const expectedSummary = expectedGrade
    ? aggregateGrades(
        [{ status: 'succeeded', grading: expectedGrade }],
        Object.keys(data.run.query.questions).length,
      )
    : null;
  const complete =
    Object.keys(draft.labels).length ===
    Object.keys(data.run.query.questions).length;
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">EVALUATION / HUMAN LABELS</div>
          <h1>{data.run.title}</h1>
          <p>Independent labeling for {displayUserName(user)}</p>
        </div>
        <span className="status">
          {data.exposure === 'blind'
            ? 'Answers hidden'
            : data.exposure === 'unknown'
              ? 'Legacy data: exposure unknown'
              : 'Answers viewed'}
        </span>
      </header>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="setup" role="status">
          {notice}
        </div>
      )}
      <div className="setup">
        {data.revealed
          ? 'Edits after reveal are saved as a new revision. Original labels are retained.'
          : "Model answers, probabilities, and other evaluators' labels are hidden. Finalize all labels to reveal answers."}{' '}
        {data.exposure === 'unknown' &&
          'This result may have been viewed previously, so its labels are not considered blind.'}
      </div>
      {data.expectedExposure && (
        <p className="hint">
          Imported expectations:{' '}
          {data.expectedExposure.seenAt
            ? 'Viewed (recorded separately from model exposure)'
            : 'Not viewed'}
        </p>
      )}
      <div className="toolbar">
        <span className="progress">
          Labels {Object.keys(draft.labels).length} /{' '}
          {Object.keys(data.run.query.questions).length}
        </span>
        <button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await save();
              setNotice('Label draft saved.');
            })
          }
        >
          Save draft
        </button>
        <button
          className="primary"
          disabled={busy || !complete}
          onClick={() =>
            void action(async () => {
              const e = await request<Evaluation>(
                `runs/${runId}/finalize`,
                draftRef.current,
              );
              dirty.current = false;
              setEvaluation(e);
              setRevisionId(e.revisions.at(-1)!.id);
              await load();
            })
          }
        >
          {data.revealed
            ? 'Finalize new label revision'
            : 'Finalize labels and reveal answers'}
        </button>
      </div>
      <div className="columns">
        <section className="panel">
          <h2>Input and human reference labels</h2>
          <pre className="state-snapshot">{pretty(data.run.query.state)}</pre>
          <p className="hint">
            Executed by:{' '}
            {displayUserName(users.find((u) => u.id === data.executedByUserId))}{' '}
            · {new Date(data.run.createdAt).toLocaleString('en-US')}
          </p>
          <LabelControls
            query={data.run.query}
            labels={draft.labels}
            change={change}
          />
          <label>
            Evaluation note
            <textarea
              aria-label="Evaluation note"
              value={draft.note}
              maxLength={4000}
              onChange={(e) => {
                dirty.current = true;
                setDraft((d) => ({ ...d, note: e.target.value }));
              }}
            />
          </label>
          <details>
            <summary>Evaluator assignments</summary>
            {data.assignments.map((a) => (
              <p key={a.userId}>
                {displayUserName(users.find((u) => u.id === a.userId))} ·{' '}
                {a.finalized ? 'Finalized' : 'Not finalized'}
              </p>
            ))}
            <select
              aria-label="Add evaluator"
              defaultValue=""
              disabled={busy}
              onChange={(e) => {
                const id = e.target.value;
                e.target.value = '';
                if (id)
                  void action(async () => {
                    await save();
                    await request(`runs/${runId}/assignments`, { userId: id });
                    setComparison(null);
                    await load();
                  });
              }}
            >
              <option value="">Add evaluator…</option>
              {users
                .filter(
                  (u) =>
                    u.kind === 'local' &&
                    !data.assignments.some((a) => a.userId === u.id),
                )
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {displayUserName(u)}
                  </option>
                ))}
            </select>
          </details>
          {!data.revealed && (
            <details>
              <summary>View answers before finalizing labels</summary>
              <p className="validation">
                Revealing answers marks this evaluator's subsequent labels as
                post-reveal. This cannot be undone.
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await save();
                    await request(`runs/${runId}/reveal`, {});
                    await load();
                  })
                }
              >
                Reveal answers now
              </button>
            </details>
          )}
        </section>
        <section className="panel">
          {!evaluation ? (
            <div className="empty">
              <h3>Blind evaluation</h3>
              <p>Answers remain hidden until you finish labeling.</p>
            </div>
          ) : (
            <>
              <h2>Evaluation results</h2>
              {suiteReference && (
                <div className="setup">
                  <h3>Comparison with imported expectations</h3>
                  <p>
                    These reference values are separate from finalized human
                    labels.
                    {expectedSummary
                      ? `Noul ${expectedSummary.noul.correct}/${expectedSummary.noul.total} · Choice ${expectedSummary.choice.correct}/${expectedSummary.choice.total} · Score MAE ${expectedSummary.score.mae?.toFixed(3) ?? '—'} · Missing labels ${expectedSummary.missingLabels}`
                      : 'No expectations specified.'}
                  </p>
                  <pre className="state-snapshot">
                    {pretty(suiteReference.expected)}
                  </pre>
                  {suiteReference.note && <p>{suiteReference.note}</p>}
                </div>
              )}
              {evaluation.revisions.length > 0 && (
                <label>
                  Label revision
                  <select
                    aria-label="Label revision"
                    value={revisionId}
                    onChange={(e) => setRevisionId(e.target.value)}
                  >
                    {[
                      ...evaluation.revisions,
                      ...(comparison?.references ?? []),
                    ].map((r, i) => (
                      <option key={r.id} value={r.id}>
                        {r.kind === 'reference'
                          ? 'Adopted reference'
                          : 'My labels'}{' '}
                        #{i + 1} ·{' '}
                        {r.exposure === 'blind'
                          ? 'Finalized before reveal'
                          : r.exposure === 'unknown'
                            ? 'Exposure unknown'
                            : 'Finalized after reveal'}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {graded && (
                <>
                  <div className="metrics">
                    <div>
                      <small>NOUL CORRECT / GRADED</small>
                      <strong>
                        {graded.noul.correct} / {graded.noul.total}
                      </strong>
                    </div>
                    <div>
                      <small>CHOICE CORRECT / GRADED</small>
                      <strong>
                        {graded.choice.correct} / {graded.choice.total}
                      </strong>
                    </div>
                    <div>
                      <small>SCORE MAE</small>
                      <strong>{graded.score.mae?.toFixed(3) ?? '—'}</strong>
                    </div>
                  </div>
                  <p className="hint">
                    Score within tolerance: {graded.score.correct} /{' '}
                    {graded.score.total}
                  </p>
                  <p>
                    {graded.allPass
                      ? 'All questions meet the grading criteria.'
                      : 'Some questions do not meet the grading criteria.'}
                  </p>
                  <div className="grading-settings">
                    <label>
                      Noul threshold
                      <input
                        aria-label="Noul threshold"
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={draft.settings.threshold}
                        onChange={(e) => {
                          const v = e.target.valueAsNumber;
                          if (Number.isFinite(v) && v >= 0 && v <= 1) {
                            dirty.current = true;
                            setDraft((d) => ({
                              ...d,
                              settings: { ...d.settings, threshold: v },
                            }));
                          }
                        }}
                      />
                    </label>
                    <label>
                      Score tolerance
                      <input
                        aria-label="Score tolerance"
                        type="number"
                        min={0}
                        step={0.1}
                        value={draft.settings.tolerance}
                        onChange={(e) => {
                          const v = e.target.valueAsNumber;
                          if (Number.isFinite(v) && v >= 0) {
                            dirty.current = true;
                            setDraft((d) => ({
                              ...d,
                              settings: { ...d.settings, tolerance: v },
                            }));
                          }
                        }}
                      />
                    </label>
                  </div>
                  <p className="hint">
                    Changing the threshold or tolerance regrades saved answers
                    without another API request. Original revision settings:
                    {JSON.stringify(selected!.settings)}
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={onlyWrong}
                      onChange={(e) => setOnlyWrong(e.target.checked)}
                    />{' '}
                    Show errors only
                  </label>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Questions</th>
                          <th>Reference</th>
                          <th>Answer</th>
                          <th>Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {graded.rows
                          .filter((r) => !onlyWrong || !r.pass)
                          .map((r) => (
                            <tr key={r.id}>
                              <td>{r.id}</td>
                              <td>{String(r.expected)}</td>
                              <td>{String(r.predicted)}</td>
                              <td>
                                {r.pass ? 'Correct' : 'Mismatch'}
                                {r.error !== null &&
                                  ` · Error ${r.error.toFixed(3)}`}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <details>
                <summary>View model answers and probabilities</summary>
                <ResultView result={evaluation.run} />
              </details>
              <button
                onClick={() =>
                  onCopy(
                    data.run.query,
                    data.run.title,
                    evaluation.run.execution?.provider,
                  )
                }
              >
                Copy input and questions to Playground
              </button>
              <div className="comparison">
                <h3>Evaluator comparison and adopted references</h3>
                <p className="hint">
                  Comparison is available after all assigned evaluators
                  finalize.
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      setComparison(await request(`runs/${runId}/comparison`));
                    })
                  }
                >
                  Compare finalized labels
                </button>
                {comparison && (
                  <>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Questions</th>
                            {comparison.revisions.map((r) => (
                              <th key={r.id}>
                                {displayUserName(
                                  users.find((u) => u.id === r.userId),
                                )}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {Object.keys(data.run.query.questions).map((id) => (
                            <tr key={id}>
                              <td>
                                {id}
                                {new Set(
                                  comparison.revisions.map((r) => r.labels[id]),
                                ).size > 1
                                  ? ' · Disagreement'
                                  : ''}
                              </td>
                              {comparison.revisions.map((r) => (
                                <td key={r.id}>{String(r.labels[id])}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <h3>
                      Agreed reference labels (individual labels remain
                      unchanged)
                    </h3>
                    <LabelControls
                      query={data.run.query}
                      labels={adoptLabels}
                      change={setAdoptLabels}
                    />
                    <button
                      disabled={
                        busy ||
                        Object.keys(adoptLabels).length !==
                          Object.keys(data.run.query.questions).length
                      }
                      onClick={() =>
                        void action(async () => {
                          const r = await request<Revision>(
                            `runs/${runId}/adopt`,
                            {
                              ...draft,
                              labels: adoptLabels,
                              sourceRevisionIds: comparison.revisions.map(
                                (r) => r.id,
                              ),
                            },
                          );
                          setComparison((c) =>
                            c ? { ...c, references: [...c.references, r] } : c,
                          );
                          setRevisionId(r.id);
                          setNotice(
                            'Adopted references saved as a separate revision.',
                          );
                        })
                      }
                    >
                      Save adopted references
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
