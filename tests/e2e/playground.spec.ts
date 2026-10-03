import { test, expect } from '@playwright/test';
test('edit, invalid JSON, execute, save and reload', async ({ page }) => {
  let runs: unknown[] = [];
  let experiments: unknown[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      route.request().method() === 'POST'
        ? route.request().postDataJSON()
        : null;
    let response: unknown = [];
    if (path === '/api/config') response = { configured: true };
    if (path === '/api/runs') {
      if (body) {
        const run = {
          ...body,
          id: 'run-1',
          createdAt: new Date().toISOString(),
          elapsedMs: 123,
          response: {
            model: 'jev-test',
            answers: {
              is_urgent: { type: 'noul', noul: 0.95 },
              department: {
                type: 'choice',
                choice: 'billing',
                confidence: 0.8,
                probabilities: { billing: 0.9, technical: 0.05, sales: 0.05 },
              },
              frustration: {
                type: 'score',
                score: 1.5,
                confidence: 0.3,
                probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 },
                legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' },
              },
            },
            usage: { input_tokens: 120, output_tokens: 4 },
          },
        };
        runs = [run];
        response = run;
      } else response = runs;
    }
    if (path === '/api/experiments') {
      if (body) {
        const e = { ...body, id: 'exp-1', createdAt: new Date().toISOString() };
        experiments = [e];
        response = e;
      } else response = experiments;
    }
    await route.fulfill({ json: response });
  });
  await page.goto('/');
  await page
    .getByLabel('入力テキスト', { exact: true })
    .fill('Payments failed');
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(page.getByLabel('送信 JSON')).toContainText('Payments failed');
  const valid = await page.getByLabel('送信 JSON').inputValue();
  await page.getByLabel('送信 JSON').fill('{');
  await expect(page.getByRole('button', { name: '判断を実行' })).toBeDisabled();
  await page.getByLabel('送信 JSON').fill(valid);
  await page.getByRole('button', { name: 'フォーム', exact: true }).click();
  await expect(page.getByLabel('入力テキスト', { exact: true })).toHaveValue(
    'Payments failed',
  );
  await page.getByRole('button', { name: '判断を実行' }).click();
  await expect(page.getByText('P(Yes) 95.0%')).toBeVisible();
  await page.getByRole('button', { name: '実験を保存' }).click();
  await expect(page.getByRole('status')).toHaveText('実験を保存しました。');
  await page.reload();
  await page.locator('aside .history').first().click();
  await expect(page.getByLabel('入力テキスト', { exact: true })).toHaveValue(
    'Payments failed',
  );
});
test('API errors preserve the draft', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: route.request().method() === 'POST' ? 429 : 200,
      json:
        route.request().method() === 'POST'
          ? { error: 'レート制限に達しました。' }
          : route.request().url().endsWith('/config')
            ? { configured: true }
            : [],
    }),
  );
  await page.goto('/');
  await page
    .getByLabel('入力テキスト', { exact: true })
    .fill('Keep this draft');
  await page.getByRole('button', { name: '判断を実行' }).click();
  await expect(page.getByRole('alert')).toHaveText('レート制限に達しました。');
  await expect(page.getByLabel('入力テキスト', { exact: true })).toHaveValue(
    'Keep this draft',
  );
});

test('criteria rows add, remove, validate and round-trip through JSON', async ({
  page,
}) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json: route.request().url().endsWith('/config')
        ? { configured: true }
        : [],
    }),
  );
  await page.goto('/');
  await page.getByLabel('評価基準 department キー 1').fill('finance');
  await page
    .getByLabel('評価基準 department 値 1')
    .fill('Payments and refunds');
  await page
    .getByRole('button', {
      name: '基準を追加 評価基準 department',
      exact: true,
    })
    .click();
  await page.getByLabel('評価基準 department キー 4').fill('other');
  await page
    .getByLabel('評価基準 department 値 4')
    .fill('None of the listed teams');
  await page.getByLabel('評価基準 department キー 4').fill('finance');
  await expect(page.getByRole('button', { name: '判断を実行' })).toBeDisabled();
  await page.getByLabel('評価基準 department キー 4').fill('other');
  await expect(page.getByRole('button', { name: '判断を実行' })).toBeEnabled();
  await page
    .getByRole('button', {
      name: '基準を削除 評価基準 department 2',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', {
      name: '基準を追加 評価基準 frustration',
      exact: true,
    })
    .click();
  await page.getByLabel('評価基準 frustration 値 4').fill('Extremely angry');
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const query = JSON.parse(await page.getByLabel('送信 JSON').inputValue());
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
  await page.getByLabel('送信 JSON').fill(JSON.stringify(query));
  await page.getByRole('button', { name: 'フォーム', exact: true }).click();
  await expect(page.getByText('構造化データ', { exact: true })).toBeVisible();
  await page
    .getByRole('button', {
      name: '基準を追加 評価基準 department',
      exact: true,
    })
    .click();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const roundTrip = JSON.parse(await page.getByLabel('送信 JSON').inputValue());
  expect(roundTrip.questions.department.criteria.finance).toEqual(
    query.questions.department.criteria.finance,
  );
});
