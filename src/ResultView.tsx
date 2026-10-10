import type { Run } from '../shared/schema';
const pretty = (v: unknown) => JSON.stringify(v, null, 2);
export function ResultView({ result }: { result: Run }) {
  return (
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
                    ? `${key} · ${typeof a.legend[key] === 'string' ? a.legend[key] : JSON.stringify(a.legend[key])}`
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
        <pre>{pretty(result.rawResponse ?? result.response)}</pre>
      </details>
      <p className="hint">
        接続先：{result.execution?.provider ?? 'jev'} · モデルの正確な重み版：
        {result.execution?.artifactRevision ?? '不明'}
      </p>
      <details className="raw">
        <summary>実行時のクエリ</summary>
        <pre>{pretty(result.query)}</pre>
      </details>
    </>
  );
}
