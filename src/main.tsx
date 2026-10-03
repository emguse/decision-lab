import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  initialQuery,
  requestSchema,
  type Query,
  type Question,
  type Run,
} from '../shared/schema';
import './style.css';
type Experiment = {
  id: string;
  title: string;
  query: Query;
  createdAt: string;
};
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    `/api/${path}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '処理に失敗しました。');
  return data;
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const DraftValidity = createContext<(label: string, invalid: boolean) => void>(
  () => {},
);
function App() {
  const [invalidFields, setInvalidFields] = useState<Record<string, boolean>>(
    {},
  );
  const fieldError = Object.values(invalidFields).some(Boolean);
  const reportInvalid = React.useCallback(
    (label: string, invalid: boolean) =>
      setInvalidFields((prev) =>
        prev[label] === invalid ? prev : { ...prev, [label]: invalid },
      ),
    [],
  );
  const [query, setQuery] = useState<Query>(initialQuery),
    [json, setJson] = useState(pretty(initialQuery)),
    [mode, setMode] = useState<'form' | 'json'>('form');
  const [title, setTitle] = useState('サポート依頼のトリアージ'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [configured, setConfigured] = useState<boolean | null>(null);
  const [runs, setRuns] = useState<Run[]>([]),
    [experiments, setExperiments] = useState<Experiment[]>([]),
    [result, setResult] = useState<Run | null>(null);
  const lock = useRef(false);
  const valid = requestSchema.safeParse(query);
  const parseJson = () => {
    try {
      return requestSchema.parse(JSON.parse(json));
    } catch {
      return null;
    }
  };
  const jsonValid = mode === 'form' || Boolean(parseJson());
  async function refresh() {
    const [r, e, c] = await Promise.all([
      api<Run[]>('runs'),
      api<Experiment[]>('experiments'),
      api<{ configured: boolean }>('config'),
    ]);
    setRuns(r);
    setExperiments(e);
    setConfigured(c.configured);
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  function update(next: Query) {
    setQuery(next);
    setJson(pretty(next));
    setNotice('');
  }
  function load(q: Query, t: string, r: Run | null = null) {
    update(q);
    setTitle(t);
    setResult(r);
    setError('');
    setMode('form');
  }
  async function submit(kind: 'runs' | 'experiments') {
    if (lock.current || fieldError) return;
    const q = mode === 'json' ? parseJson() : valid.success ? valid.data : null;
    if (!q) {
      setError('クエリの形式を確認してください。');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await api<Run | Experiment>(kind, { title, query: q });
      if (kind === 'runs') setResult(saved as Run);
      else setNotice('実験を保存しました。');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '処理に失敗しました。');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function changeQuestion(id: string, q: Question) {
    update({ ...query, questions: { ...query.questions, [id]: q } });
  }
  function addQuestion() {
    let n = 1;
    while (`question_${n}` in query.questions) n++;
    changeQuestion(`question_${n}`, { type: 'noul', instructions: '' });
  }
  return (
    <DraftValidity.Provider value={reportInvalid}>
      <div className="shell">
        <aside>
          <a className="brand" href="/">
            J<span>ev</span>
            <small>DECISION LAB</small>
          </a>
          <div className="workspace">◉ &nbsp; LOCAL WORKSPACE</div>
          <h2>
            保存した実験 <span>{experiments.length}</span>
          </h2>
          {experiments.length === 0 && (
            <p className="muted">実験を保存すると、ここから再利用できます。</p>
          )}
          {experiments.map((e) => (
            <button
              className="history"
              key={e.id}
              onClick={() => load(e.query, e.title)}
            >
              {e.title}
              <small>{new Date(e.createdAt).toLocaleString('ja-JP')}</small>
            </button>
          ))}
          <h2>
            実行履歴 <span>{runs.length}</span>
          </h2>
          {runs.length === 0 && (
            <p className="muted">最初の判断を実行してみましょう。</p>
          )}
          {runs.map((r) => (
            <button
              className="history"
              key={r.id}
              onClick={() => load(r.query, r.title, r)}
            >
              {r.title}
              <small>
                {r.response.model} · {r.elapsedMs} ms
              </small>
            </button>
          ))}
          <footer>
            Typed judgments.
            <br />
            Ideas into decisions.
          </footer>
        </aside>
        <main>
          <header>
            <div>
              <div className="eyebrow">PLAYGROUND / JEV</div>
              <h1>文章は作りません。判断をします。</h1>
              <p>入力と質問を組み立て、モデルの判断を確率で確かめる。</p>
            </div>
            <div className={`status ${configured ? 'ready' : ''}`}>
              ●{' '}
              {configured === null
                ? '接続確認中'
                : configured
                  ? 'API KEY READY'
                  : 'API KEY 未設定'}
            </div>
          </header>
          {configured === false && (
            <div className="setup">
              開始するには <code>.env</code> に <code>TYPESAFE_API_KEY</code>{' '}
              を設定し、サーバーを再起動してください。
            </div>
          )}
          <div className="toolbar">
            <label className="title-label">
              実験名
              <input
                aria-label="実験名"
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <button
              disabled={
                fieldError ||
                busy ||
                !jsonValid ||
                !valid.success ||
                !title.trim()
              }
              onClick={() => submit('experiments')}
            >
              実験を保存
            </button>
            <button
              className="primary"
              disabled={
                fieldError ||
                busy ||
                !configured ||
                !jsonValid ||
                !valid.success ||
                !title.trim()
              }
              onClick={() => submit('runs')}
            >
              {busy ? '処理中…' : '判断を実行 ↗'}
            </button>
          </div>
          {error && (
            <div role="alert" className="alert">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="setup">
              {notice}
            </div>
          )}
          <div className="columns">
            <section className="panel editor">
              <div className="panel-heading">
                <h2>
                  01 <span>クエリを組み立てる</span>
                </h2>
                <div className="tabs">
                  <button
                    aria-pressed={mode === 'form'}
                    onClick={() => {
                      const parsed = parseJson();
                      if (mode === 'json' && !parsed) {
                        setError(
                          'JSON を修正してからフォームへ切り替えてください。',
                        );
                        return;
                      }
                      if (parsed && mode === 'json') update(parsed);
                      setMode('form');
                    }}
                  >
                    フォーム
                  </button>
                  <button
                    aria-pressed={mode === 'json'}
                    onClick={() => {
                      setJson(pretty(query));
                      if (fieldError) {
                        setError(
                          '無効な入力を修正してから切り替えてください。',
                        );
                        return;
                      }
                      setMode('json');
                    }}
                  >
                    JSON
                  </button>
                </div>
              </div>
              <label>
                モデル
                <input
                  aria-label="モデル"
                  value={query.model}
                  onChange={(e) => update({ ...query, model: e.target.value })}
                />
              </label>
              {mode === 'json' ? (
                <>
                  <label>
                    送信 JSON
                    <textarea
                      className="code"
                      aria-label="送信 JSON"
                      rows={24}
                      value={json}
                      onChange={(e) => {
                        setJson(e.target.value);
                        try {
                          const q = requestSchema.parse(
                            JSON.parse(e.target.value),
                          );
                          setQuery(q);
                        } catch {
                          /* preserve invalid draft */
                        }
                      }}
                    />
                  </label>
                  {!jsonValid && (
                    <p role="alert" className="validation">
                      JSON 構文またはクエリの形式が無効です。送信できません。
                    </p>
                  )}
                </>
              ) : (
                <>
                  <StateEditor
                    value={query.state}
                    onChange={(state) => update({ ...query, state })}
                  />
                  <div className="section-title">
                    <h3>
                      質問 <span>{Object.keys(query.questions).length}</span>
                    </h3>
                    <button onClick={addQuestion}>＋ 質問を追加</button>
                  </div>
                  {Object.entries(query.questions).map(([id, q], i) => (
                    <div className="question" key={id}>
                      <div className="question-header">
                        <span className="question-number">
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <input
                          aria-label={`質問ID ${i + 1}`}
                          defaultValue={id}
                          onBlur={(e) => {
                            const next = e.target.value.trim();
                            if (next === id) return;
                            if (!next || Object.hasOwn(query.questions, next)) {
                              e.target.value = id;
                              setError(
                                '質問IDは空にせず、重複しない名前にしてください。',
                              );
                              return;
                            }
                            update({
                              ...query,
                              questions: Object.fromEntries(
                                Object.entries(query.questions).map(
                                  ([key, v]) => [key === id ? next : key, v],
                                ),
                              ),
                            });
                          }}
                        />
                        <select
                          aria-label={`質問タイプ ${i + 1}`}
                          value={q.type}
                          onChange={(e) => {
                            const type = e.target.value as Question['type'];
                            changeQuestion(
                              id,
                              type === 'noul'
                                ? { type, instructions: q.instructions }
                                : type === 'choice'
                                  ? {
                                      type,
                                      instructions: q.instructions,
                                      criteria: {
                                        option_a: '選択肢 A',
                                        option_b: '選択肢 B',
                                      },
                                    }
                                  : {
                                      type,
                                      instructions: q.instructions,
                                      criteria: ['低い', '高い'],
                                    },
                            );
                          }}
                        >
                          <option value="noul">Noul · Yes / No</option>
                          <option value="choice">Choice · 選択</option>
                          <option value="score">Score · 評価</option>
                        </select>
                        <button
                          aria-label={`質問を削除 ${id}`}
                          onClick={() =>
                            update({
                              ...query,
                              questions: Object.fromEntries(
                                Object.entries(query.questions).filter(
                                  ([k]) => k !== id,
                                ),
                              ),
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                      <ContentEditor
                        label={`質問文 ${id}`}
                        value={q.instructions}
                        onChange={(instructions) =>
                          changeQuestion(id, { ...q, instructions })
                        }
                      />
                      {q.type !== 'noul' && (
                        <CriteriaEditor
                          kind={q.type}
                          label={`評価基準 ${id}`}
                          value={q.criteria}
                          onChange={(criteria) => {
                            const parsed =
                              requestSchema.shape.questions.safeParse({
                                [id]: { ...q, criteria },
                              });
                            if (!parsed.success) return false;
                            changeQuestion(id, parsed.data[id]);
                            return true;
                          }}
                        />
                      )}
                      {q.type === 'noul' && (
                        <details>
                          <summary>Yes / No の基準（任意）</summary>
                          <CriteriaEditor
                            kind="noul"
                            label={`評価基準 ${id}`}
                            value={q.criteria ?? { true: '', false: '' }}
                            onChange={(criteria) => {
                              const parsed =
                                requestSchema.shape.questions.safeParse({
                                  [id]: { ...q, criteria },
                                });
                              if (!parsed.success) return false;
                              changeQuestion(id, parsed.data[id]);
                              return true;
                            }}
                          />
                        </details>
                      )}
                    </div>
                  ))}
                  {!valid.success && (
                    <p className="validation">
                      {valid.error.issues.map((i) => i.message).join(' / ')}
                    </p>
                  )}
                </>
              )}
            </section>
            <section className="panel results">
              <div className="panel-heading">
                <h2>
                  02 <span>判断を読み解く</span>
                </h2>
                <span className="eyebrow">RESPONSE</span>
              </div>
              {!result ? (
                <div className="empty">
                  <div className="empty-icon">⌘</div>
                  <h3>判断が、ここに届きます。</h3>
                  <p>
                    質問を用意して「判断を実行」を押すと、
                    <br />
                    回答と選択肢ごとの確率を確認できます。
                  </p>
                  <div className="legend">
                    <span>Noul</span>
                    <span>Choice</span>
                    <span>Score</span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="metrics">
                    <div>
                      <small>MODEL</small>
                      <strong>{result.response.model}</strong>
                    </div>
                    <div>
                      <small>LATENCY</small>
                      <strong>
                        {result.elapsedMs.toLocaleString()} <small>ms</small>
                      </strong>
                    </div>
                    <div>
                      <small>TOKENS · IN / OUT</small>
                      <strong>
                        {result.response.usage.input_tokens ?? '—'} /{' '}
                        {result.response.usage.output_tokens ?? '—'}
                      </strong>
                    </div>
                  </div>
                  <p className="result-caption">
                    実行時の結果 · {result.title} ·{' '}
                    {new Date(result.createdAt).toLocaleString('ja-JP')}
                  </p>
                  {Object.entries(result.response.answers).map(([id, a]) => (
                    <article className="answer" key={id}>
                      <div className="answer-heading">
                        <h3>{id}</h3>
                        <span className="badge">{a.type}</span>
                      </div>
                      <div className="verdict">
                        {a.type === 'noul'
                          ? `P(Yes) ${(a.noul * 100).toFixed(1)}%`
                          : a.type === 'choice'
                            ? a.choice
                            : a.score.toFixed(3)}
                      </div>
                      {a.type !== 'noul' && (
                        <p className="muted">
                          Confidence {a.confidence.toFixed(3)} ·
                          分布の集中度（正答率ではありません）
                        </p>
                      )}
                      {Object.entries(
                        a.type === 'noul'
                          ? { Yes: a.noul, No: 1 - a.noul }
                          : a.probabilities,
                      ).map(([key, p]) => (
                        <div className="probability" key={key}>
                          <div>
                            <span>
                              {a.type === 'score'
                                ? `${key} · ${a.legend[key]}`
                                : key}
                            </span>
                            <strong>{(p * 100).toFixed(1)}%</strong>
                          </div>
                          <div className="track">
                            <div style={{ width: `${p * 100}%` }} />
                          </div>
                        </div>
                      ))}
                    </article>
                  ))}
                  <details className="raw">
                    <summary>生のレスポンス</summary>
                    <pre>{pretty(result.response)}</pre>
                  </details>
                  <details className="raw">
                    <summary>実行時のクエリ</summary>
                    <pre>{pretty(result.query)}</pre>
                  </details>
                </>
              )}
            </section>
          </div>
          <div className="bottom-note">
            Jev API · 自動再試行なし · 入力と実行結果はこの端末に保存されます
          </div>
        </main>
      </div>
    </DraftValidity.Provider>
  );
}
type CriterionRow = { key: string; value: unknown };
function CriteriaEditor({
  kind,
  label,
  value,
  onChange,
}: {
  kind: 'choice' | 'score' | 'noul' | 'record';
  label: string;
  value: unknown;
  onChange: (value: unknown) => boolean;
}) {
  const reportInvalid = useContext(DraftValidity);
  const toRows = (v: unknown): CriterionRow[] =>
    Object.entries((v ?? {}) as Record<string, unknown>).map(
      ([key, value]) => ({ key, value }),
    );
  const [rows, setRows] = useState(() => toRows(value));
  const [invalid, setInvalid] = useState(false);
  const committed = useRef(pretty(value));
  useEffect(() => {
    if (pretty(value) !== committed.current) {
      setRows(toRows(value));
      setInvalid(false);
      committed.current = pretty(value);
    }
  }, [value]);
  useEffect(() => {
    reportInvalid(label, invalid);
    return () => reportInvalid(label, false);
  }, [label, invalid, reportInvalid]);
  const apply = (next: CriterionRow[]) => {
    setRows(next);
    const keys = next.map((r) => r.key);
    if (
      kind !== 'score' &&
      (keys.some((k) => !k.trim()) || new Set(keys).size !== keys.length)
    ) {
      setInvalid(true);
      return;
    }
    const result =
      kind === 'score'
        ? next.map((r) => r.value)
        : Object.fromEntries(next.map((r) => [r.key, r.value]));
    if (onChange(result)) {
      committed.current = pretty(result);
      setInvalid(false);
    } else setInvalid(true);
  };
  const add = () => {
    let key = '';
    if (kind === 'noul') {
      key = rows.some((r) => r.key === 'true') ? 'false' : 'true';
    } else {
      let n = 1;
      while (rows.some((r) => r.key === `option_${n}`)) n++;
      key = `option_${n}`;
    }
    apply([...rows, { key, value: '' }]);
  };
  const max =
    kind === 'score'
      ? 10
      : kind === 'noul'
        ? 2
        : kind === 'choice'
          ? 255
          : Infinity;
  return (
    <div className="criteria-editor">
      <div className="section-title">
        <h3>{label}</h3>
        <button
          type="button"
          aria-label={`基準を追加 ${label}`}
          disabled={rows.length >= max}
          onClick={add}
        >
          ＋ 追加
        </button>
      </div>
      {rows.map((row, index) => (
        <div className="criterion-row" key={index}>
          <label>
            {kind === 'score' ? 'レベル' : 'キー'}
            <input
              aria-label={`${label} キー ${index + 1}`}
              value={kind === 'score' ? String(index) : row.key}
              readOnly={kind === 'score' || kind === 'noul'}
              onChange={(e) =>
                apply(
                  rows.map((r, i) =>
                    i === index ? { ...r, key: e.target.value } : r,
                  ),
                )
              }
            />
          </label>
          <label>
            値
            {row.value !== null && typeof row.value === 'object' ? (
              <div className="structured-value">
                <span>構造化データ</span>
                <pre>{pretty(row.value)}</pre>
                <small>JSON モードで編集できます</small>
              </div>
            ) : (
              <textarea
                aria-label={`${label} 値 ${index + 1}`}
                rows={2}
                value={row.value === null ? '' : String(row.value)}
                placeholder={
                  row.value === null ? '説明なし（null）' : '説明を入力'
                }
                onChange={(e) =>
                  apply(
                    rows.map((r, i) =>
                      i === index ? { ...r, value: e.target.value } : r,
                    ),
                  )
                }
              />
            )}
          </label>
          <button
            type="button"
            aria-label={`基準を削除 ${label} ${index + 1}`}
            onClick={() => apply(rows.filter((_, i) => i !== index))}
          >
            −
          </button>
        </div>
      ))}
      {kind === 'score' && (
        <p className="hint">低いレベルから順に並べてください（2〜10件）。</p>
      )}
      {invalid && (
        <p role="alert" className="validation">
          キーの空欄・重複、または基準の件数を確認してください。修正するまで保存・実行できません。
        </p>
      )}
    </div>
  );
}
function ContentEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Question['instructions'];
  onChange: (v: Question['instructions']) => void;
}) {
  return typeof value === 'string' ? (
    <label>
      {label}
      <textarea
        aria-label={label}
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  ) : (
    <JsonField
      label={label}
      value={value}
      onChange={(v) => {
        if (typeof v !== 'string' && (!v || typeof v !== 'object'))
          return false;
        onChange(v as Question['instructions']);
        return true;
      }}
    />
  );
}
function JsonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (v: unknown) => boolean;
}) {
  const reportInvalid = useContext(DraftValidity);
  const [draft, setDraft] = useState(pretty(value)),
    [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(pretty(value));
    setInvalid(false);
  }, [value]);
  useEffect(() => {
    reportInvalid(label, invalid);
    return () => reportInvalid(label, false);
  }, [label, invalid, reportInvalid]);
  return (
    <label>
      {label}
      <textarea
        aria-label={label}
        className="code"
        rows={5}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          try {
            setInvalid(!onChange(JSON.parse(e.target.value)));
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid && (
        <span className="validation">
          無効な JSON／形式です。直前の有効な値を保持しています。
        </span>
      )}
    </label>
  );
}
function StateEditor({
  value,
  onChange,
}: {
  value: Query['state'];
  onChange: (v: Query['state']) => void;
}) {
  const structured = typeof value !== 'string';
  return (
    <div>
      <label className="state-label">
        入力 / State
        <select
          aria-label="入力形式"
          value={structured ? 'json' : 'text'}
          onChange={(e) =>
            onChange(
              e.target.value === 'json' ? { text: value } : pretty(value),
            )
          }
        >
          <option value="text">テキスト</option>
          <option value="json">JSON</option>
        </select>
      </label>
      {structured ? (
        <JsonField
          label="入力 JSON"
          value={value}
          onChange={(v) => {
            if (!v || typeof v !== 'object') return false;
            onChange(v as Query['state']);
            return true;
          }}
        />
      ) : (
        <textarea
          aria-label="入力テキスト"
          rows={5}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <p className="hint">判断に必要な情報や背景を、ここに入力します。</p>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
