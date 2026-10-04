import { test, expect } from '@playwright/test';
import { mockApi } from './mock';
test('blind labeling stays answer-free until finalization and regrading never executes', async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '判断を実行' }).click();
  await expect(
    page.getByRole('heading', { name: 'ブラインド評価', exact: true }),
  ).toBeVisible();
  expect(
    mock.bodies.find((v) => v.path === '/api/runs')!.body,
  ).not.toHaveProperty('response');
  expect(
    JSON.stringify(mock.bodies.filter((v) => v.path !== '/api/local-users')),
  ).not.toContain('probabilities');
  await expect(
    page.getByRole('button', { name: 'ラベルを確定して回答を公開' }),
  ).toBeDisabled();
  await page.getByLabel('is_urgent Yes').check();
  await page.getByLabel('正解 department').selectOption('billing');
  await page.getByLabel('正解 frustration').selectOption('1');
  await page.getByRole('button', { name: '下書きを保存' }).click();
  await page.reload();
  await page.locator('aside .history').first().click();
  await expect(page.getByLabel('is_urgent Yes')).toBeChecked();
  await expect(page.getByText('P(Yes) 95.0%')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'ラベルを確定して回答を公開' })
    .click();
  await expect(
    page.getByRole('heading', { name: '評価結果', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Noul 閾値').fill('0.99');
  await expect(
    page.getByText('判定基準を満たさない質問があります。'),
  ).toBeVisible();
  expect(mock.calls()).toBe(1);
  await page.getByRole('button', { name: '新しいラベル版を確定' }).click();
  await expect(page.getByLabel('ラベル版').locator('option')).toHaveCount(2);
});
test('profiles isolate dirty drafts and exposure; comparison waits for both evaluators', async ({
  page,
}) => {
  const mock = await mockApi(page);
  const first = mock.store.actor(),
    second = mock.store.addUser('評価者B').id;
  await page.goto('/');
  await page.getByRole('button', { name: '判断を実行' }).click();
  await page.getByText('評価者の割り当て', { exact: true }).click();
  await page.getByLabel('評価者を追加').selectOption(second);
  await page.getByLabel('is_urgent Yes').check();
  await page.getByLabel('正解 department').selectOption('billing');
  await page.getByLabel('正解 frustration').selectOption('1');
  await page.getByLabel('ローカル利用者').selectOption(second);
  await page.locator('aside .history').first().click();
  await expect(page.getByLabel('is_urgent Yes')).not.toBeChecked();
  await expect(page.getByText('P(Yes) 95.0%')).toHaveCount(0);
  await page.getByLabel('is_urgent No').check();
  await page.getByLabel('正解 department').selectOption('billing');
  await page.getByLabel('正解 frustration').selectOption('1');
  await page
    .getByRole('button', { name: 'ラベルを確定して回答を公開' })
    .click();
  await page.getByRole('button', { name: '確定ラベルを比較' }).click();
  await expect(page.getByRole('alert')).toContainText('確定をお待ち');
  await page.getByLabel('ローカル利用者').selectOption(first);
  await page.locator('aside .history').first().click();
  await expect(page.getByLabel('is_urgent Yes')).toBeChecked();
  await expect(page.getByText('P(Yes) 95.0%')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'ラベルを確定して回答を公開' })
    .click();
  await page.getByRole('button', { name: '確定ラベルを比較' }).click();
  await expect(
    page.getByRole('cell', { name: 'is_urgent · 不一致', exact: true }),
  ).toBeVisible();
  expect(mock.calls()).toBe(1);
});
test('profile switch during execution pins attribution and clears the old result', async ({
  page,
}) => {
  const mock = await mockApi(page, { delay: 600 });
  const first = mock.store.actor(),
    second = mock.store.addUser('評価者B').id;
  await page.goto('/');
  await page.getByLabel('ブラインド実行（ラベル確定まで回答を隠す）').uncheck();
  await page.getByRole('button', { name: '判断を実行' }).click();
  await page.getByLabel('ローカル利用者').selectOption(second);
  await page.waitForTimeout(850);
  await expect(page.getByText('P(Yes) 95.0%')).toHaveCount(0);
  expect(mock.store.listSummaries(first)[0].executedByUserId).toBe(first);
  expect(mock.store.listRuns(second)).toHaveLength(0);
});
