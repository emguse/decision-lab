import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  banking77Bundle,
  openImagesBundle,
} from '../shared/benchmark-import.js';
import { serializeDocument } from '../shared/exchange.js';

const { values } = parseArgs({
  options: {
    dataset: { type: 'string' },
    input: { type: 'string' },
    output: { type: 'string' },
    revision: { type: 'string' },
    split: { type: 'string' },
    categories: { type: 'string' },
    images: { type: 'string' },
    label: { type: 'string' },
    description: { type: 'string' },
    seed: { type: 'string', default: '42' },
    limit: { type: 'string', default: '30' },
    partition: { type: 'string', default: 'evaluation' },
    version: { type: 'string', default: '1' },
  },
});
if (!values.input || !values.output || !values.revision || !values.split)
  throw new Error(
    'Required: --dataset banking77|open-images --input SOURCE.csv --output DIRECTORY --revision IMMUTABLE_SOURCE_REVISION --split SOURCE_SPLIT',
  );
if (!['tuning', 'evaluation'].includes(values.partition!))
  throw new Error('Use tuning or evaluation partition.');
const options = {
  revision: values.revision,
  split: values.split,
  seed: Number(values.seed),
  limit: Number(values.limit),
  partition: values.partition as 'tuning' | 'evaluation',
  version: Number(values.version),
};
const csv = readFileSync(resolve(values.input), 'utf8');
const bundle =
  values.dataset === 'banking77'
    ? banking77Bundle(
        csv,
        values.categories
          ?.split(',')
          .map((c) => c.trim())
          .filter(Boolean) ?? [],
        options,
      )
    : values.dataset === 'open-images' && values.images
      ? openImagesBundle(
          csv,
          JSON.parse(readFileSync(resolve(values.images), 'utf8')),
          { id: values.label ?? '', description: values.description ?? '' },
          options,
        )
      : null;
if (!bundle)
  throw new Error(
    'Select banking77 or open-images (requires --images MANIFEST.json).',
  );
const directory = resolve(values.output);
mkdirSync(directory, { recursive: true });
if (
  Object.keys(bundle).some((name) =>
    existsSync(join(directory, `${name}.json`)),
  )
)
  throw new Error('Output artifacts already exist; choose a new directory.');
for (const [name, document] of Object.entries(bundle)) {
  const path = join(directory, `${name}.json`);
  // Existing artifacts are never overwritten silently.
  writeFileSync(path, serializeDocument(document, 'json'), { flag: 'wx' });
}
console.log(
  `Prepared ${bundle.suite.cases.length} cases in ${directory}. Import definition.json in Suites, then flow.json and suite.json in Flows. No inference or dataset downloads were performed.`,
);
