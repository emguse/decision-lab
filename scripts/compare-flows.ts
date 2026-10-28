import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  flowExecutionSchema,
  flowSuiteSchema,
  expectationSchema,
  validateExpectation,
  gradeFlow,
} from '../shared/flows.js';
import { settingsSchema } from '../shared/evaluation.js';
import { flowMetrics } from '../shared/flow-metrics.js';

const resultsSchema = z.object({
  kind: z.literal('flow-results'),
  schemaVersion: z.literal(1),
  suite: flowSuiteSchema,
  source: z.enum(['expected', 'individual', 'reference']),
  cases: z.array(
    z.object({
      execution: flowExecutionSchema,
      labels: expectationSchema.nullable(),
      settings: settingsSchema,
      revisionId: z.string().uuid().nullable(),
    }),
  ),
});
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { output: { type: 'string' } },
});
if (!values.output || positionals.length < 2)
  throw new Error(
    'Usage: npm run compare:flows -- --output NEW_RESULT.json BASE_RESULTS.json VARIANT_RESULTS.json [...]',
  );
const inputs = positionals.map((path) =>
  resultsSchema.parse(JSON.parse(readFileSync(resolve(path), 'utf8'))),
);
const rows = inputs.flatMap((input) =>
  input.cases.map((row) => {
    const item = input.suite.cases.find((c) => c.id === row.execution.caseId);
    if (!item)
      throw new Error('Execution case is absent from its exported Suite.');
    if (row.labels)
      validateExpectation(
        row.execution.flow,
        row.execution.definitions,
        row.labels,
      );
    return {
      ...row,
      provenance: item.provenance,
      partition: item.partition,
      judgments: row.labels?.judgments,
      resultPass: row.labels
        ? gradeFlow(row.execution, row.labels, row.settings).resultPass
        : null,
      labelSource: input.source,
    };
  }),
);
if (new Set(rows.map((row) => row.execution.id)).size !== rows.length)
  throw new Error('An execution appears more than once.');
const partitions = new Map<string, string>();
for (const row of rows) {
  const key = JSON.stringify([
    row.provenance.source,
    row.provenance.revision,
    row.provenance.evidenceGroup,
  ]);
  if (partitions.has(key) && partitions.get(key) !== row.partition)
    throw new Error(
      'An evidence group crosses tuning and evaluation partitions.',
    );
  partitions.set(key, row.partition);
}
const result = {
  kind: 'flow-comparison',
  schemaVersion: 1,
  exportedAt: new Date().toISOString(),
  sources: positionals,
  cases: rows,
  metrics: flowMetrics(rows),
};
writeFileSync(resolve(values.output), JSON.stringify(result, null, 2) + '\n', {
  flag: 'wx',
});
console.log(
  `Compared ${rows.length} exported executions. No inference was performed.`,
);
