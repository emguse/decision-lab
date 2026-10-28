import sharp from 'sharp';
import { test, expect } from '@playwright/test';
import { mockApi } from './mock';
import { FlowService } from '../../server/flows';
import {
  exampleFlow,
  exampleFlowDefinition,
  exampleFlowSuite,
} from '../../shared/flow-examples';

test('builds connections, runs two judgments, reveals the trace and evaluates a suite', async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  await page
    .getByRole('button', { name: 'Load example flow', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Judgment card' }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Card editor').getByText('First matching branch wins'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save flow', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Run decision flow', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Run decision flow', exact: true })
    .click();
  await expect(
    page.getByText('Status: completed · Blind for this profile'),
  ).toBeVisible();
  expect(mock.calls()).toBe(2);
  await expect(page.getByLabel('Execution trace')).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Expected final result', exact: true })
    .selectOption('urgent_billing');
  await page
    .getByRole('button', { name: 'Finalize labels and reveal', exact: true })
    .click();
  await expect(
    page
      .getByLabel('Execution trace')
      .getByText('Result: urgent_billing', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.flow-card.traversed')).toHaveCount(4);
  await expect(page.locator('.flow-edge.traversed')).toHaveCount(3);
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 2000, height: 1000 });
  await page
    .locator('.flow-design')
    .screenshot({ path: test.info().outputPath('decision-flow.png') });
  if (viewport) await page.setViewportSize(viewport);
  await page
    .getByRole('button', { name: 'Load example suite', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Save flow suite', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Run flow suite sequentially', exact: true })
    .click();
  await expect(page.locator('.flow-execution-select')).toHaveCount(2);
  await expect(page.locator('.flow-execution-select').first()).toContainText(
    'completed',
  );
  await expect(page.locator('.flow-execution-select').last()).toContainText(
    'completed',
  );
  await page
    .getByRole('button', { name: 'Evaluate selected executions', exact: true })
    .click();
  await expect(
    page
      .getByRole('alert')
      .getByText('Reveal each execution before inspecting results.', {
        exact: true,
      }),
  ).toBeVisible();
  for (let i = 0; i < 2; i++) {
    await page
      .locator('.flow-execution-select')
      .nth(i)
      .getByRole('button', { name: 'Evaluate case' })
      .click();
    await page
      .getByRole('button', { name: 'Reveal flow answers', exact: true })
      .click();
  }
  await page
    .getByRole('button', { name: 'Evaluate selected executions', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Export flow results JSON', exact: true }),
  ).toBeVisible();
  expect(mock.calls()).toBe(6);
  const priorId = mock.store.listFlowExecutions()[0].id;
  const secondUser = mock.store.addUser('Second evaluator');
  await page.reload();
  await page
    .getByRole('combobox', { name: 'Local user', exact: true })
    .selectOption(secondUser.id);
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Execution', exact: true })
    .selectOption(priorId);
  await expect(
    page.getByText('Status: completed · Blind for this profile'),
  ).toBeVisible();
  await expect(page.getByLabel('Execution trace')).toHaveCount(0);
  mock.store.close();
});

test('rejects a cycle and edits branch wiring without code', async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  await page
    .getByRole('button', { name: 'Load example flow', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Connect priority', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Select card triage', exact: true })
    .click();
  await expect(
    page.getByText('Cycles are not supported.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save flow', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Select card priority', exact: true })
    .click();
  await page.getByLabel('Otherwise go to (required)').selectOption('billing');
  await expect(
    page.getByRole('button', { name: 'Save flow', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Select card triage', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add branch', exact: true }).click();
  await expect(
    page.getByRole('group', { name: 'Branch 3', exact: true }),
  ).toBeVisible();
  const branch = page.getByRole('group', { name: 'Branch 3', exact: true });
  await branch.getByRole('button', { name: 'Move up', exact: true }).click();
  await expect(
    page
      .getByRole('group', { name: 'Branch 2', exact: true })
      .getByRole('combobox', { name: 'Question', exact: true }),
  ).toHaveValue('is_urgent');
  mock.store.close();
});

test('keeps the displayed and executed saved Suite aligned after delayed selection', async ({
  page,
}) => {
  const mock = await mockApi(page);
  const actor = mock.store.actor();
  mock.store.saveDocuments([exampleFlowDefinition], actor);
  const service = new FlowService(mock.store);
  service.save(exampleFlow, actor);
  const suites = [1, 2].map((version) => {
    const document = {
      ...exampleFlowSuite,
      version,
      cases: [
        {
          ...exampleFlowSuite.cases[0],
          id: `saved_case_${version}`,
          state: `Saved Suite input ${version}`,
        },
      ],
    };
    return { id: service.save(document, actor).id, document };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  const selection = page.getByRole('combobox', {
    name: 'Saved flow suite',
    exact: true,
  });
  await expect(selection.locator('option')).toHaveCount(3);
  let previousId = '';
  for (const saved of suites) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const documentUrl = `**/api/flow-documents/${saved.id}`;
    await page.route(documentUrl, async (route) => {
      await gate;
      await route.fallback();
    });
    const requested = page.waitForRequest((request) =>
      request.url().endsWith(`/api/flow-documents/${saved.id}`),
    );
    const responded = page.waitForResponse((response) =>
      response.url().endsWith(`/api/flow-documents/${saved.id}`),
    );
    await selection.selectOption(saved.id);
    await requested;
    try {
      await expect(selection).toHaveValue(previousId);
    } finally {
      release();
    }
    await responded;
    await expect(
      page.getByRole('textbox', { name: 'State (text)', exact: true }),
    ).toHaveValue(saved.document.cases[0].state);
    await expect(selection).toHaveValue(saved.id);
    await expect(
      page.getByRole('textbox', { name: 'Case ID', exact: true }),
    ).toHaveValue(saved.document.cases[0].id);
    await expect(
      page.getByRole('textbox', { name: 'Case ID', exact: true }),
    ).toBeDisabled();
    const run = page.getByRole('button', {
      name: 'Run flow suite sequentially',
      exact: true,
    });
    await expect(run).toBeEnabled();
    const executionRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        /\/api\/flow-suites\/[^/]+\/execute$/.test(
          new URL(request.url()).pathname,
        ),
    );
    await run.click();
    expect(new URL((await executionRequest).url()).pathname).toBe(
      `/api/flow-suites/${saved.id}/execute`,
    );
    await expect(page.locator('.flow-execution-select')).toHaveCount(1);
    await expect(page.locator('.flow-execution-select')).toContainText(
      `${saved.document.cases[0].id} · completed`,
    );
    const executions = mock.store
      .listFlowExecutions()
      .filter((execution) => execution.suiteId === saved.id);
    expect(executions).toHaveLength(1);
    expect(executions[0].caseId).toBe(saved.document.cases[0].id);
    expect(executions[0].input.state).toBe(saved.document.cases[0].state);
    previousId = saved.id;
    await page.unroute(documentUrl);
  }
  expect(mock.calls()).toBe(4);
  mock.store.close();
});

test('adds parsed JSON or literal text to a Suite and rejects invalid JSON without adding a case', async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  await page
    .getByRole('button', { name: 'Load example flow', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save flow', exact: true }).click();
  await page
    .getByRole('button', { name: 'Create suite for this flow', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Input format', exact: true })
    .selectOption('json');
  const input = page.getByRole('textbox', {
    name: 'Original input',
    exact: true,
  });
  await input.fill('{"amount":');
  await page
    .getByRole('button', { name: 'Add case from current input', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(/JSON/);
  await expect(
    page.getByRole('textbox', { name: 'Case ID', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Save flow suite', exact: true }),
  ).toBeDisabled();
  expect(mock.calls()).toBe(0);
  const original = { amount: 100, customer: { id: 'a123' }, items: ['refund'] };
  const source = JSON.stringify(original);
  await input.fill(source);
  await page
    .getByRole('button', { name: 'Run decision flow', exact: true })
    .click();
  await expect(
    page.getByText('Status: completed · Blind for this profile'),
  ).toBeVisible();
  const single = mock.store.listFlowExecutions()[0];
  expect(single.input.state).toEqual(original);
  await page
    .getByRole('button', { name: 'Add case from current input', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Case ID', exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole('combobox', { name: 'Input format', exact: true })
    .selectOption('text');
  await page
    .getByRole('button', { name: 'Add case from current input', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Case ID', exact: true }),
  ).toHaveCount(2);
  await page
    .getByRole('button', { name: 'Save flow suite', exact: true })
    .click();
  const suiteId = mock.store
    .listFlowDocuments()
    .find((document) => document.kind === 'flow-suite')!.id;
  const suite = mock.store.getFlowDocument(suiteId);
  if (suite.kind !== 'flow-suite') throw new Error('Expected flow Suite.');
  expect(suite.cases.map((item) => item.state)).toEqual([original, source]);
  await page
    .getByRole('button', { name: 'Run flow suite sequentially', exact: true })
    .click();
  await expect(page.locator('.flow-execution-select')).toHaveCount(2);
  await expect(page.locator('.flow-execution-select').first()).toContainText(
    'completed',
  );
  await expect(page.locator('.flow-execution-select').last()).toContainText(
    'completed',
  );
  const runs = mock.store
    .listFlowExecutions()
    .filter((execution) => execution.suiteId === suiteId);
  const jsonRun = runs.find(
    (execution) => execution.caseId === suite.cases[0].id,
  )!;
  const textRun = runs.find(
    (execution) => execution.caseId === suite.cases[1].id,
  )!;
  expect(jsonRun.steps.map((step) => step.query.state)).toEqual(
    single.steps.map((step) => step.query.state),
  );
  expect(textRun.input.state).toBe(source);
  expect(mock.calls()).toBe(6);
  mock.store.close();
});

test('blocks new cases during incomplete or failed input image uploads and retains ordered originals', async ({
  page,
}) => {
  const mock = await mockApi(page, { local: true, vision: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  await page
    .getByRole('button', { name: 'Load example flow', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save flow', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Connection', exact: true })
    .selectOption('strands-local');
  await page
    .getByRole('button', { name: 'Create suite for this flow', exact: true })
    .click();
  const addCase = page.getByRole('button', {
    name: 'Add case from current input',
    exact: true,
  });
  const attachments = page
    .getByRole('region', { name: 'Image attachments', exact: true })
    .first();
  const releases: (() => void)[] = [];
  let uploads = 0;
  const gates = [0, 1].map(
    () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
  );
  await page.route('**/api/images', async (route) => {
    if (route.request().method() === 'POST') {
      const gate = gates[uploads++];
      await gate;
    }
    await route.fallback();
  });
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
  try {
    await attachments.getByLabel('Add images').setInputFiles(files);
    await expect.poll(() => uploads).toBe(1);
    await expect(
      attachments.getByText('Uploading images…', { exact: true }),
    ).toBeVisible();
    await expect(addCase).toBeDisabled();
    await expect(
      page.getByRole('textbox', { name: 'Case ID', exact: true }),
    ).toHaveCount(0);
    releases[0]();
    await expect.poll(() => uploads).toBe(2);
    await expect(attachments.getByAltText('Input image 1')).toBeVisible();
    await expect(addCase).toBeDisabled();
    releases[1]();
    await expect(
      attachments.getByText('Uploading images…', { exact: true }),
    ).toHaveCount(0);
    await expect(attachments.getByAltText('Input image 2')).toBeVisible();
    await expect(addCase).toBeEnabled();
    await attachments.getByLabel('Move image 2 left').click();
    await addCase.click();
    await expect(
      page.getByRole('textbox', { name: 'Case ID', exact: true }),
    ).toHaveCount(1);
    await attachments.getByLabel('Add images').setInputFiles({
      name: 'invalid.png',
      mimeType: 'image/png',
      buffer: Buffer.from('invalid image bytes'),
    });
    await expect(attachments.getByRole('alert')).toBeVisible();
    await expect(addCase).toBeDisabled();
    await expect(
      page.getByRole('textbox', { name: 'Case ID', exact: true }),
    ).toHaveCount(1);
    await attachments
      .getByRole('button', { name: 'Dismiss upload error', exact: true })
      .click();
    await expect(addCase).toBeEnabled();
    await page
      .getByRole('button', { name: 'Save flow suite', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: 'Run flow suite sequentially',
        exact: true,
      }),
    ).toBeEnabled();
    const suiteId = mock.store
      .listFlowDocuments()
      .find((document) => document.kind === 'flow-suite')!.id;
    const suite = mock.store.getFlowDocument(suiteId);
    if (suite.kind !== 'flow-suite') throw new Error('Expected flow Suite.');
    const imageIds = mock.bodies
      .filter(
        (item) =>
          item.path === '/api/images' &&
          typeof (item.body as { id?: unknown }).id === 'string',
      )
      .map((item) => (item.body as { id: string }).id);
    expect(suite.cases[0].imageIds).toEqual([...imageIds].reverse());
    expect(suite.cases[0].imageIds).toHaveLength(2);
    expect(mock.store.getImage(suite.cases[0].imageIds![0]).width).toBe(3);
    await page
      .getByRole('button', { name: 'Run flow suite sequentially', exact: true })
      .click();
    await expect(page.locator('.flow-execution-select')).toContainText(
      'completed',
    );
    const execution = mock.store.listFlowExecutions()[0];
    expect(execution.input.imageIds).toEqual(suite.cases[0].imageIds);
    expect(
      execution.steps.every(
        (step) =>
          JSON.stringify(step.query.imageIds) ===
          JSON.stringify(suite.cases[0].imageIds),
      ),
    ).toBe(true);
    expect(mock.localCalls()).toBe(2);
    expect(mock.calls()).toBe(0);
  } finally {
    releases.forEach((release) => release());
    mock.store.close();
  }
});

test('gives independent local cases unique evidence identities and retains identities for deliberate variants', async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  await page
    .getByRole('button', { name: 'Load example flow', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save flow', exact: true }).click();
  const saved = [];
  for (const partition of ['tuning', 'evaluation'] as const) {
    await page
      .getByRole('button', { name: 'Create suite for this flow', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'Suite name', exact: true })
      .fill(`Independent ${partition}`);
    await page
      .getByRole('textbox', { name: 'Original input', exact: true })
      .fill(`Unrelated original input for ${partition}`);
    await page
      .getByRole('button', { name: 'Add case from current input', exact: true })
      .click();
    await expect(
      page.getByRole('textbox', { name: 'Case ID', exact: true }),
    ).toHaveValue('case_1');
    await page
      .getByRole('combobox', { name: 'Partition', exact: true })
      .selectOption(partition);
    await page
      .getByRole('button', { name: 'Save flow suite', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: 'Run flow suite sequentially',
        exact: true,
      }),
    ).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    const info = mock.store
      .listFlowDocuments()
      .find(
        (document) =>
          document.kind === 'flow-suite' &&
          document.name === `Independent ${partition}`,
      )!;
    const document = mock.store.getFlowDocument(info.id);
    if (document.kind !== 'flow-suite') throw new Error('Expected flow Suite.');
    saved.push(document);
  }
  const first = saved[0].cases[0].provenance,
    second = saved[1].cases[0].provenance;
  expect(first.evidenceGroup).not.toBe(second.evidenceGroup);
  expect(first.sourceCaseId).not.toBe(second.sourceCaseId);
  await page
    .getByRole('button', {
      name: 'Edit new version with expectations',
      exact: true,
    })
    .click();
  await page
    .getByRole('textbox', { name: 'State (text)', exact: true })
    .fill('Deliberate paraphrase of the evaluation input');
  await page
    .getByRole('button', { name: 'Save flow suite', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Run flow suite sequentially',
      exact: true,
    }),
  ).toBeEnabled();
  const variantInfo = mock.store
    .listFlowDocuments()
    .find(
      (document) => document.kind === 'flow-suite' && document.version === 2,
    )!;
  const variant = mock.store.getFlowDocument(variantInfo.id);
  if (variant.kind !== 'flow-suite') throw new Error('Expected flow Suite.');
  expect(variant.cases[0].provenance).toEqual(second);
  const service = new FlowService(mock.store);
  expect(() =>
    service.save(
      {
        ...variant,
        version: 3,
        cases: [{ ...variant.cases[0], partition: 'tuning' }],
      },
      mock.store.actor(),
    ),
  ).toThrow('evidence group');
  mock.store.close();
});
