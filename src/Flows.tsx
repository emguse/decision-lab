import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ImageAttachments, ImageGallery } from './Images';
import {
  flowSchema,
  targets,
  validateFlow,
  type Flow,
  type FlowNode,
  type Condition,
  type FlowExecution,
  type FlowSuite,
  type FlowRevision,
} from '../shared/flows';
import {
  exampleFlow,
  exampleFlowDefinition,
  exampleFlowSuite,
} from '../shared/flow-examples';
import { serializeDocument, type Definition } from '../shared/exchange';
import type { LocalUser } from '../shared/evaluation';
import type { AppConfig, ProviderId } from '../shared/providers';

type DocumentInfo = {
  id: string;
  name: string;
  version: number;
  kind: 'decision-flow' | 'flow-suite';
};
type Summary = {
  id: string;
  flowId: string;
  flowName: string;
  flowVersion: number;
  createdAt: string;
  status: FlowExecution['status'];
  revealed: boolean;
  finalized: boolean;
  suiteId?: string;
  caseId?: string;
};
type Labeling = Summary &
  Pick<FlowExecution, 'flow' | 'definitions' | 'input'> & {
    revisions: FlowRevision[];
    expectedExposure?: { seenAt: string | null };
  };
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
interface SuiteResults {
  cases: {
    execution: FlowExecution;
    grading: {
      resultPass: boolean;
      pathPass: boolean | null;
      judgments: {
        nodeId: string;
        question: string;
        pass: boolean;
        missing: boolean;
      }[];
      routing: { nodeId: string; pass: boolean | null }[];
    } | null;
  }[];
  missingCases: string[];
  metrics: {
    labeled: number;
    missingLabels: number;
    failed: number;
    accuracy: number | null;
    calibration: Record<
      'noul' | 'choice',
      { samples: number; brier: number | null; ece: number | null }
    >;
    score: { samples: number; mae: number | null };
    coverageRisk: {
      threshold: number;
      accepted: number;
      coverage: number | null;
      errorRate: number | null;
    }[];
    coverageBasis: string;
    macroF1: { group: string; macroF1: number }[];
    stability: { groups: number; consistent: number };
    latency: { basis: string; p50: number | null; p95: number | null };
    slices: {
      key: string;
      cases: number;
      labeled: number;
      accuracy: number | null;
    }[];
  };
}
const percentage = (value: number | null) =>
  value === null ? 'Unavailable' : `${(value * 100).toFixed(1)}%`;
const decimal = (value: number | null) =>
  value === null ? 'Unavailable' : value.toFixed(4);
function FlowResultsView({ result }: { result: SuiteResults }) {
  const m = result.metrics;
  return (
    <section aria-label="Flow suite results">
      <h3>Final outcome accuracy: {percentage(m.accuracy)}</h3>
      <p>
        {m.labeled} labeled · {m.missingLabels} without labels · {m.failed}{' '}
        failed/interrupted · {result.missingCases.length} unselected cases
      </p>
      <table>
        <thead>
          <tr>
            <th>Case</th>
            <th>Outcome</th>
            <th>Path</th>
            <th>Judgment errors</th>
            <th>Routing rule errors</th>
          </tr>
        </thead>
        <tbody>
          {result.cases.map((c) => (
            <tr key={c.execution.id}>
              <td>{c.execution.caseId}</td>
              <td>
                {c.grading
                  ? c.grading.resultPass
                    ? 'Correct'
                    : 'Incorrect / failed'
                  : 'Unlabeled'}
              </td>
              <td>
                {c.grading?.pathPass == null
                  ? 'Unlabeled'
                  : c.grading.pathPass
                    ? 'Correct'
                    : 'Incorrect'}
              </td>
              <td>
                {c.grading?.judgments
                  .filter((j) => !j.pass)
                  .map(
                    (j) =>
                      `${j.nodeId}/${j.question}${j.missing ? ' (not executed)' : ''}`,
                  )
                  .join(', ') || '—'}
              </td>
              <td>
                {c.grading?.routing
                  .filter((r) => r.pass === false)
                  .map((r) => r.nodeId)
                  .join(', ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Calibration and scoring</h3>
      <table>
        <thead>
          <tr>
            <th>Primitive</th>
            <th>Labeled answers</th>
            <th>Brier</th>
            <th>ECE (10 bins)</th>
          </tr>
        </thead>
        <tbody>
          {(['noul', 'choice'] as const).map((type) => (
            <tr key={type}>
              <td>{type}</td>
              <td>{m.calibration[type].samples}</td>
              <td>{decimal(m.calibration[type].brier)}</td>
              <td>{decimal(m.calibration[type].ece)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Score MAE: {decimal(m.score.mae)} ({m.score.samples} answers). Brier
        conventions differ by primitive and are shown separately.
      </p>
      <h3>Confidence threshold exploration</h3>
      <p>{m.coverageBasis}</p>
      <p>
        Compare thresholds on tuning cases; evaluate the chosen policy on
        held-out cases. This table describes saved executions and does not rerun
        a changed routing policy.
      </p>
      <table>
        <thead>
          <tr>
            <th>Threshold</th>
            <th>Accepted</th>
            <th>Coverage</th>
            <th>Outcome error rate</th>
          </tr>
        </thead>
        <tbody>
          {m.coverageRisk.map((row) => (
            <tr key={row.threshold}>
              <td>{row.threshold.toFixed(1)}</td>
              <td>{row.accepted}</td>
              <td>{percentage(row.coverage)}</td>
              <td>{percentage(row.errorRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Domain, language and partition</h3>
      <table>
        <thead>
          <tr>
            <th>Slice</th>
            <th>Cases</th>
            <th>Labeled</th>
            <th>Accuracy</th>
          </tr>
        </thead>
        <tbody>
          {m.slices.map((s) => (
            <tr key={s.key}>
              <td>{s.key}</td>
              <td>{s.cases}</td>
              <td>{s.labeled}</td>
              <td>{percentage(s.accuracy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Consistent variant groups: {m.stability.consistent}/{m.stability.groups}
        . Latency p50/p95: {m.latency.p50 ?? 'Unavailable'} /{' '}
        {m.latency.p95 ?? 'Unavailable'} ms. Cost: unknown.
      </p>
      <p>{m.latency.basis}</p>
      <details>
        <summary>Macro-F1 by judgment</summary>
        <table>
          <tbody>
            {m.macroF1.map((row) => (
              <tr key={row.group}>
                <td>{row.group}</td>
                <td>{decimal(row.macroF1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
function download(value: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([pretty(value)], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function conditionText(c: Condition) {
  return c.type === 'choice'
    ? `${c.question} = ${c.value}`
    : c.type === 'score'
      ? `${c.min ?? '−∞'} ≤ ${c.question} ≤ ${c.max ?? '∞'}`
      : `${c.question}${c.type === 'confidence' ? ' confidence' : ' P(Yes)'} ${c.operator === 'gte' ? '≥' : '<'} ${c.value}`;
}
function positions(flow: Flow) {
  const depths = new Map(flow.nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < flow.nodes.length; i++)
    for (const n of flow.nodes)
      for (const target of targets(n)) {
        if (depths.has(target))
          depths.set(
            target,
            Math.min(
              flow.nodes.length,
              Math.max(depths.get(target)!, depths.get(n.id)! + 1),
            ),
          );
      }
  const rows = new Map<number, number>();
  return Object.fromEntries(
    flow.nodes.map((n) => {
      const depth = depths.get(n.id)!;
      const row = rows.get(depth) ?? 0;
      rows.set(depth, row + 1);
      return [
        n.id,
        flow.positions?.[n.id] ?? { x: depth * 300 + 20, y: row * 170 + 25 },
      ];
    }),
  );
}

export function FlowsWorkspace({
  user,
  users,
  config,
  initialProvider,
}: {
  user: LocalUser;
  users: LocalUser[];
  config: AppConfig | null;
  initialProvider: ProviderId;
}) {
  const request = <T,>(path: string, body?: unknown) =>
    api<T>(path, body, 'POST', user.id);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]),
    [definitions, setDefinitions] = useState<(Definition & { id: string })[]>(
      [],
    );
  const [flow, setFlow] = useState<Flow>({
    kind: 'decision-flow',
    schemaVersion: 1,
    name: 'New decision flow',
    version: 1,
    nodes: [
      { id: 'input', type: 'input', title: 'Original input', next: 'review' },
      {
        id: 'review',
        type: 'result',
        title: 'Needs review',
        resultId: 'review',
        description: 'Review the input.',
      },
    ],
  });
  const [flowId, setFlowId] = useState(''),
    [selected, setSelected] = useState('input');
  const [connection, setConnection] = useState<{
    from: string;
    branch: number | null;
  } | null>(null);
  const [provider, setProvider] = useState<ProviderId>(initialProvider),
    [model, setModel] = useState(
      config?.providers[initialProvider]?.model ?? 'jev-latest',
    );
  const [state, setState] = useState(
      'I was charged twice. Please refund the duplicate immediately.',
    ),
    [inputMode, setInputMode] = useState<'text' | 'json'>('text');
  const [imageIds, setImageIds] = useState<string[]>([]),
    [blocked, setBlocked] = useState(false);
  const [caseBlocked, setCaseBlocked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [history, setHistory] = useState<Summary[]>([]),
    [executionId, setExecutionId] = useState(''),
    [trace, setTrace] = useState<FlowExecution | null>(null),
    [labeling, setLabeling] = useState<Labeling | null>(null);
  const [resultLabel, setResultLabel] = useState(''),
    [pathLabel, setPathLabel] = useState(''),
    [judgmentLabels, setJudgmentLabels] = useState('{}');
  const [comparison, setComparison] = useState<FlowRevision[]>([]);
  const [assignedUser, setAssignedUser] = useState('');
  const [source, setSource] = useState(''),
    [sourceFormat, setSourceFormat] = useState<'json' | 'yaml'>('json');
  const [suite, setSuite] = useState<FlowSuite | null>(null),
    [suiteId, setSuiteId] = useState(''),
    [suiteExecutionIds, setSuiteExecutionIds] = useState<string[]>([]),
    [suiteResult, setSuiteResult] = useState<SuiteResults | null>(null),
    [labelSource, setLabelSource] = useState<
      'expected' | 'individual' | 'reference'
    >('expected');
  const lock = useRef(false),
    generation = useRef(0);
  const drag = useRef<{
    id: string;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const selectedConfig = config?.providers[provider];
  const node = flow.nodes.find((n) => n.id === selected);
  const definition =
    node?.type === 'decision'
      ? definitions.find(
          (d) =>
            d.name === node.definition.name &&
            d.version === node.definition.version,
        )
      : undefined;
  const definitionMap = Object.fromEntries(
    flow.nodes
      .filter((n) => n.type === 'decision')
      .map((n) => [
        n.id,
        definitions.find(
          (d) =>
            d.name === n.definition.name && d.version === n.definition.version,
        ),
      ])
      .filter(([, d]) => d),
  ) as Record<string, Definition>;
  let validation = '';
  try {
    validateFlow(flowSchema.parse(flow), definitionMap);
  } catch (e) {
    validation = e instanceof Error ? e.message : 'Invalid flow.';
  }
  const layout = positions(flow),
    width = Math.max(850, ...Object.values(layout).map((p) => p.x + 270)),
    height = Math.max(320, ...Object.values(layout).map((p) => p.y + 145));
  const activeFlow = trace?.flow ?? flow;
  function showTrace(value: FlowExecution) {
    setTrace(value);
    setFlow(value.flow);
    setFlowId(value.flowId);
  }
  const changed = () => {
    setFlowId('');
    setNotice(
      'Unsaved changes. Increase version before replacing a saved flow.',
    );
    setTrace(null);
  };
  function updateNode(id: string, change: Partial<FlowNode>) {
    changed();
    setFlow((f) => ({
      ...f,
      nodes: f.nodes.map((n) =>
        n.id === id ? ({ ...n, ...change } as FlowNode) : n,
      ),
    }));
  }
  async function refresh() {
    const [docs, defs, runs] = await Promise.all([
      request<DocumentInfo[]>('flow-documents'),
      request<(Definition & { id: string })[]>('flow-definitions'),
      request<Summary[]>('flow-executions'),
    ]);
    setDocuments(docs);
    setDefinitions(defs);
    setHistory(runs);
  }
  async function action(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed.');
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    return () => {
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (!config) return;
    if (config.providers[provider]?.modelEditable === false)
      setModel(config.providers[provider].model);
  }, [config, provider]);
  useEffect(() => {
    const token = ++generation.current;
    setTrace(null);
    setLabeling(null);
    setComparison([]);
    setResultLabel('');
    setPathLabel('');
    setJudgmentLabels('{}');
    if (!executionId) return;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [view, labels] = await Promise.all([
          request<FlowExecution | Summary>(`flow-executions/${executionId}`),
          request<Labeling>(`flow-executions/${executionId}/labeling`),
        ]);
        if (token !== generation.current) return;
        setLabeling(labels);
        if ('steps' in view) showTrace(view);
        if (view.status === 'running') timer = setTimeout(poll, 700);
        else await refresh();
      } catch (e) {
        if (token === generation.current)
          setError(e instanceof Error ? e.message : 'Cannot load execution.');
      }
    }
    void poll();
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [executionId]);
  useEffect(() => {
    if (!suiteExecutionIds.length) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const runs = await request<Summary[]>('flow-executions');
        if (!active) return;
        setHistory(runs);
        if (
          runs.some(
            (r) => suiteExecutionIds.includes(r.id) && r.status === 'running',
          )
        )
          timer = setTimeout(poll, 700);
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : 'Cannot load suite progress.',
          );
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [suiteExecutionIds]);
  function addNode(type: 'decision' | 'result') {
    if (flow.nodes.length >= 50) return;
    const id = `${type}_${crypto.randomUUID().slice(0, 8)}`;
    const n: FlowNode =
      type === 'result'
        ? { id, type, title: 'New result', resultId: id, description: '' }
        : {
            id,
            type,
            title: 'New judgment',
            definition: {
              name: definitions[0]?.name ?? '',
              version: definitions[0]?.version ?? 1,
            },
            branches: [],
            defaultTarget:
              flow.nodes.find((n) => n.type === 'result')?.id ?? '',
          };
    changed();
    setFlow((f) => ({ ...f, nodes: [...f.nodes, n] }));
    setSelected(id);
  }
  function connect(target: string) {
    if (!connection) {
      setSelected(target);
      return;
    }
    const from = flow.nodes.find((n) => n.id === connection.from);
    if (from?.type === 'input') updateNode(from.id, { next: target });
    if (from?.type === 'decision') {
      if (connection.branch === null)
        updateNode(from.id, { defaultTarget: target });
      else
        updateNode(from.id, {
          branches: from.branches.map((b, i) =>
            i === connection.branch ? { ...b, target } : b,
          ),
        });
    }
    setConnection(null);
  }
  function defaultCondition(question?: string): Condition {
    const key = question ?? Object.keys(definition?.questions ?? {})[0] ?? '';
    const q = definition?.questions[key];
    return q?.type === 'choice'
      ? { type: 'choice', question: key, value: Object.keys(q.criteria)[0] }
      : q?.type === 'score'
        ? { type: 'score', question: key, min: 0, max: q.criteria.length - 1 }
        : { type: 'noul', question: key, operator: 'gte', value: 0.5 };
  }
  function updateCondition(
    branch: number,
    index: number,
    condition: Condition,
  ) {
    if (node?.type !== 'decision') return;
    updateNode(node.id, {
      branches: node.branches.map((b, i) =>
        i === branch
          ? {
              ...b,
              conditions: b.conditions.map((c, j) =>
                j === index ? condition : c,
              ),
            }
          : b,
      ),
    });
  }
  const targetSelect = (
    value: string,
    change: (v: string) => void,
    label: string,
  ) => (
    <label>
      {label}
      <select value={value} onChange={(e) => change(e.target.value)}>
        <option value="">Select a card</option>
        {flow.nodes
          .filter((n) => n.type !== 'input' && n.id !== node?.id)
          .map((n) => (
            <option key={n.id} value={n.id}>
              {n.title} ({n.id})
            </option>
          ))}
      </select>
    </label>
  );
  async function loadFlow(id: string) {
    const document = await request<Flow>(`flow-documents/${id}`);
    setFlow(document);
    setFlowId(id);
    setSelected(document.nodes[0].id);
    setTrace(null);
    setConnection(null);
    setNotice('');
  }
  const labels = () => ({
    resultId: resultLabel,
    ...(pathLabel.trim() ? { path: pathLabel.trim().split(/\s+/) } : {}),
    judgments: JSON.parse(judgmentLabels),
  });
  return (
    <section className="flows-workspace">
      <header>
        <div>
          <div className="eyebrow">DECISION FLOWS</div>
          <h1>Connect judgments to outcomes</h1>
          <p>
            Build a flow, try an input, and inspect how each decision leads to
            the result.
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await request('exchange/import', {
                documents: [
                  {
                    source: serializeDocument(exampleFlowDefinition, 'json'),
                    format: 'json',
                  },
                ],
              });
              await refresh();
              setFlow(exampleFlow);
              setFlowId('');
              setSelected('triage');
              setTrace(null);
            })
          }
        >
          Load example flow
        </button>
      </header>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="flow-document-bar">
        <label>
          Saved flow
          <select
            aria-label="Saved flow"
            value={flowId}
            onChange={(e) =>
              e.target.value && void action(() => loadFlow(e.target.value))
            }
          >
            <option value="">Unsaved flow</option>
            {documents
              .filter((d) => d.kind === 'decision-flow')
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} v{d.version}
                </option>
              ))}
          </select>
        </label>
        <label>
          Flow name
          <input
            value={flow.name}
            onChange={(e) => {
              changed();
              setFlow({ ...flow, name: e.target.value });
            }}
          />
        </label>
        <label>
          Version
          <input
            type="number"
            min="1"
            value={flow.version}
            onChange={(e) => {
              changed();
              setFlow({ ...flow, version: Number(e.target.value) });
            }}
          />
        </label>
        <button
          disabled={busy || Boolean(validation)}
          onClick={() =>
            void action(async () => {
              const saved = await request<DocumentInfo>('flow-documents', flow);
              setFlowId(saved.id);
              setNotice('Flow saved.');
              await refresh();
            })
          }
        >
          Save flow
        </button>
        <button
          onClick={() =>
            download(flow, `decision-flow-${flow.name}-v${flow.version}.json`)
          }
        >
          Export flow JSON
        </button>
      </div>
      {validation && (
        <p role="alert" className="flow-validation">
          {validation}
        </p>
      )}
      <div className="toolbar">
        <button
          disabled={busy || !definitions.length}
          onClick={() => addNode('decision')}
        >
          Add judgment
        </button>
        <button disabled={busy} onClick={() => addNode('result')}>
          Add result
        </button>
        <button
          onClick={() => {
            changed();
            setFlow({ ...flow, positions: undefined });
          }}
        >
          Arrange cards
        </button>
        {!definitions.length && (
          <span>
            Import a decision definition in Suites or load the example.
          </span>
        )}
      </div>
      {connection && (
        <p role="status">
          Select the target card for {connection.from}.{' '}
          <button onClick={() => setConnection(null)}>Cancel connection</button>
        </p>
      )}
      <div className="flow-design">
        <div className="flow-board-scroll">
          <div
            className="flow-board"
            style={{ width, height }}
            onPointerMove={(e) => {
              const moving = drag.current;
              if (!moving) return;
              changed();
              setFlow((f) => ({
                ...f,
                positions: {
                  ...positions(f),
                  [moving.id]: {
                    x: Math.max(
                      0,
                      Math.min(15000, moving.left + e.clientX - moving.x),
                    ),
                    y: Math.max(
                      0,
                      Math.min(15000, moving.top + e.clientY - moving.y),
                    ),
                  },
                },
              }));
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <svg
              className="flow-wires"
              width={width}
              height={height}
              aria-label="Flow connections"
            >
              <defs>
                <marker
                  id="flow-arrow"
                  markerWidth="8"
                  markerHeight="8"
                  refX="7"
                  refY="4"
                  orient="auto"
                >
                  <path d="M0,0 L8,4 L0,8" fill="currentColor" />
                </marker>
              </defs>
              {flow.nodes.flatMap((n) =>
                targets(n).map((target, i) => {
                  const a = layout[n.id],
                    b = layout[target];
                  if (!b) return null;
                  const visited =
                    trace?.flow.name === flow.name &&
                    trace.path.some(
                      (id, index) =>
                        id === n.id && trace.path[index + 1] === target,
                    );
                  const y = a.y + 65 + i * 8;
                  return (
                    <g
                      key={`${n.id}-${i}`}
                      className={visited ? 'flow-edge traversed' : 'flow-edge'}
                    >
                      <path
                        d={`M${a.x + 240},${y} C${a.x + 280},${y} ${b.x - 40},${b.y + 65} ${b.x},${b.y + 65}`}
                        markerEnd="url(#flow-arrow)"
                      />
                      <text x={a.x + 245} y={y - 6}>
                        {n.type === 'decision'
                          ? i < n.branches.length
                            ? String(i + 1)
                            : 'else'
                          : ''}
                      </text>
                    </g>
                  );
                }),
              )}
            </svg>
            {flow.nodes.map((n) => (
              <div
                key={n.id}
                className={`flow-card ${n.type} ${selected === n.id ? 'selected' : ''} ${trace?.flow.name === flow.name && trace.path.includes(n.id) ? 'traversed' : ''}`}
                style={{ left: layout[n.id].x, top: layout[n.id].y }}
              >
                <div
                  className="flow-card-handle"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    drag.current = {
                      id: n.id,
                      x: e.clientX,
                      y: e.clientY,
                      left: layout[n.id].x,
                      top: layout[n.id].y,
                    };
                  }}
                >
                  {n.type.toUpperCase()} · {n.id}
                </div>
                <button
                  className="flow-card-title"
                  aria-label={`Select card ${n.id}`}
                  onClick={() => connect(n.id)}
                >
                  {n.title}
                </button>
                <small>
                  {n.type === 'decision'
                    ? `${n.definition.name} v${n.definition.version}`
                    : n.type === 'result'
                      ? n.resultId
                      : 'Original state + images'}
                </small>
                {n.type !== 'result' && (
                  <button
                    className="flow-port"
                    aria-label={`Connect ${n.id}`}
                    onClick={() => setConnection({ from: n.id, branch: null })}
                  >
                    Connect {n.type === 'decision' ? 'else' : 'next'} →
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
        <section className="flow-inspector" aria-label="Card editor">
          {node && (
            <>
              <h2>
                {node.type === 'decision'
                  ? 'Judgment'
                  : node.type === 'result'
                    ? 'Result'
                    : 'Input'}{' '}
                card
              </h2>
              <p>
                <code>{node.id}</code>
              </p>
              <label>
                Card title
                <input
                  value={node.title}
                  onChange={(e) =>
                    updateNode(node.id, { title: e.target.value })
                  }
                />
              </label>
              {node.type === 'input' &&
                targetSelect(
                  node.next,
                  (next) => updateNode(node.id, { next }),
                  'Next judgment',
                )}
              {node.type === 'result' && (
                <>
                  <label>
                    Result ID
                    <input
                      value={node.resultId}
                      onChange={(e) =>
                        updateNode(node.id, { resultId: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Description
                    <textarea
                      value={node.description}
                      onChange={(e) =>
                        updateNode(node.id, { description: e.target.value })
                      }
                    />
                  </label>
                </>
              )}
              {node.type === 'decision' && (
                <>
                  <label>
                    Decision definition
                    <select
                      value={definition?.id ?? ''}
                      onChange={(e) => {
                        const d = definitions.find(
                          (d) => d.id === e.target.value,
                        )!;
                        updateNode(node.id, {
                          definition: { name: d.name, version: d.version },
                          branches: [],
                        });
                      }}
                    >
                      <option value="">Select a definition</option>
                      {definitions.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} v{d.version}
                        </option>
                      ))}
                    </select>
                  </label>
                  <details>
                    <summary>Questions and state</summary>
                    <p>
                      Questions receive <code>input</code> and prior answers
                      under <code>decisions.card_id.question_id</code>. Original
                      images are forwarded in order.
                    </p>
                    <pre>{pretty(definition?.questions)}</pre>
                  </details>
                  <h3>First matching branch wins</h3>
                  {node.branches.map((branch, bi) => (
                    <fieldset key={bi}>
                      <legend>Branch {bi + 1}</legend>
                      {branch.conditions.map((c, ci) => (
                        <div key={ci} className="flow-condition">
                          <label>
                            Question
                            <select
                              value={c.question}
                              onChange={(e) =>
                                updateCondition(
                                  bi,
                                  ci,
                                  defaultCondition(e.target.value),
                                )
                              }
                            >
                              {Object.keys(definition?.questions ?? {}).map(
                                (key) => (
                                  <option key={key}>{key}</option>
                                ),
                              )}
                            </select>
                          </label>
                          <label>
                            Measure
                            <select
                              value={c.type}
                              onChange={(e) =>
                                updateCondition(
                                  bi,
                                  ci,
                                  e.target.value === 'confidence'
                                    ? {
                                        type: 'confidence',
                                        question: c.question,
                                        operator: 'lt',
                                        value: 0.5,
                                      }
                                    : defaultCondition(c.question),
                                )
                              }
                            >
                              <option
                                value={
                                  definition?.questions[c.question]?.type ??
                                  c.type
                                }
                              >
                                {definition?.questions[c.question]?.type ??
                                  c.type}
                              </option>
                              {definition?.questions[c.question]?.type !==
                                'noul' && (
                                <option value="confidence">confidence</option>
                              )}
                            </select>
                          </label>
                          {c.type === 'choice' && (
                            <label>
                              Equals
                              <select
                                value={c.value}
                                onChange={(e) =>
                                  updateCondition(bi, ci, {
                                    ...c,
                                    value: e.target.value,
                                  })
                                }
                              >
                                {Object.keys(
                                  (
                                    definition?.questions[c.question] as {
                                      criteria?: Record<string, unknown>;
                                    }
                                  )?.criteria ?? {},
                                ).map((value) => (
                                  <option key={value}>{value}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          {(c.type === 'noul' || c.type === 'confidence') && (
                            <>
                              <label>
                                Comparison
                                <select
                                  value={c.operator}
                                  onChange={(e) =>
                                    updateCondition(bi, ci, {
                                      ...c,
                                      operator: e.target.value as 'gte' | 'lt',
                                    })
                                  }
                                >
                                  <option value="gte">≥</option>
                                  <option value="lt">&lt;</option>
                                </select>
                              </label>
                              <label>
                                Threshold
                                <input
                                  type="number"
                                  min="0"
                                  max="1"
                                  step="0.05"
                                  value={c.value}
                                  onChange={(e) =>
                                    updateCondition(bi, ci, {
                                      ...c,
                                      value: Number(e.target.value),
                                    })
                                  }
                                />
                              </label>
                            </>
                          )}
                          {c.type === 'score' && (
                            <>
                              <label>
                                Minimum
                                <input
                                  type="number"
                                  step="0.1"
                                  value={c.min ?? ''}
                                  onChange={(e) =>
                                    updateCondition(bi, ci, {
                                      ...c,
                                      min:
                                        e.target.value === ''
                                          ? undefined
                                          : Number(e.target.value),
                                    })
                                  }
                                />
                              </label>
                              <label>
                                Maximum
                                <input
                                  type="number"
                                  step="0.1"
                                  value={c.max ?? ''}
                                  onChange={(e) =>
                                    updateCondition(bi, ci, {
                                      ...c,
                                      max:
                                        e.target.value === ''
                                          ? undefined
                                          : Number(e.target.value),
                                    })
                                  }
                                />
                              </label>
                            </>
                          )}
                          <button
                            disabled={branch.conditions.length === 1}
                            onClick={() =>
                              updateNode(node.id, {
                                branches: node.branches.map((b, i) =>
                                  i === bi
                                    ? {
                                        ...b,
                                        conditions: b.conditions.filter(
                                          (_, j) => j !== ci,
                                        ),
                                      }
                                    : b,
                                ),
                              })
                            }
                          >
                            Remove condition
                          </button>
                        </div>
                      ))}
                      <button
                        disabled={branch.conditions.length >= 10}
                        onClick={() =>
                          updateNode(node.id, {
                            branches: node.branches.map((b, i) =>
                              i === bi
                                ? {
                                    ...b,
                                    conditions: [
                                      ...b.conditions,
                                      defaultCondition(),
                                    ],
                                  }
                                : b,
                            ),
                          })
                        }
                      >
                        Add AND condition
                      </button>
                      {targetSelect(
                        branch.target,
                        (target) =>
                          updateNode(node.id, {
                            branches: node.branches.map((b, i) =>
                              i === bi ? { ...b, target } : b,
                            ),
                          }),
                        'Then go to',
                      )}
                      <button
                        onClick={() =>
                          setConnection({ from: node.id, branch: bi })
                        }
                      >
                        Connect branch {bi + 1}
                      </button>
                      <button
                        disabled={bi === 0}
                        onClick={() => {
                          const branches = [...node.branches];
                          [branches[bi - 1], branches[bi]] = [
                            branches[bi],
                            branches[bi - 1],
                          ];
                          updateNode(node.id, { branches });
                        }}
                      >
                        Move up
                      </button>
                      <button
                        disabled={bi === node.branches.length - 1}
                        onClick={() => {
                          const branches = [...node.branches];
                          [branches[bi + 1], branches[bi]] = [
                            branches[bi],
                            branches[bi + 1],
                          ];
                          updateNode(node.id, { branches });
                        }}
                      >
                        Move down
                      </button>
                      <button
                        onClick={() =>
                          updateNode(node.id, {
                            branches: node.branches.filter((_, i) => i !== bi),
                          })
                        }
                      >
                        Remove branch
                      </button>
                    </fieldset>
                  ))}
                  <button
                    disabled={!definition || node.branches.length >= 30}
                    onClick={() =>
                      updateNode(node.id, {
                        branches: [
                          ...node.branches,
                          {
                            conditions: [defaultCondition()],
                            target: node.defaultTarget,
                          },
                        ],
                      })
                    }
                  >
                    Add branch
                  </button>
                  {targetSelect(
                    node.defaultTarget,
                    (defaultTarget) => updateNode(node.id, { defaultTarget }),
                    'Otherwise go to (required)',
                  )}
                </>
              )}
              {node.type !== 'input' && (
                <button
                  onClick={() => {
                    changed();
                    setFlow({
                      ...flow,
                      nodes: flow.nodes.filter((n) => n.id !== node.id),
                    });
                    setSelected('input');
                  }}
                >
                  Delete card
                </button>
              )}
            </>
          )}
        </section>
      </div>
      <section className="panel">
        <h2>Try the saved flow</h2>
        <div className="flow-document-bar">
          <label>
            Connection
            <select
              value={provider}
              onChange={(e) => {
                const id = e.target.value;
                setProvider(id);
                setModel(config?.providers[id]?.model ?? '');
              }}
            >
              {Object.entries(config?.providers ?? {}).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model
            <input
              value={model}
              readOnly={selectedConfig?.modelEditable === false}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <label>
            Input format
            <select
              value={inputMode}
              onChange={(e) => setInputMode(e.target.value as 'text' | 'json')}
            >
              <option value="text">Text</option>
              <option value="json">JSON state</option>
            </select>
          </label>
        </div>
        <label>
          Original input
          <textarea value={state} onChange={(e) => setState(e.target.value)} />
        </label>
        <ImageAttachments
          ids={imageIds}
          onChange={setImageIds}
          onBlocked={setBlocked}
          disabled={busy}
          userId={user.id}
        />
        <button
          disabled={
            busy ||
            blocked ||
            !flowId ||
            !selectedConfig?.configured ||
            !model.trim()
          }
          onClick={() =>
            void action(async () => {
              const e = await request<Summary>(`flows/${flowId}/execute`, {
                provider,
                model,
                state: inputMode === 'json' ? JSON.parse(state) : state,
                imageIds,
              });
              setExecutionId(e.id);
              await refresh();
            })
          }
        >
          Run decision flow
        </button>
        {!flowId && <p>Save the flow before executing.</p>}
      </section>
      <section className="panel">
        <h2>Execution history and human evaluation</h2>
        <label>
          Execution
          <select
            value={executionId}
            onChange={(e) => setExecutionId(e.target.value)}
          >
            <option value="">Select an execution</option>
            {history.map((e) => (
              <option key={e.id} value={e.id}>
                {e.flowName} v{e.flowVersion} · {e.caseId ?? e.createdAt} ·{' '}
                {e.status}
              </option>
            ))}
          </select>
        </label>
        {labeling && (
          <>
            <p>
              Status: {labeling.status} ·{' '}
              {labeling.revealed
                ? 'Model answers exposed to this profile'
                : 'Blind for this profile'}
            </p>
            {labeling.expectedExposure?.seenAt && (
              <p>Imported expectations have been seen by this profile.</p>
            )}
            <ImageGallery ids={labeling.input.imageIds} />
            <pre>{pretty(labeling.input.state)}</pre>
            <label>
              Expected final result
              <select
                value={resultLabel}
                onChange={(e) => setResultLabel(e.target.value)}
              >
                <option value="">Select a result</option>
                {labeling.flow.nodes
                  .filter((n) => n.type === 'result')
                  .map((n) => (
                    <option key={n.id} value={n.resultId}>
                      {n.title} ({n.resultId})
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Expected path (optional, space-separated card IDs)
              <input
                value={pathLabel}
                onChange={(e) => setPathLabel(e.target.value)}
              />
            </label>
            <label>
              Expected judgments (optional JSON keyed by card ID)
              <textarea
                value={judgmentLabels}
                onChange={(e) => setJudgmentLabels(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !resultLabel || labeling.status === 'running'}
              onClick={() =>
                void action(async () => {
                  await request(`flow-executions/${executionId}/finalize`, {
                    labels: labels(),
                  });
                  setLabeling(
                    await request(`flow-executions/${executionId}/labeling`),
                  );
                  showTrace(await request(`flow-executions/${executionId}`));
                  await refresh();
                })
              }
            >
              Finalize labels and reveal
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  showTrace(
                    await request(`flow-executions/${executionId}/reveal`, {}),
                  );
                  setLabeling(
                    await request(`flow-executions/${executionId}/labeling`),
                  );
                  await refresh();
                })
              }
            >
              Reveal flow answers
            </button>
            <details>
              <summary>Finalized revisions</summary>
              <pre>{pretty(labeling.revisions)}</pre>
            </details>
            <label>
              Assign evaluator
              <select
                value={assignedUser}
                onChange={(e) => setAssignedUser(e.target.value)}
              >
                <option value="">Select a local profile</option>
                {users
                  .filter((u) => u.kind === 'local')
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              disabled={busy || !assignedUser}
              onClick={() =>
                void action(async () => {
                  await request(`flow-executions/${executionId}/assignments`, {
                    userId: assignedUser,
                  });
                  setNotice(
                    'Evaluator assigned. Comparison waits for every assigned profile to finalize.',
                  );
                })
              }
            >
              Assign to flow evaluation
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const data = await request<{ revisions: FlowRevision[] }>(
                    `flow-executions/${executionId}/comparison`,
                  );
                  setComparison(data.revisions);
                })
              }
            >
              Compare assigned evaluators
            </button>
            {comparison.length > 0 && (
              <>
                <pre>{pretty(comparison)}</pre>
                <button
                  disabled={busy || !resultLabel}
                  onClick={() =>
                    void action(async () => {
                      const latest = Object.values(
                        Object.fromEntries(
                          comparison
                            .filter((r) => r.kind === 'individual')
                            .map((r) => [r.userId, r]),
                        ),
                      );
                      await request(`flow-executions/${executionId}/adopt`, {
                        labels: labels(),
                        sourceRevisionIds: latest.map((r) => r.id),
                      });
                      setNotice('Reference revision adopted.');
                    })
                  }
                >
                  Adopt labels as reference
                </button>
              </>
            )}
          </>
        )}
        {trace && (
          <section aria-label="Execution trace">
            <h3>
              {trace.result ? `Result: ${trace.result.resultId}` : trace.status}
            </h3>
            <p>{trace.result?.description ?? trace.error?.message}</p>
            {trace.attemptedJudgment && (
              <details>
                <summary>
                  Unfinished judgment: {trace.attemptedJudgment.nodeId}
                </summary>
                <pre>{pretty(trace.attemptedJudgment.query)}</pre>
              </details>
            )}
            <p className="flow-path">{trace.path.join(' → ')}</p>
            {trace.steps.map((step) => (
              <details key={step.nodeId} open>
                <summary>
                  {step.nodeId} → {step.target} ·{' '}
                  {step.branchIndex === null
                    ? 'otherwise'
                    : `branch ${step.branchIndex + 1}`}{' '}
                  · {step.elapsedMs} ms
                </summary>
                <p>
                  {(() => {
                    const n = activeFlow.nodes.find(
                      (n) => n.id === step.nodeId,
                    );
                    return n?.type === 'decision' && step.branchIndex !== null
                      ? n.branches[step.branchIndex].conditions
                          .map(conditionText)
                          .join(' AND ')
                      : 'Default connection';
                  })()}
                </p>
                <pre>{pretty(step.response.answers)}</pre>
                <details>
                  <summary>Exact input and execution metadata</summary>
                  <pre>
                    {pretty({ query: step.query, metadata: step.metadata })}
                  </pre>
                </details>
              </details>
            ))}
            <button
              onClick={() => download(trace, `flow-execution-${trace.id}.json`)}
            >
              Export revealed trace JSON
            </button>
          </section>
        )}
      </section>
      <section className="panel">
        <h2>Flow suites</h2>
        <p>
          Evaluate final outcomes, intermediate judgments and routing
          separately. Expectations are hidden until results are requested after
          revealing executions.
        </p>
        <label>
          Saved flow suite
          <select
            value={suiteId}
            onChange={(e) =>
              e.target.value &&
              void action(async () => {
                const d = await request<FlowSuite>(
                  `flow-documents/${e.target.value}`,
                );
                setSuite(d);
                setSuiteId(e.target.value);
                setSuiteExecutionIds([]);
                setSuiteResult(null);
              })
            }
          >
            <option value="">New suite</option>
            {documents
              .filter((d) => d.kind === 'flow-suite')
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} v{d.version}
                </option>
              ))}
          </select>
        </label>
        <button
          disabled={busy || !flowId}
          onClick={() => {
            setSuite({
              ...exampleFlowSuite,
              name: `${flow.name} evaluation`,
              flow: { name: flow.name, version: flow.version },
              cases: [],
            });
            setSuiteId('');
            setSuiteExecutionIds([]);
            setSuiteResult(null);
          }}
        >
          Create suite for this flow
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setSuite(exampleFlowSuite);
            setSuiteId('');
            setSuiteExecutionIds([]);
            setSuiteResult(null);
          }}
        >
          Load example suite
        </button>
        {suite && (
          <>
            <label>
              Suite name
              <input
                disabled={Boolean(suiteId)}
                value={suite.name}
                onChange={(e) => {
                  setSuite({ ...suite, name: e.target.value });
                  setSuiteId('');
                }}
              />
            </label>
            <label>
              Suite version
              <input
                disabled={Boolean(suiteId)}
                type="number"
                min="1"
                value={suite.version}
                onChange={(e) => {
                  setSuite({ ...suite, version: Number(e.target.value) });
                  setSuiteId('');
                }}
              />
            </label>
            <p>
              Flow: {suite.flow.name} v{suite.flow.version}
            </p>
            {suiteId && (
              <>
                <p>
                  Saved Suite inputs are immutable. Expectations remain hidden
                  until explicitly opened.
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const data = await request<{ text: string }>(
                        `flow-documents/${suiteId}/export`,
                        { format: 'json' },
                      );
                      const original = JSON.parse(data.text) as FlowSuite;
                      setSuite({ ...original, version: original.version + 1 });
                      setSuiteId('');
                      setSuiteExecutionIds([]);
                      setSuiteResult(null);
                      setNotice(
                        'Expectations exposed for this profile. Editing a new version.',
                      );
                    })
                  }
                >
                  Edit new version with expectations
                </button>
              </>
            )}
            {suite.cases.map((item, index) => {
              const update = (change: Partial<typeof item>) => {
                setSuite((s) =>
                  s
                    ? {
                        ...s,
                        cases: s.cases.map((c, i) =>
                          i === index ? { ...c, ...change } : c,
                        ),
                      }
                    : s,
                );
                setSuiteId('');
              };
              return (
                <fieldset key={index} disabled={Boolean(suiteId) || busy}>
                  <legend>Case {index + 1}</legend>
                  <label>
                    Case ID
                    <input
                      value={item.id}
                      onChange={(e) => update({ id: e.target.value })}
                    />
                  </label>
                  <label>
                    State (text)
                    <textarea
                      value={
                        typeof item.state === 'string'
                          ? item.state
                          : pretty(item.state)
                      }
                      onChange={(e) => update({ state: e.target.value })}
                    />
                  </label>
                  <ImageAttachments
                    ids={item.imageIds}
                    userId={user.id}
                    disabled={busy}
                    onChange={(imageIds) => update({ imageIds })}
                    onBlocked={(value) =>
                      setCaseBlocked((prev) =>
                        prev[item.id] === value
                          ? prev
                          : { ...prev, [item.id]: value },
                      )
                    }
                  />
                  <label>
                    Partition
                    <select
                      value={item.partition}
                      onChange={(e) =>
                        update({
                          partition: e.target.value as 'tuning' | 'evaluation',
                        })
                      }
                    >
                      <option value="tuning">Threshold tuning</option>
                      <option value="evaluation">Final evaluation</option>
                    </select>
                  </label>
                  {(
                    [
                      'source',
                      'revision',
                      'sourceCaseId',
                      'license',
                      'transformVersion',
                      'language',
                      'domain',
                      'evidenceGroup',
                    ] as const
                  ).map((key) => (
                    <label key={key}>
                      {key}
                      <input
                        value={item.provenance[key]}
                        onChange={(e) =>
                          update({
                            provenance: {
                              ...item.provenance,
                              [key]: e.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                  <label>
                    Label origin
                    <select
                      value={item.provenance.labelOrigin}
                      onChange={(e) =>
                        update({
                          provenance: {
                            ...item.provenance,
                            labelOrigin: e.target
                              .value as typeof item.provenance.labelOrigin,
                          },
                        })
                      }
                    >
                      <option value="human">Human</option>
                      <option value="source">Source dataset</option>
                      <option value="synthetic">Synthetic</option>
                    </select>
                  </label>
                  <label>
                    Expected result (optional)
                    <input
                      value={item.expected?.resultId ?? ''}
                      onChange={(e) =>
                        update({
                          expected: e.target.value
                            ? { ...item.expected, resultId: e.target.value }
                            : undefined,
                        })
                      }
                    />
                  </label>
                  <button
                    onClick={() => {
                      setSuite({
                        ...suite,
                        cases: suite.cases.filter((_, i) => i !== index),
                      });
                      setSuiteId('');
                    }}
                  >
                    Remove case
                  </button>
                </fieldset>
              );
            })}
            <button
              disabled={Boolean(suiteId) || suite.cases.length >= 100 || busy}
              onClick={() => {
                const id = `case_${suite.cases.length + 1}`;
                setSuite({
                  ...suite,
                  cases: [
                    ...suite.cases,
                    {
                      id,
                      state,
                      imageIds,
                      partition: 'evaluation',
                      provenance: {
                        source: 'local',
                        revision: '1',
                        sourceCaseId: id,
                        license: 'user-provided',
                        transformVersion: '1',
                        language: 'ja',
                        domain: 'business-workflow',
                        evidenceGroup: id,
                        labelOrigin: 'human',
                      },
                    },
                  ],
                });
                setSuiteId('');
              }}
            >
              Add case from current input
            </button>
            <button
              disabled={
                Boolean(suiteId) ||
                busy ||
                Object.entries(caseBlocked).some(
                  ([id, value]) =>
                    value && suite.cases.some((c) => c.id === id),
                ) ||
                !suite.cases.length
              }
              onClick={() =>
                void action(async () => {
                  const saved = await request<DocumentInfo>(
                    'flow-documents',
                    suite,
                  );
                  setSuiteId(saved.id);
                  setNotice(
                    'Suite saved. Supplied expectations are marked as seen by this profile.',
                  );
                  await refresh();
                })
              }
            >
              Save flow suite
            </button>
            <button
              disabled={busy || !suiteId || !selectedConfig?.configured}
              onClick={() =>
                void action(async () => {
                  const data = await request<{ executions: Summary[] }>(
                    `flow-suites/${suiteId}/execute`,
                    { provider, model },
                  );
                  setSuiteExecutionIds(data.executions.map((e) => e.id));
                  setSuiteResult(null);
                  await refresh();
                })
              }
            >
              Run flow suite sequentially
            </button>
            <div>
              {history
                .filter((e) => e.suiteId === suiteId)
                .map((e) => (
                  <label key={e.id} className="flow-execution-select">
                    <input
                      type="checkbox"
                      checked={suiteExecutionIds.includes(e.id)}
                      onChange={(event) => {
                        setSuiteExecutionIds((ids) =>
                          event.target.checked
                            ? [
                                ...ids.filter(
                                  (id) =>
                                    history.find((r) => r.id === id)?.caseId !==
                                    e.caseId,
                                ),
                                e.id,
                              ]
                            : ids.filter((id) => id !== e.id),
                        );
                        setSuiteResult(null);
                      }}
                    />
                    {e.caseId} · {e.status} ·{' '}
                    {e.revealed ? 'revealed' : 'blind'}
                    <button onClick={() => setExecutionId(e.id)}>
                      Evaluate case
                    </button>
                  </label>
                ))}
            </div>
            <label>
              Grading source
              <select
                value={labelSource}
                onChange={(e) => {
                  setLabelSource(e.target.value as typeof labelSource);
                  setSuiteResult(null);
                }}
              >
                <option value="expected">Imported expected</option>
                <option value="individual">My finalized labels</option>
                <option value="reference">Adopted reference</option>
              </select>
            </label>
            <button
              disabled={busy || !suiteExecutionIds.length}
              onClick={() =>
                void action(async () =>
                  setSuiteResult(
                    await request(`flow-suites/${suiteId}/results`, {
                      executionIds: suiteExecutionIds,
                      source: labelSource,
                    }),
                  ),
                )
              }
            >
              Evaluate selected executions
            </button>
            <button
              disabled={busy || !suiteId}
              onClick={() =>
                void action(async () => {
                  const exported = await request<{ text: string }>(
                    `flow-documents/${suiteId}/export`,
                    { format: 'json' },
                  );
                  download(
                    JSON.parse(exported.text),
                    `flow-suite-${suite.name}.json`,
                  );
                  setNotice(
                    'Export includes expectations; exposure is recorded for this profile.',
                  );
                })
              }
            >
              Export suite JSON
            </button>
          </>
        )}
        {suiteResult !== null && (
          <>
            <FlowResultsView result={suiteResult} />
            <details>
              <summary>Full result document</summary>
              <pre>{pretty(suiteResult)}</pre>
            </details>
            <button
              onClick={() =>
                download(suiteResult, `flow-results-${suiteId}.json`)
              }
            >
              Export flow results JSON
            </button>
          </>
        )}
      </section>
      <details className="panel">
        <summary>Import a flow or flow suite</summary>
        <label>
          Format
          <select
            value={sourceFormat}
            onChange={(e) => setSourceFormat(e.target.value as 'yaml' | 'json')}
          >
            <option value="json">JSON</option>
            <option value="yaml">YAML</option>
          </select>
        </label>
        <label>
          Document
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
        </label>
        <button
          disabled={busy || !source.trim()}
          onClick={() =>
            void action(async () => {
              const d = await request<DocumentInfo>('flow-documents/import', {
                source,
                format: sourceFormat,
              });
              await refresh();
              if (d.kind === 'decision-flow') await loadFlow(d.id);
              else {
                setSuite(await request(`flow-documents/${d.id}`));
                setSuiteId(d.id);
              }
              setSource('');
            })
          }
        >
          Import flow document
        </button>
      </details>
    </section>
  );
}
