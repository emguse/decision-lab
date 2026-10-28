import type { FlowExecution, FlowSuite } from './flows.js';
import type { Labels } from './evaluation.js';

export function flowMetrics(
  rows: {
    execution: FlowExecution;
    judgments?: Record<string, Labels>;
    resultPass: boolean | null;
    provenance: FlowSuite['cases'][number]['provenance'];
    partition: string;
  }[],
) {
  const probabilities: {
    type: 'noul' | 'choice';
    p: number;
    correct: boolean;
    brier: number;
    group: string;
    expected: string;
    predicted: string;
  }[] = [];
  const scoreErrors: number[] = [];
  for (const row of rows)
    for (const step of row.execution.steps)
      for (const [key, expected] of Object.entries(
        row.judgments?.[step.nodeId] ?? {},
      )) {
        const a = step.response.answers[key];
        if (!a) continue;
        if (a.type === 'score' && typeof expected === 'number')
          scoreErrors.push(Math.abs(a.score - expected));
        if (a.type === 'noul' && typeof expected === 'boolean')
          probabilities.push({
            type: 'noul',
            p: Math.max(a.noul, 1 - a.noul),
            correct: a.noul >= 0.5 === expected,
            brier: (a.noul - Number(expected)) ** 2,
            group: `${step.nodeId}/${key}`,
            expected: String(expected),
            predicted: String(a.noul >= 0.5),
          });
        if (a.type === 'choice' && typeof expected === 'string')
          probabilities.push({
            type: 'choice',
            p: a.probabilities[a.choice],
            correct: a.choice === expected,
            brier: Object.entries(a.probabilities).reduce(
              (sum, [option, p]) =>
                sum + (p - Number(option === expected)) ** 2,
              0,
            ),
            group: `${step.nodeId}/${key}`,
            expected,
            predicted: a.choice,
          });
      }
  const f1 = [...new Set(probabilities.map((v) => v.group))].map((group) => {
    const values = probabilities.filter((v) => v.group === group);
    const classes = [
      ...new Set(values.flatMap((v) => [v.expected, v.predicted])),
    ];
    return {
      group,
      macroF1:
        classes.reduce((sum, label) => {
          const tp = values.filter(
            (v) => v.expected === label && v.predicted === label,
          ).length;
          const fp = values.filter(
            (v) => v.expected !== label && v.predicted === label,
          ).length;
          const fn = values.filter(
            (v) => v.expected === label && v.predicted !== label,
          ).length;
          return sum + ((2 * tp) / (2 * tp + fp + fn) || 0);
        }, 0) / classes.length,
    };
  });
  const certainty = (e: FlowExecution) =>
    Math.min(
      1,
      ...e.steps.flatMap((s) => {
        const node = e.flow.nodes.find((n) => n.id === s.nodeId);
        if (node?.type !== 'decision') return [];
        const used = new Set(
          node.branches
            .slice(0, s.branchIndex === null ? undefined : s.branchIndex + 1)
            .flatMap((b) => b.conditions.map((c) => c.question)),
        );
        return [...used]
          .map((key) => s.response.answers[key])
          .map((a) =>
            a.type === 'noul' ? Math.abs(2 * a.noul - 1) : a.confidence,
          );
      }),
    );
  const labeled = rows.filter((r) => r.resultPass !== null);
  const stability = new Map<string, typeof rows>();
  for (const row of rows)
    if (row.provenance.variantGroup) {
      const key = JSON.stringify([
        row.provenance.source,
        row.provenance.revision,
        row.partition,
        row.provenance.variantGroup,
        row.execution.connectionFingerprint,
        row.execution.model,
      ]);
      stability.set(key, [...(stability.get(key) ?? []), row]);
    }
  const groups = [...stability.values()].filter(
    (g) => g.length > 1 && g.every((r) => r.execution.status === 'completed'),
  );
  const latencies = rows
    .filter((r) => r.execution.status === 'completed')
    .map((r) => r.execution.steps.reduce((s, step) => s + step.elapsedMs, 0))
    .sort((a, b) => a - b);
  const slices = [
    ...new Set(
      rows.map(
        (r) => `${r.provenance.domain}/${r.provenance.language}/${r.partition}`,
      ),
    ),
  ].map((key) => {
    const slice = rows.filter(
      (r) =>
        `${r.provenance.domain}/${r.provenance.language}/${r.partition}` ===
        key,
    );
    const scored = slice.filter((r) => r.resultPass !== null);
    return {
      key,
      cases: slice.length,
      labeled: scored.length,
      accuracy: scored.length
        ? scored.filter((r) => r.resultPass).length / scored.length
        : null,
    };
  });
  const calibration = (type: 'noul' | 'choice') => {
    const values = probabilities.filter((v) => v.type === type);
    const typeBins = Array.from({ length: 10 }, (_, i) => {
      const b = values.filter((v) => Math.min(9, Math.floor(v.p * 10)) === i);
      return {
        count: b.length,
        probability: b.length
          ? b.reduce((sum, v) => sum + v.p, 0) / b.length
          : null,
        accuracy: b.length
          ? b.filter((v) => v.correct).length / b.length
          : null,
      };
    });
    return {
      samples: values.length,
      brier: values.length
        ? values.reduce((sum, v) => sum + v.brier, 0) / values.length
        : null,
      ece: values.length
        ? typeBins.reduce(
            (sum, b) =>
              sum +
              (b.count / values.length) *
                Math.abs((b.probability ?? 0) - (b.accuracy ?? 0)),
            0,
          )
        : null,
      bins: typeBins,
    };
  };
  return {
    labeled: labeled.length,
    missingLabels: rows.length - labeled.length,
    failed: rows.filter((r) => r.execution.status !== 'completed').length,
    accuracy: labeled.length
      ? labeled.filter((r) => r.resultPass).length / labeled.length
      : null,
    calibration: { noul: calibration('noul'), choice: calibration('choice') },
    score: {
      samples: scoreErrors.length,
      mae: scoreErrors.length
        ? scoreErrors.reduce((sum, value) => sum + value, 0) /
          scoreErrors.length
        : null,
    },
    macroF1: f1,
    coverageBasis:
      'Minimum reported confidence over questions referenced by considered routing branches; Noul uses abs(2p-1). This is a gating statistic, not workflow correctness probability.',
    coverageRisk: Array.from({ length: 11 }, (_, i) => {
      const threshold = i / 10;
      const accepted = labeled.filter(
        (r) =>
          r.execution.status === 'completed' &&
          certainty(r.execution) >= threshold,
      );
      return {
        threshold,
        accepted: accepted.length,
        coverage: labeled.length ? accepted.length / labeled.length : null,
        errorRate: accepted.length
          ? accepted.filter((r) => !r.resultPass).length / accepted.length
          : null,
      };
    }),
    stability: {
      groups: groups.length,
      consistent: groups.filter((g) =>
        g.every(
          (r) =>
            r.execution.result?.resultId === g[0].execution.result?.resultId,
        ),
      ).length,
    },
    latency: {
      basis:
        'serial end-to-end inference milliseconds; includes network and runtime overhead',
      p50: latencies.length
        ? latencies[
            Math.min(latencies.length - 1, Math.floor(latencies.length * 0.5))
          ]
        : null,
      p95: latencies.length
        ? latencies[
            Math.min(
              latencies.length - 1,
              Math.ceil(latencies.length * 0.95) - 1,
            )
          ]
        : null,
    },
    cost: { basis: 'unknown', amount: null },
    slices,
  };
}
