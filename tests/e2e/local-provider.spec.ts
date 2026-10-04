import { test, expect } from '@playwright/test';
import { mockApi } from './mock';
import { LOCAL_MODEL } from '../../shared/providers';
test('local without a Jev key preserves provider on saved experiment reload and blind evaluation', async ({
  page,
}) => {
  const mock = await mockApi(page, { local: true, jevConfigured: false });
  await page.goto('/');
  await page.getByLabel('接続先').selectOption('strands-local');
  await expect(page.getByText(/接続済み ·/)).toBeVisible();
  await expect(page.getByText('TYPESAFE_API_KEY', { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByLabel('モデル', { exact: true })).toHaveValue(
    LOCAL_MODEL,
  );
  await expect(page.getByLabel('モデル', { exact: true })).toHaveAttribute(
    'readonly',
    '',
  );
  await expect(
    page.getByRole('link', { name: 'MIT License', exact: true }),
  ).toHaveAttribute(
    'href',
    'https://github.com/emguse/decision-lab/blob/main/LICENSE',
  );
  await page.getByRole('button', { name: '実験を保存', exact: true }).click();
  await page.getByLabel('接続先').selectOption('jev');
  await page.locator('aside .history').first().click();
  await expect(page.getByLabel('接続先')).toHaveValue('strands-local');
  await page.reload();
  await expect(page.getByLabel('接続先')).toHaveValue('strands-local');
  await page.getByRole('button', { name: '判断を実行' }).click();
  await expect(
    page.getByRole('heading', { name: 'ブラインド評価', exact: true }),
  ).toBeVisible();
  expect(
    JSON.stringify(mock.bodies.find((v) => v.path === '/api/runs')!.body),
  ).not.toContain('probabilities');
  await page.getByLabel('is_urgent Yes').check();
  await page.getByLabel('正解 department').selectOption('billing');
  await page.getByLabel('正解 frustration').selectOption('1');
  await page
    .getByRole('button', { name: 'ラベルを確定して回答を公開' })
    .click();
  await expect(
    page.getByRole('heading', { name: '評価結果', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Noul 閾値').fill('0.99');
  expect(mock.localCalls()).toBe(1);
  expect(mock.calls()).toBe(0);
  await page
    .getByRole('button', { name: '入力と質問を Playground にコピー' })
    .click();
  await expect(page.getByLabel('接続先')).toHaveValue('strands-local');
});
test('overflow errors retain input and never fall back to Jev', async ({
  page,
}) => {
  const mock = await mockApi(page, { local: true, localFailure: true });
  await page.goto('/');
  await page.getByLabel('接続先').selectOption('strands-local');
  await page
    .getByLabel('入力テキスト', { exact: true })
    .fill('返金してください。');
  await page.getByRole('button', { name: '判断を実行' }).click();
  await expect(page.getByRole('alert')).toContainText('入力の長さ');
  await expect(page.getByLabel('入力テキスト', { exact: true })).toHaveValue(
    '返金してください。',
  );
  expect(mock.calls()).toBe(0);
  expect(mock.store.listSummaries(mock.store.actor())).toHaveLength(0);
});

test('missing local configuration disables execution and invalid JSON survives provider switching', async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByLabel('接続先').selectOption('strands-local');
  await expect(
    page.getByText('LOCAL_DECISION_BASE_URL を設定してください。'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '判断を実行' })).toBeDisabled();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await page.getByLabel('送信 JSON').fill('{');
  await page.getByLabel('接続先').selectOption('jev');
  await expect(page.locator('.alert')).toContainText('JSONを修正');
  await expect(page.getByLabel('送信 JSON')).toHaveValue('{');
  await expect(page.getByLabel('接続先')).toHaveValue('strands-local');
  expect(mock.calls()).toBe(0);
});
