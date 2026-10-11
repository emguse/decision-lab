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
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('clef');
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
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('clef');
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
