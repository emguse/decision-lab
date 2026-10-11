import { test, expect } from '@playwright/test';
import { mockApi } from './mock';
test('blind labeling stays answer-free until finalization and regrading never executes', async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Run decision' }).click();
  await expect(
    page.getByRole('heading', { name: 'Blind evaluation', exact: true }),
  ).toBeVisible();
  expect(
    mock.bodies.find((v) => v.path === '/api/runs')!.body,
  ).not.toHaveProperty('response');
  expect(
    JSON.stringify(mock.bodies.filter((v) => v.path !== '/api/local-users')),
  ).not.toContain('probabilities');
  await expect(
    page.getByRole('button', { name: 'Finalize labels and reveal answers' }),
  ).toBeDisabled();
  await page.getByLabel('is_urgent Yes').check();
  await page.getByLabel('Reference department').selectOption('billing');
  await page.getByLabel('Reference frustration').selectOption('1');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await page.reload();
  await page.locator('aside .history').first().click();
  await expect(page.getByLabel('is_urgent Yes')).toBeChecked();
  await expect(page.getByText('P(Yes) 95.0%')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Finalize labels and reveal answers' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Evaluation results', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Noul threshold').fill('0.99');
  await expect(
    page.getByText('Some questions do not meet the grading criteria.'),
  ).toBeVisible();
  expect(mock.calls()).toBe(1);
  await page
    .getByRole('button', { name: 'Finalize new label revision' })
    .click();
  await expect(page.getByLabel('Label revision').locator('option')).toHaveCount(
    2,
  );
});
test('profiles isolate dirty drafts and exposure; comparison waits for both evaluators', async ({
  page,
}) => {
  const mock = await mockApi(page);
  const first = mock.store.actor(),
    second = mock.store.addUser('Evaluator B').id;
  await page.goto('/');
  await page.getByRole('button', { name: 'Run decision' }).click();
  await page.getByText('Evaluator assignments', { exact: true }).click();
  await page.getByLabel('Add evaluator').selectOption(second);
  await page.getByLabel('is_urgent Yes').check();
  await page.getByLabel('Reference department').selectOption('billing');
  await page.getByLabel('Reference frustration').selectOption('1');
  await page.getByLabel('Local user').selectOption(second);
  await page.locator('aside .history').first().click();
  await expect(page.getByLabel('is_urgent Yes')).not.toBeChecked();
  await expect(page.getByText('P(Yes) 95.0%')).toHaveCount(0);
  await page.getByLabel('is_urgent No').check();
  await page.getByLabel('Reference department').selectOption('billing');
  await page.getByLabel('Reference frustration').selectOption('1');
  await page
    .getByRole('button', { name: 'Finalize labels and reveal answers' })
    .click();
  await page.getByRole('button', { name: 'Compare finalized labels' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Wait for all assigned evaluators',
  );
  await page.getByLabel('Local user').selectOption(first);
  await page.locator('aside .history').first().click();
  await expect(page.getByLabel('is_urgent Yes')).toBeChecked();
  await expect(page.getByText('P(Yes) 95.0%')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Finalize labels and reveal answers' })
    .click();
  await page.getByRole('button', { name: 'Compare finalized labels' }).click();
  await expect(
    page.getByRole('cell', { name: 'is_urgent · Disagreement', exact: true }),
  ).toBeVisible();
  expect(mock.calls()).toBe(1);
});
test('profile switch during execution pins attribution and clears the old result', async ({
  page,
}) => {
  const mock = await mockApi(page, { delay: 600 });
  const first = mock.store.actor(),
    second = mock.store.addUser('Evaluator B').id;
  await page.goto('/');
  await page
    .getByLabel('Blind execution (hide answers until labels are finalized)')
    .uncheck();
  await page.getByRole('button', { name: 'Run decision' }).click();
  await page.getByLabel('Local user').selectOption(second);
  await page.waitForTimeout(850);
  await expect(page.getByText('P(Yes) 95.0%')).toHaveCount(0);
  expect(mock.store.listSummaries(first)[0].executedByUserId).toBe(first);
  expect(mock.store.listRuns(second)).toHaveLength(0);
});
