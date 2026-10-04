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
                  : '質問が成立する場合は Yes、成立しない場合は No'}
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
              正解ラベル
              <select
                aria-label={`正解 ${id}`}
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
                <option value="">未選択</option>
                {Object.entries(q.criteria).map(([k, v]) => (
                  <option key={k} value={k}>
                    {k} · {pretty(v) ?? '説明なし'}
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
        setError(e instanceof Error ? e.message : '処理に失敗しました。');
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (!runId)
    return (
      <div className="panel empty">
        <h1>Evaluation</h1>
        <p>実行履歴を選んで、正解ラベルを付けてください。</p>
        <p>ブラインド実行なら、ラベル確定まで回答は届きません。</p>
      </div>
    );
  if (!data)
    return (
      <div className="panel">
        {error ? <p role="alert">{error}</p> : '評価を読み込んでいます…'}
      </div>
    );
  const selected =
    evaluation?.revisions.find((r) => r.id === revisionId) ??
    comparison?.references.find((r) => r.id === revisionId);
  const graded =
    selected && evaluation
      ? grade(evaluation.run, selected.labels, draft.settings)
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
          <p>{user.name} の独立したラベル付け</p>
        </div>
        <span className="status">
          {data.exposure === 'blind'
            ? '回答未公開'
            : data.exposure === 'unknown'
              ? '旧データ：閲覧状況不明'
              : '回答閲覧済み'}
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
          ? '回答公開後の修正は新しい版として保存します。元のラベルは保持されます。'
          : 'モデルの回答・確率と他の評価者のラベルは隠しています。全ラベルの確定後に回答を公開します。'}{' '}
        {data.exposure === 'unknown' &&
          'この結果は過去に閲覧された可能性があるため、ブラインドだったとは扱いません。'}
      </div>
      <div className="toolbar">
        <span className="progress">
          ラベル {Object.keys(draft.labels).length} /{' '}
          {Object.keys(data.run.query.questions).length}
        </span>
        <button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await save();
              setNotice('ラベルの下書きを保存しました。');
            })
          }
        >
          下書きを保存
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
            ? '新しいラベル版を確定'
            : 'ラベルを確定して回答を公開'}
        </button>
      </div>
      <div className="columns">
        <section className="panel">
          <h2>入力と人による正解</h2>
          <pre className="state-snapshot">{pretty(data.run.query.state)}</pre>
          <p className="hint">
            実行者：
            {users.find((u) => u.id === data.executedByUserId)?.name ??
              '旧データ・作成者不明'}{' '}
            · {new Date(data.run.createdAt).toLocaleString('ja-JP')}
          </p>
          <LabelControls
            query={data.run.query}
            labels={draft.labels}
            change={change}
          />
          <label>
            評価メモ
            <textarea
              aria-label="評価メモ"
              value={draft.note}
              maxLength={4000}
              onChange={(e) => {
                dirty.current = true;
                setDraft((d) => ({ ...d, note: e.target.value }));
              }}
            />
          </label>
          <details>
            <summary>評価者の割り当て</summary>
            {data.assignments.map((a) => (
              <p key={a.userId}>
                {a.name} · {a.finalized ? '確定済み' : '未確定'}
              </p>
            ))}
            <select
              aria-label="評価者を追加"
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
              <option value="">評価者を追加…</option>
              {users
                .filter(
                  (u) =>
                    u.kind === 'local' &&
                    !data.assignments.some((a) => a.userId === u.id),
                )
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </details>
          {!data.revealed && (
            <details>
              <summary>ラベル確定前に回答を見る</summary>
              <p className="validation">
                先に回答を見ると、この評価者の以後のラベルは「閲覧後」と記録されます。元には戻せません。
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
                先に回答を公開する
              </button>
            </details>
          )}
        </section>
        <section className="panel">
          {!evaluation ? (
            <div className="empty">
              <h3>ブラインド評価</h3>
              <p>正解を付け終わるまで、回答は表示しません。</p>
            </div>
          ) : (
            <>
              <h2>評価結果</h2>
              {evaluation.revisions.length > 0 && (
                <label>
                  ラベル版
                  <select
                    aria-label="ラベル版"
                    value={revisionId}
                    onChange={(e) => setRevisionId(e.target.value)}
                  >
                    {[
                      ...evaluation.revisions,
                      ...(comparison?.references ?? []),
                    ].map((r, i) => (
                      <option key={r.id} value={r.id}>
                        {r.kind === 'reference' ? '採用正解' : '自分のラベル'} #
                        {i + 1} ·{' '}
                        {r.exposure === 'blind'
                          ? '公開前に確定'
                          : r.exposure === 'unknown'
                            ? '閲覧状況不明'
                            : '閲覧後に確定'}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {graded && (
                <>
                  <div className="metrics">
                    <div>
                      <small>NOUL 正解 / 対象</small>
                      <strong>
                        {graded.noul.correct} / {graded.noul.total}
                      </strong>
                    </div>
                    <div>
                      <small>CHOICE 正解 / 対象</small>
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
                    Score 許容範囲内：{graded.score.correct} /{' '}
                    {graded.score.total}
                  </p>
                  <p>
                    {graded.allPass
                      ? '全質問が判定基準を満たしています。'
                      : '判定基準を満たさない質問があります。'}
                  </p>
                  <div className="grading-settings">
                    <label>
                      Noul 閾値
                      <input
                        aria-label="Noul 閾値"
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
                      Score 許容誤差
                      <input
                        aria-label="Score 許容誤差"
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
                    閾値・許容誤差の変更は保存済み回答で再集計します。API
                    再実行はありません。元の版の設定：
                    {JSON.stringify(selected!.settings)}
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={onlyWrong}
                      onChange={(e) => setOnlyWrong(e.target.checked)}
                    />{' '}
                    誤りだけ表示
                  </label>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>質問</th>
                          <th>正解</th>
                          <th>回答</th>
                          <th>結果</th>
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
                                {r.pass ? '正解' : '不一致'}
                                {r.error !== null &&
                                  ` · 誤差 ${r.error.toFixed(3)}`}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <details>
                <summary>モデル回答・確率を見る</summary>
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
                入力と質問を Playground にコピー
              </button>
              <div className="comparison">
                <h3>評価者の比較と採用正解</h3>
                <p className="hint">
                  割り当てた全員が確定してから比較できます。
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      setComparison(await request(`runs/${runId}/comparison`));
                    })
                  }
                >
                  確定ラベルを比較
                </button>
                {comparison && (
                  <>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>質問</th>
                            {comparison.revisions.map((r) => (
                              <th key={r.id}>
                                {users.find((u) => u.id === r.userId)?.name}
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
                                  ? ' · 不一致'
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
                      協議して採用する正解（個人のラベルは変更されません）
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
                          setNotice('採用正解を別版として保存しました。');
                        })
                      }
                    >
                      採用正解を確定
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
