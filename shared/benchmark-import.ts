import { createHash } from 'node:crypto';
import { z } from 'zod';
import { definitionSchema, type Definition } from './exchange.js';
import {
  flowSchema,
  flowSuiteSchema,
  validateFlow,
  type Flow,
  type FlowSuite,
} from './flows.js';

const importOptionsSchema = z.object({
  revision: z.string().trim().min(1),
  split: z.string().trim().min(1).max(80),
  seed: z.number().int().nonnegative().max(0xffffffff),
  limit: z.number().int().min(1).max(100),
  partition: z.enum(['tuning', 'evaluation']),
  version: z.number().int().positive().default(1),
});
export type BenchmarkOptions = z.input<typeof importOptionsSchema>;
export interface BenchmarkBundle {
  definition: Definition;
  flow: Flow;
  suite: FlowSuite;
}

// CSV quotes and embedded newlines are retained; malformed rows fail explicitly.
export function parseCsv(source: string): string[][] {
  const rows: string[][] = [],
    row: string[] = [];
  let value = '',
    quoted = false,
    closed = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else value += c;
    } else if (c === '"') {
      if (value || closed) throw new Error('Invalid CSV quoting.');
      quoted = true;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(value);
      value = '';
      closed = false;
      if (c !== ',') {
        if (row.some((v) => v !== '')) rows.push([...row]);
        row.length = 0;
        if (c === '\r' && source[i + 1] === '\n') i++;
      }
    } else {
      if (closed) throw new Error('Unexpected text after CSV quote.');
      value += c;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote.');
  row.push(value);
  if (row.some((v) => v !== '')) rows.push([...row]);
  if (rows.length && rows.some((r) => r.length !== rows[0].length))
    throw new Error('CSV column count mismatch.');
  return rows;
}
function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function bankingIntentId(category: string) {
  return `intent_${createHash('sha256').update(category).digest('base64url')}`;
}
function sample<T>(rows: T[], seed: number, limit: number) {
  const copy = [...rows];
  let state = seed >>> 0;
  for (let i = copy.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, limit);
}
export function banking77Bundle(
  csv: string,
  categories: string[],
  input: BenchmarkOptions,
): BenchmarkBundle {
  const options = importOptionsSchema.parse(input),
    rows = parseCsv(csv),
    header = rows.shift() ?? [];
  const textIndex = header.indexOf('text'),
    categoryIndex = header.indexOf('category');
  if (textIndex < 0 || categoryIndex < 0)
    throw new Error('BANKING77 CSV requires text and category columns.');
  if (
    categories.length < 2 ||
    categories.length > 30 ||
    new Set(categories).size !== categories.length
  )
    throw new Error(
      'Select 2–30 distinct categories for a bounded comparison.',
    );
  const available = new Set(rows.map((r) => r[categoryIndex]));
  if (categories.some((c) => !available.has(c)))
    throw new Error('A selected category is absent from the source.');
  const definition = definitionSchema.parse({
    kind: 'decision-definition',
    schemaVersion: 1,
    name: 'banking77-selected-intents',
    version: options.version,
    questions: {
      intent: {
        type: 'choice',
        instructions: 'Choose the banking intent of the utterance in `input`.',
        criteria: Object.fromEntries(
          categories.map((c) => [c, c.replaceAll('_', ' ')]),
        ),
      },
    },
  });
  const flow = flowSchema.parse({
    kind: 'decision-flow',
    schemaVersion: 1,
    name: definition.name,
    version: options.version,
    nodes: [
      {
        id: 'input',
        type: 'input',
        title: 'Banking utterance',
        next: 'classify',
      },
      {
        id: 'classify',
        type: 'decision',
        title: 'Select intent',
        definition: { name: definition.name, version: definition.version },
        branches: categories.map((value) => ({
          conditions: [{ type: 'choice', question: 'intent', value }],
          target: bankingIntentId(value),
        })),
        defaultTarget: 'review',
      },
      ...categories.map((value) => ({
        id: bankingIntentId(value),
        type: 'result',
        title: value,
        resultId: bankingIntentId(value),
        description: value,
      })),
      {
        id: 'review',
        type: 'result',
        title: 'Needs review',
        resultId: 'review',
        description: 'No matching intent.',
      },
    ],
  });
  const candidates = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => categories.includes(r[categoryIndex]));
  const suite = flowSuiteSchema.parse({
    kind: 'flow-suite',
    schemaVersion: 1,
    name: `banking77-${options.partition}`,
    version: options.version,
    flow: { name: flow.name, version: flow.version },
    cases: sample(candidates, options.seed, options.limit).map(({ r, i }) => {
      const result = bankingIntentId(r[categoryIndex]);
      return {
        id: `banking_${i}`,
        state: r[textIndex],
        partition: options.partition,
        provenance: {
          source: 'https://github.com/PolyAI-LDN/task-specific-datasets',
          revision: options.revision,
          sourceCaseId: `${options.split}/${i}`,
          license: 'CC-BY-4.0',
          transformVersion: `banking77-choice-v2;seed=${options.seed};selection=${digest(JSON.stringify(categories)).slice(0, 16)}`,
          language: 'en',
          domain: 'public-intent-classification',
          evidenceGroup: digest(r[textIndex].trim()),
          labelOrigin: 'source',
        },
        expected: {
          resultId: result,
          path: ['input', 'classify', result],
          judgments: { classify: { intent: r[categoryIndex] } },
        },
      };
    }),
  });
  validateFlow(flow, { classify: definition });
  return { definition, flow, suite };
}

const imageManifestSchema = z.record(
  z.string(),
  z
    .object({
      imageIds: z.array(z.string().uuid()).length(1),
      sourceUrl: z.string().url(),
      imageLicense: z.string().trim().min(1),
      licenseVerified: z.literal(true),
    })
    .strict(),
);
export function openImagesBundle(
  csv: string,
  manifest: unknown,
  label: { id: string; description: string },
  input: BenchmarkOptions,
): BenchmarkBundle {
  const options = importOptionsSchema.parse(input),
    images = imageManifestSchema.parse(manifest),
    rows = parseCsv(csv),
    header = rows.shift() ?? [];
  const imageIndex = header.indexOf('ImageID'),
    labelIndex = header.indexOf('LabelName'),
    confidenceIndex = header.indexOf('Confidence');
  if ([imageIndex, labelIndex, confidenceIndex].some((i) => i < 0))
    throw new Error(
      'Use human-verified Open Images image-level labels with ImageID, LabelName and Confidence.',
    );
  if (!label.id.trim() || !label.description.trim())
    throw new Error(
      'Specify the upstream label ID and its readable description.',
    );
  const definition = definitionSchema.parse({
    kind: 'decision-definition',
    schemaVersion: 1,
    name: 'open-images-presence',
    version: options.version,
    questions: {
      present: {
        type: 'noul',
        instructions: `Is ${label.description} present in the attached original image?`,
      },
    },
  });
  const flow = flowSchema.parse({
    kind: 'decision-flow',
    schemaVersion: 1,
    name: definition.name,
    version: options.version,
    nodes: [
      {
        id: 'input',
        type: 'input',
        title: 'Original photograph',
        next: 'recognize',
      },
      {
        id: 'recognize',
        type: 'decision',
        title: 'Verify object presence',
        definition: { name: definition.name, version: definition.version },
        branches: [
          {
            conditions: [
              {
                type: 'noul',
                question: 'present',
                operator: 'gte',
                value: 0.5,
              },
            ],
            target: 'present',
          },
        ],
        defaultTarget: 'absent',
      },
      {
        id: 'present',
        type: 'result',
        title: 'Present',
        resultId: 'present',
        description: label.description,
      },
      {
        id: 'absent',
        type: 'result',
        title: 'Absent',
        resultId: 'absent',
        description: label.description,
      },
    ],
  });
  const selected = rows.filter(
    (r) =>
      r[labelIndex] === label.id &&
      Object.hasOwn(images, r[imageIndex]) &&
      ['0', '1'].includes(r[confidenceIndex]),
  );
  if (new Set(selected.map((r) => r[imageIndex])).size !== selected.length)
    throw new Error('Duplicate verified labels for an image.');
  const suite = flowSuiteSchema.parse({
    kind: 'flow-suite',
    schemaVersion: 1,
    name: `open-images-${options.partition}`,
    version: options.version,
    flow: { name: flow.name, version: flow.version },
    cases: sample(selected, options.seed, options.limit).map((r) => {
      const original = images[r[imageIndex]],
        present = r[confidenceIndex] === '1',
        result = present ? 'present' : 'absent';
      return {
        id: `image_${r[imageIndex]}`,
        state: { sourceImageId: r[imageIndex] },
        imageIds: original.imageIds,
        partition: options.partition,
        provenance: {
          source: original.sourceUrl,
          revision: options.revision,
          sourceCaseId: r[imageIndex],
          license: `annotations: CC-BY-4.0; image: ${original.imageLicense}`,
          transformVersion: `open-images-noul-v1;label=${label.id};seed=${options.seed}`,
          language: 'en',
          domain: 'public-image-recognition',
          evidenceGroup: r[imageIndex],
          labelOrigin: 'source',
        },
        expected: {
          resultId: result,
          path: ['input', 'recognize', result],
          judgments: { recognize: { present } },
        },
      };
    }),
  });
  validateFlow(flow, { recognize: definition });
  return { definition, flow, suite };
}
