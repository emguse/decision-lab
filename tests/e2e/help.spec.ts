import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { mockApi } from './mock';

test('reads canonical help, follows specification links, downloads examples, and retains the import draft', async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await expect(
    page.getByLabel('Local user').locator('option:checked'),
  ).toContainText('Me');
  expect(
    mock.store.listUsers().find((user) => user.kind === 'local')?.name,
  ).toBe('\u81ea\u5206');
  await page.getByRole('button', { name: 'Suites', exact: true }).click();
  await page.getByLabel('Input text 1').fill('unsaved draft');
  await page.getByRole('button', { name: 'Read the guide' }).click();
  await expect(
    page.getByRole('heading', { name: 'User guide', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.help-document table')).toContainText(
    'Evaluation',
  );
  await page
    .getByRole('link', { name: 'Exchange specification', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Exchange specification v1' }),
  ).toBeVisible();
  const exampleDownload = page.waitForEvent('download');
  await page
    .getByRole('link', { name: 'decision-definition.yaml', exact: true })
    .click();
  expect(
    await readFile((await (await exampleDownload).path())!, 'utf8'),
  ).toEqual(
    await readFile('examples/exchange/decision-definition.yaml', 'utf8'),
  );
  const docDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save Markdown' }).click();
  expect(await readFile((await (await docDownload).path())!, 'utf8')).toEqual(
    await readFile('docs/experiment-exchange.md', 'utf8'),
  );
  await page
    .getByRole('button', { name: 'Connection settings', exact: true })
    .click();
  await expect(page.locator('.help-document pre')).toContainText([
    'adapter = "strands"',
  ]);
  await page.getByRole('button', { name: 'User guide', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: test.info().outputPath('help.png') });
  await page
    .getByRole('button', { name: 'Third-party notices', exact: true })
    .last()
    .click();
  await page.getByRole('link', { name: 'markdown-it', exact: true }).click();
  await expect(page.locator('.help-document')).toContainText(
    'Permission is hereby granted',
  );
  await page.getByRole('button', { name: 'Back to work' }).click();
  await expect(page.getByLabel('Input text 1')).toHaveValue('unsaved draft');
  expect(mock.calls()).toBe(0);
});

test('failed label save keeps evaluation open and explains why help did not open', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Run decision' }).click();
  await page.getByLabel('is_urgent Yes').check();
  await page.route('**/api/runs/*/labels', async (route) => {
    if (route.request().method() === 'PUT')
      await route.fulfill({
        status: 503,
        json: { error: 'Could not save the label draft.' },
      });
    else await route.fallback();
  });
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Could not save the label draft.',
  );
  await expect(
    page.getByRole('heading', { name: 'Blind evaluation', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('is_urgent Yes')).toBeChecked();
  await expect(
    page.getByRole('heading', { name: 'User guide', exact: true }),
  ).toHaveCount(0);
});
