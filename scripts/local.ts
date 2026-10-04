import { initialQuery } from '../shared/schema.js';
import { grade } from '../shared/evaluation.js';
// Uses the running application so configuration, actor capture, and persistence match the UI.
const origin = 'http://127.0.0.1:8787';
async function request(path: string, body?: unknown) {
  const response = await fetch(`${origin}/api/${path}`, {
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
    signal: AbortSignal.timeout(65000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Local smoke failed');
  return data;
}
try {
  const config = await request('config');
  const health = await request('providers/strands-local/health');
  if (health.status !== 'ready')
    throw new Error(
      'Start the configured Python server before running this local check.',
    );
  const saved = await request('runs', {
    title: 'Local Japanese smoke test',
    provider: 'strands-local',
    blind: true,
    query: {
      ...initialQuery,
      model: config.providers['strands-local'].model,
      state:
        '同じ注文で二重に請求されました。至急返金してください。困っています。',
    },
  });
  // Fixture reference judgments are fixed before inference, never derived from predictions.
  const draft = {
    labels: { is_urgent: true, department: 'billing', frustration: 1 },
    note: 'Fixed smoke-fixture references; not a general accuracy benchmark.',
    settings: { threshold: 0.5, tolerance: 0.5 },
  };
  const evaluation = await request(`runs/${saved.run.id}/finalize`, draft);
  const grading = grade(evaluation.run, draft.labels, draft.settings);
  const reloaded = await request(`runs/${saved.run.id}/evaluation`);
  if (reloaded.run.id !== saved.run.id)
    throw new Error('Saved evaluation did not reload');
  console.log(
    JSON.stringify({
      id: saved.run.id,
      execution: evaluation.run.execution,
      elapsedMs: evaluation.run.elapsedMs,
      usage: evaluation.run.response.usage,
      grading,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local smoke failed');
  process.exitCode = 1;
}
