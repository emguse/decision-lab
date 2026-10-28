import sharp from 'sharp';
import { test, expect } from '@playwright/test';
import { mockApi } from './mock';
import {
  serializeDocument,
  definitionSchema,
  suiteSchema,
} from '../../shared/exchange';
import { initialQuery } from '../../shared/schema';
import { readFile } from 'node:fs/promises';

const definition = definitionSchema.parse({
  kind: 'decision-definition',
  schemaVersion: 1,
  name: 'support',
  version: 1,
  questions: initialQuery.questions,
});
const suite = suiteSchema.parse({
  kind: 'experiment-suite',
  schemaVersion: 1,
  name: 'support-evaluation',
  version: 1,
  definition: { name: definition.name, version: 1 },
  cases: [
    {
      id: 'q001',
      state: { query: '返金をお願いしたい', context: '日本語' },
      expected: { is_urgent: true, department: 'billing', frustration: 1 },
    },
    { id: 'q002', state: '手順を教えて', expected: { department: 'billing' } },
  ],
});
test('imports YAML/JSON, runs a Suite blind, grades independently, and exports a complete result without another model call', async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Suites', exact: true }).click();
  await expect(page.getByLabel('Suite image support')).toContainText(
    'Image cases use schemaVersion 2',
  );
  await expect(page.getByLabel('Suite image support')).toContainText(
    'Attach images to saved cases',
  );
  await expect(page.getByText('No file selected', { exact: true })).toHaveCount(
    2,
  );
  await expect(
    page.getByRole('button', { name: 'Choose input file 1' }),
  ).toHaveText('Choose file');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose input file 1' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'definition.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from(serializeDocument(definition, 'yaml')),
  });
  await expect(
    page.getByText('definition.yaml', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Input text 1')).toHaveValue(
    serializeDocument(definition, 'yaml'),
  );
  await page.getByLabel('Input format 2').selectOption('json');
  await page.getByLabel('Input text 2').fill(serializeDocument(suite, 'json'));
  await expect(
    page.getByRole('button', { name: 'Save input', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Validate and preview' }).click();
  await expect(page.getByLabel('Import preview')).toContainText('2 cases');
  expect(mock.calls()).toBe(0);
  await page.getByRole('button', { name: 'Save input', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'support-evaluation v1 · 2 cases' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Run suite sequentially' }).click();
  await expect(
    page.getByText('Execution status: completed · Succeeded 2 / 2'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'YAML results export' }),
  ).toBeDisabled();
  expect(
    JSON.stringify(
      mock.bodies.filter(
        (b) =>
          b.path.includes('suite-executions') || b.path.match(/\/suites\//),
      ),
    ),
  ).not.toMatch(/"(expected|response|probabilities|grading)"/);
  for (let i = 0; i < 2; i++) {
    await page
      .getByRole('button', { name: 'Open blind evaluation', exact: true })
      .first()
      .click();
    await expect(page.getByLabel('is_urgent Yes')).not.toBeChecked();
    await page.getByLabel('is_urgent Yes').check();
    await page.getByLabel('Reference department').selectOption('billing');
    await page.getByLabel('Reference frustration').selectOption('1');
    await page
      .getByRole('button', { name: 'Finalize labels and reveal answers' })
      .click();
    await expect(
      page.getByRole('heading', {
        name: 'Comparison with imported expectations',
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Suites', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'support-evaluation v1 · 2 cases' }),
    ).toBeVisible();
  }
  await page
    .getByRole('button', { name: 'Summarize results', exact: true })
    .click();
  await expect(
    page.getByText('Missing labels 2 · Failed / interrupted 0 · Unfinished 0'),
  ).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON results export' }).click();
  const file = await downloaded;
  const result = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(result.kind).toBe('experiment-results');
  expect(result.suite).toEqual(suite);
  expect(result.definition).toEqual(definition);
  expect(result.summary.choice.total).toBe(2);
  expect(result.results[0].grading.source).toBe('expected');
  expect(result.results[0]).not.toHaveProperty('rawResponse');
  expect(mock.calls()).toBe(2);
  await page.screenshot({
    path: test.info().outputPath('suites.png'),
    fullPage: true,
  });
});
test('switching profiles keeps suite predictions and imported expectations hidden for the other evaluator', async ({
  page,
}) => {
  const mock = await mockApi(page);
  const first = mock.store.actor(),
    second = mock.store.addUser('Evaluator B').id;
  await page.goto('/');
  await page.getByRole('button', { name: 'Suites', exact: true }).click();
  await page
    .getByLabel('Input text 1')
    .fill(serializeDocument(definition, 'yaml'));
  await page
    .getByLabel('Input text 2')
    .fill(serializeDocument({ ...suite, cases: [suite.cases[0]] }, 'yaml'));
  await page.getByRole('button', { name: 'Validate and preview' }).click();
  await page.getByRole('button', { name: 'Save input', exact: true }).click();
  await page.getByRole('button', { name: 'Run suite sequentially' }).click();
  await expect(
    page.getByText('Execution status: completed · Succeeded 1 / 1'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open blind evaluation' }).click();
  await page
    .getByText('View answers before finalizing labels', { exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Reveal answers now', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Comparison with imported expectations',
    }),
  ).toBeVisible();
  await page.getByLabel('Local user').selectOption(second);
  await page.getByRole('button', { name: 'Suites', exact: true }).click();
  await page.getByRole('button', { name: 'Open suite', exact: true }).click();
  await expect(page.getByText(/Expectations: Not viewed/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'JSON results export' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Open blind evaluation' }).click();
  await expect(
    page.getByRole('heading', { name: 'Blind evaluation', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'Comparison with imported expectations',
    }),
  ).toHaveCount(0);
  expect(mock.store.listRuns(first)).toHaveLength(1);
  expect(mock.store.listRuns(second)).toHaveLength(0);
});

test('shows failed suite progress and resumes explicitly without falling back to another provider', async ({
  page,
}) => {
  const options = { failure: true };
  const mock = await mockApi(page, options);
  await page.goto('/');
  await page.getByRole('button', { name: 'Suites', exact: true }).click();
  await page
    .getByLabel('Input text 1')
    .fill(serializeDocument(definition, 'yaml'));
  await page.getByLabel('Input text 2').fill(serializeDocument(suite, 'yaml'));
  await page.getByRole('button', { name: 'Validate and preview' }).click();
  await page.getByRole('button', { name: 'Save input', exact: true }).click();
  await page.getByRole('button', { name: 'Run suite sequentially' }).click();
  await expect(
    page.getByText('Execution status: stopped · Succeeded 0 / 2'),
  ).toBeVisible();
  expect(mock.calls()).toBe(1);
  options.failure = false;
  await page.getByRole('button', { name: 'Resume unfinished cases' }).click();
  await expect(
    page.getByText('Execution status: completed · Succeeded 2 / 2'),
  ).toBeVisible();
  expect(mock.calls()).toBe(3);
  expect(mock.localCalls()).toBe(0);
  const execution = mock.store.listSuiteExecutions()[0];
  expect(execution.cases.map((c) => c.attempts.length)).toEqual([2, 1]);
});

test('returns to the selected older execution and saves labels before opening help', async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Suites', exact: true }).click();
  await page
    .getByLabel('Input text 1')
    .fill(serializeDocument(definition, 'yaml'));
  await page
    .getByLabel('Input text 2')
    .fill(serializeDocument({ ...suite, cases: [suite.cases[0]] }, 'yaml'));
  await page.getByRole('button', { name: 'Validate and preview' }).click();
  await page.getByRole('button', { name: 'Save input', exact: true }).click();
  await expect(page.getByLabel('Input text 1')).toBeHidden();
  await page.getByRole('button', { name: 'Run suite sequentially' }).click();
  await expect(
    page.getByText('Execution status: completed · Succeeded 1 / 1'),
  ).toBeVisible();
  const older = await page.getByLabel('Suite execution history').inputValue();
  await page.getByRole('button', { name: 'Run suite sequentially' }).click();
  await expect(page.getByLabel('Suite execution history')).not.toHaveValue(
    older,
  );
  await expect(
    page.getByText('Execution status: completed · Succeeded 1 / 1'),
  ).toBeVisible();
  await page.getByLabel('Suite execution history').selectOption(older);
  await page.getByRole('button', { name: 'Open blind evaluation' }).click();
  await page.getByLabel('is_urgent Yes').check();
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'User guide', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to work' }).click();
  await expect(page.getByLabel('is_urgent Yes')).toBeChecked();
  await page.getByRole('button', { name: 'Back to suite execution' }).click();
  await expect(page.getByLabel('Suite execution history')).toHaveValue(older);
  await page.getByRole('button', { name: 'Open blind evaluation' }).click();
  await expect(page.getByLabel('is_urgent Yes')).toBeChecked();
  expect(mock.calls()).toBe(2);
  await page.getByRole('button', { name: 'Back to suite execution' }).click();
  await page.getByRole('button', { name: 'Back to suite list' }).click();
  await expect(
    page.getByRole('button', { name: 'Open suite', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Playground', exact: true }).click();
  await page.getByRole('button', { name: 'Run decision' }).click();
  await expect(
    page.getByRole('heading', { name: 'Blind evaluation', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Back to suite execution' }),
  ).toHaveCount(0);
});

test('retains ordered originals in an unexecuted image Suite and runs them through the local connection', async ({
  page,
}) => {
  const model = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';
  const api = await mockApi(page, {
    local: true,
    vision: true,
    localModel: model,
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Suites', exact: true }).click();
  await page
    .getByLabel('Input text 1')
    .fill(serializeDocument(definition, 'json'));
  await page.getByLabel('Input format 1').selectOption('json');
  await page
    .getByLabel('Input text 2')
    .fill(serializeDocument({ ...suite, cases: [suite.cases[0]] }, 'json'));
  await page.getByLabel('Input format 2').selectOption('json');
  await page.getByRole('button', { name: 'Validate and preview' }).click();
  await page.getByRole('button', { name: 'Save input', exact: true }).click();
  await page.getByText('Case images', { exact: true }).click();
  const files = await Promise.all(
    [2, 3].map(async (width) => ({
      name: `original-${width}.png`,
      mimeType: 'image/png',
      buffer: await sharp({
        create: { width, height: 2, channels: 3, background: '#f00' },
      })
        .png()
        .toBuffer(),
    })),
  );
  await page.getByLabel('Add images').setInputFiles(files);
  await expect(page.getByAltText('Input image 2')).toBeVisible();
  await page.getByLabel('Move image 2 left').click();
  await page
    .getByRole('button', {
      name: 'Save case images as new version',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('heading', { name: 'support-evaluation v2 · 1 cases' }),
  ).toBeVisible();
  const saved = api.store
    .listDocuments()
    .find((d) => d.kind === 'experiment-suite' && d.version === 2)!;
  const document = api.store.getDocument(saved.id);
  if (document.kind !== 'experiment-suite') throw new Error('Expected Suite');
  expect(document.schemaVersion).toBe(2);
  expect(document.cases[0].imageIds).toHaveLength(2);
  expect(api.store.getImage(document.cases[0].imageIds![0]).width).toBe(3);
  expect(api.calls()).toBe(0);
  await page
    .getByRole('combobox', { name: 'Suite connection', exact: true })
    .selectOption('strands-local');
  await page.getByRole('button', { name: 'Run suite sequentially' }).click();
  await expect(
    page.getByText('Execution status: completed · Succeeded 1 / 1'),
  ).toBeVisible();
  const run = api.store.getRun(
    api.store.listSummaries(api.store.actor())[0].id,
  );
  expect(run.query.imageIds).toEqual(document.cases[0].imageIds);
  await page.getByRole('button', { name: 'Open blind evaluation' }).click();
  await expect(page.getByAltText('Input image 2')).toBeVisible();
  await expect(page.getByText('0.9000', { exact: true })).toHaveCount(0);
});
