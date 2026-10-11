import { mockApi } from './mock';
import { test, expect } from '@playwright/test';
test('edit, invalid JSON, execute, save and reload', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByLabel('Input text', { exact: true }).fill('Payments failed');
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(page.getByLabel('Request JSON')).toContainText(
    'Payments failed',
  );
  const valid = await page.getByLabel('Request JSON').inputValue();
  await page.getByLabel('Request JSON').fill('{');
  await expect(
    page.getByRole('button', { name: 'Run decision' }),
  ).toBeDisabled();
  await page.getByLabel('Request JSON').fill(valid);
  await page.getByRole('button', { name: 'Form', exact: true }).click();
  await expect(page.getByLabel('Input text', { exact: true })).toHaveValue(
    'Payments failed',
  );
  await page
    .getByLabel('Blind execution (hide answers until labels are finalized)')
    .uncheck();
  await page.getByRole('button', { name: 'Run decision' }).click();
  await expect(page.getByText('P(Yes) 95.0%')).toBeVisible();
  await page.getByRole('button', { name: 'Save experiment' }).click();
  await expect(page.getByRole('status')).toHaveText('Experiment saved.');
  await page.reload();
  await page.locator('aside .history').first().click();
  await expect(page.getByLabel('Input text', { exact: true })).toHaveValue(
    'Payments failed',
  );
});
test('API errors preserve the draft', async ({ page }) => {
  await mockApi(page, { failure: true });
  await page.goto('/');
  await page.getByLabel('Input text', { exact: true }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Run decision' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Rate limit reached. Wait before trying again.',
  );
  await expect(page.getByLabel('Input text', { exact: true })).toHaveValue(
    'Keep this draft',
  );
});

test('criteria rows add, remove, validate and round-trip through JSON', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByLabel('Criteria department key 1').fill('finance');
  await page
    .getByLabel('Criteria department value 1')
    .fill('Payments and refunds');
  await page
    .getByRole('button', {
      name: 'Add criterion Criteria department',
      exact: true,
    })
    .click();
  await page.getByLabel('Criteria department key 4').fill('other');
  await page
    .getByLabel('Criteria department value 4')
    .fill('None of the listed teams');
  await page.getByLabel('Criteria department key 4').fill('finance');
  await expect(
    page.getByRole('button', { name: 'Run decision' }),
  ).toBeDisabled();
  await page.getByLabel('Criteria department key 4').fill('other');
  await expect(
    page.getByRole('button', { name: 'Run decision' }),
  ).toBeEnabled();
  await page
    .getByRole('button', {
      name: 'Remove criterion Criteria department 2',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', {
      name: 'Add criterion Criteria frustration',
      exact: true,
    })
    .click();
  await page.getByLabel('Criteria frustration value 4').fill('Extremely angry');
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const query = JSON.parse(await page.getByLabel('Request JSON').inputValue());
  expect(query.questions.department.criteria).toEqual({
    finance: 'Payments and refunds',
    sales: 'Pricing and upgrades',
    other: 'None of the listed teams',
  });
  expect(query.questions.frustration.criteria).toHaveLength(4);
  query.questions.department.criteria.finance = {
    description: 'Structured rubric',
    examples: ['refund'],
  };
  await page.getByLabel('Request JSON').fill(JSON.stringify(query));
  await page.getByRole('button', { name: 'Form', exact: true }).click();
  await expect(
    page.getByText('Structured data', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: 'Add criterion Criteria department',
      exact: true,
    })
    .click();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const roundTrip = JSON.parse(
    await page.getByLabel('Request JSON').inputValue(),
  );
  expect(roundTrip.questions.department.criteria.finance).toEqual(
    query.questions.department.criteria.finance,
  );
});
