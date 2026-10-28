import { test, expect } from '@playwright/test';
import { mockApi } from './mock';

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
