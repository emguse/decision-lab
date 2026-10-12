import { test, expect } from '@playwright/test';
import { mockApi } from './mock';
import { initialQuery } from '../../shared/schema';
test('dynamic connections preserve editable models and saved fixed-model experiments; execute blind', async ({
  page,
}) => {
  const mock = await mockApi(page, { connections: true, jevConfigured: false });
  await page.goto('/');
  await page.getByLabel('Connection').selectOption('custom');
  await expect(
    page.getByText('Configured · connection not verified'),
  ).toBeVisible();
  await page.getByLabel('Model', { exact: true }).fill('edited-custom');
  await page
    .getByRole('button', { name: 'Save experiment', exact: true })
    .click();
  await expect(page.getByText('Experiment saved.')).toBeVisible();
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(
    'edited-custom',
  );
  await page.getByLabel('Connection').selectOption('clef-local');
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(
    'Clef-Flash-Q4_K_M.gguf',
  );
  await expect(page.getByText(/judges questions jointly/)).toBeVisible();
  await expect(page.getByText(/Connected · clef/)).toBeVisible();
  await page
    .getByRole('button', { name: 'Save experiment', exact: true })
    .click();
  await expect.poll(() => mock.store.listExperiments().length).toBe(2);
  await page.getByLabel('Connection').selectOption('custom');
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(
    'edited-custom',
  );
  await page.locator('aside .history').first().click();
  await expect(page.getByLabel('Connection')).toHaveValue('clef-local');
  await page.reload();
  await expect(page.getByLabel('Connection')).toHaveValue('clef-local');
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(
    'Clef-Flash-Q4_K_M.gguf',
  );
  await page.getByRole('button', { name: 'Run decision' }).click();
  await expect(
    page.getByRole('heading', { name: 'Blind evaluation', exact: true }),
  ).toBeVisible();
  expect(
    JSON.stringify(mock.bodies.find((b) => b.path === '/api/runs')?.body),
  ).not.toContain('probabilities');
  expect(mock.calls()).toBe(0);
  expect(mock.localCalls()).toBe(1);
});
test('removed connection keeps saved input and blocks execution until explicit selection', async ({
  page,
}) => {
  const mock = await mockApi(page);
  mock.store.saveExperiment(
    'Removed connection',
    { ...initialQuery, model: 'old-model', state: '保存された入力' },
    mock.store.actor(),
    'removed',
  );
  await page.goto('/');
  await page.locator('aside .history').first().click();
  await expect(page.getByLabel('Connection')).toHaveValue('removed');
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(
    'old-model',
  );
  await expect(page.getByLabel('Input text', { exact: true })).toHaveValue(
    '保存された入力',
  );
  await expect(
    page.getByRole('button', { name: 'Run decision' }),
  ).toBeDisabled();
  await expect(page.getByText(/This connection was removed/)).toBeVisible();
  expect(mock.calls()).toBe(0);
  await page.getByLabel('Connection').selectOption('jev');
  await expect(
    page.getByRole('button', { name: 'Run decision' }),
  ).toBeEnabled();
});
test('late health response cannot overwrite the newly selected provider', async ({
  page,
}) => {
  await mockApi(page, { connections: true, local: true });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/providers/clef-local/health', async (route) => {
    await pending;
    await route.fulfill({ json: { status: 'ready', model: 'obsolete' } });
  });
  await page.goto('/');
  await page.getByLabel('Connection').selectOption('clef-local');
  await page.getByLabel('Connection').selectOption('strands-local');
  await expect(page.getByText(/Connected · strands-decider/)).toBeVisible();
  release();
  await expect(page.getByText(/obsolete/)).toHaveCount(0);
  await expect(page.getByText(/Connected · strands-decider/)).toBeVisible();
});

test('shows the reported model file separately from its request alias and saves the artifact snapshot', async ({
  page,
}) => {
  const mock = await mockApi(page, {
    connections: true,
    modelPath:
      '/private/hub/models--ggml-org--Clef-Flash-GGUF/snapshots/6b4fe4c59098479652d94f0fe11a40facbebd1ec/Clef-Flash-Q4_K_M.gguf',
  });
  await page.goto('/');
  await page.getByLabel('Connection').selectOption('clef-local');
  await expect(page.getByText('Request model ID / alias: clef')).toBeVisible();
  await expect(
    page.locator('.editor').getByLabel('Model', { exact: true }),
  ).toHaveValue('ggml-org/Clef-Flash-GGUF');
  await expect(
    page.locator('.editor').getByLabel('Model', { exact: true }),
  ).toHaveAttribute('readonly', '');
  await expect(page.locator('#request-model-identity')).toContainText(
    'Clef-Flash-Q4_K_M.gguf',
  );
  await expect(page.locator('#request-model-identity')).toContainText(
    '6b4fe4c59098479652d94f0fe11a40facbebd1ec',
  );
  await expect(
    page.getByText('Model file (reported by server): Clef-Flash-Q4_K_M.gguf'),
  ).toBeVisible();
  await page
    .getByLabel('Blind execution (hide answers until labels are finalized)')
    .uncheck();
  await page.getByRole('button', { name: 'Run decision' }).click();
  await expect(
    page
      .locator('.metrics')
      .getByText('ggml-org/Clef-Flash-GGUF', { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.metrics').getByText('Response model ID / alias: clef'),
  ).toBeVisible();
  const saved = mock.store.getRun(
    mock.store.listSummaries(mock.store.actor())[0].id,
  );
  expect(saved.execution?.modelArtifact).toBe('Clef-Flash-Q4_K_M.gguf');
  expect(saved.execution?.modelIdentity?.name).toBe('ggml-org/Clef-Flash-GGUF');
  expect(saved.response.model).toBe('clef');
  expect(saved.query.model).toBe('clef');
  expect(JSON.stringify(saved.execution)).not.toContain('/private');
  await page.screenshot({
    path: '/tmp/clef-model-artifact.png',
    fullPage: true,
  });
});

test('keeps unknown runtime identity explicit in the request editor and retains the request alias', async ({
  page,
}) => {
  await mockApi(page, { connections: true, modelPath: null });
  await page.goto('/');
  await page.getByLabel('Connection').selectOption('clef-local');
  await expect(page.getByText('Connected · clef')).toBeVisible();
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(
    'Unknown — runtime did not provide identity',
  );
  await expect(page.locator('#request-model-identity')).toContainText(
    'Request model ID / alias: clef',
  );
  await expect(page.locator('#request-model-identity')).toContainText(
    'does not identify the model weights',
  );
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  expect(
    JSON.parse(await page.getByLabel('Request JSON').inputValue()).model,
  ).toBe('clef');
  await page
    .getByLabel('Request JSON')
    .fill(JSON.stringify({ ...initialQuery, model: 'other' }));
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(
    'Unknown — request model differs from runtime',
  );
});
