import { test, expect } from '@playwright/test';
import { mockApi } from './mock';
import { LOCAL_MODEL } from '../fixture';
test('local without a Jev key preserves provider on saved experiment reload and blind evaluation', async ({
  page,
}) => {
  const mock = await mockApi(page, { local: true, jevConfigured: false });
  await page.goto('/');
  await page.getByLabel('Connection').selectOption('strands-local');
  await expect(page.getByText(/Connected ·/)).toBeVisible();
  await expect(page.getByText('TYPESAFE_API_KEY', { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(
    LOCAL_MODEL,
  );
  await expect(page.getByLabel('Model', { exact: true })).toHaveAttribute(
    'readonly',
    '',
  );
  await page.getByRole('button', { name: 'MIT License', exact: true }).click();
  await expect(page.locator('.help-document')).toContainText('MIT License');
  await page.getByRole('button', { name: 'Back to work' }).click();
  await expect(page.getByLabel('Connection')).toHaveValue('strands-local');
  await page
    .getByRole('button', { name: 'Save experiment', exact: true })
    .click();
  await page.getByLabel('Connection').selectOption('jev');
  await page.locator('aside .history').first().click();
  await expect(page.getByLabel('Connection')).toHaveValue('strands-local');
  await page.reload();
  await expect(page.getByLabel('Connection')).toHaveValue('strands-local');
  await page.getByRole('button', { name: 'Run decision' }).click();
  await expect(
    page.getByRole('heading', { name: 'Blind evaluation', exact: true }),
  ).toBeVisible();
  expect(
    JSON.stringify(mock.bodies.find((v) => v.path === '/api/runs')!.body),
  ).not.toContain('probabilities');
  await page.getByLabel('is_urgent Yes').check();
  await page.getByLabel('Reference department').selectOption('billing');
  await page.getByLabel('Reference frustration').selectOption('1');
  await page
    .getByRole('button', { name: 'Finalize labels and reveal answers' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Evaluation results', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Noul threshold').fill('0.99');
  expect(mock.localCalls()).toBe(1);
  expect(mock.calls()).toBe(0);
  await page
    .getByRole('button', { name: 'Copy input and questions to Playground' })
    .click();
  await expect(page.getByLabel('Connection')).toHaveValue('strands-local');
});
test('overflow errors retain input and never fall back to Jev', async ({
  page,
}) => {
  const mock = await mockApi(page, { local: true, localFailure: true });
  await page.goto('/');
  await page.getByLabel('Connection').selectOption('strands-local');
  await page
    .getByLabel('Input text', { exact: true })
    .fill('返金してください。');
  await page.getByRole('button', { name: 'Run decision' }).click();
  await expect(page.getByRole('alert')).toContainText('Check its length');
  await expect(page.getByLabel('Input text', { exact: true })).toHaveValue(
    '返金してください。',
  );
  expect(mock.calls()).toBe(0);
  expect(mock.store.listSummaries(mock.store.actor())).toHaveLength(0);
});

test('missing local configuration disables execution and invalid JSON survives provider switching', async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.addInitScript(() =>
    localStorage.setItem('decisionProvider', 'strands-local'),
  );
  await page.goto('/');
  await expect(
    page.getByText(
      'This connection was removed. Select a connection to run again.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Run decision' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await page.getByLabel('Request JSON').fill('{');
  await page.getByLabel('Connection').selectOption('jev');
  await expect(page.locator('.alert')).toContainText('Fix the JSON');
  await expect(page.getByLabel('Request JSON')).toHaveValue('{');
  await expect(page.getByLabel('Connection')).toHaveValue('strands-local');
  expect(mock.calls()).toBe(0);
});

for (const source of ['experiment', 'run'] as const) {
  test(`reopening an old local ${source} uses the currently configured model without changing its saved snapshot`, async ({
    page,
  }) => {
    const currentModel = 'test/local-current';
    const mock = await mockApi(page, { local: true, localModel: currentModel });
    const { initialQuery, validateResponse } =
      await import('../../shared/schema');
    const { fixture } = await import('../fixture');
    const oldQuery = {
      ...initialQuery,
      model: LOCAL_MODEL,
      state: '保存された日本語の入力',
    };
    let runId = '';
    if (source === 'experiment')
      mock.store.saveExperiment(
        'Old local experiment',
        oldQuery,
        mock.store.actor(),
        'strands-local',
      );
    else {
      const run = mock.store.saveRun(
        {
          title: 'Old local run',
          query: oldQuery,
          response: validateResponse(
            { ...fixture, model: LOCAL_MODEL.split('/').at(-1) },
            oldQuery,
          ),
          elapsedMs: 1,
          createdAt: '2026-10-04T00:00:00Z',
        },
        mock.store.actor(),
        false,
        {
          formatVersion: 1,
          provider: 'strands-local',
          requestedModel: LOCAL_MODEL,
          resolvedModel: LOCAL_MODEL.split('/').at(-1),
          artifactRevision: null,
        },
      );
      runId = run.id;
    }
    await page.goto('/');
    await page.locator('aside .history').first().click();
    if (source === 'run')
      await page
        .getByRole('button', { name: 'Copy input and questions to Playground' })
        .click();
    await expect(page.getByLabel('Connection')).toHaveValue('strands-local');
    await expect(page.getByLabel('Model', { exact: true })).toHaveValue(
      currentModel,
    );
    await expect(page.getByLabel('Input text', { exact: true })).toHaveValue(
      oldQuery.state,
    );
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    const edited = JSON.parse(
      await page.getByLabel('Request JSON').inputValue(),
    );
    expect(edited).toEqual({ ...oldQuery, model: currentModel });
    await page.getByRole('button', { name: 'Form', exact: true }).click();
    await page.getByRole('button', { name: 'Run decision' }).click();
    await expect(
      page.getByRole('heading', { name: 'Blind evaluation', exact: true }),
    ).toBeVisible();
    expect(mock.localCalls()).toBe(1);
    expect(mock.calls()).toBe(0);
    if (source === 'experiment')
      expect(mock.store.listExperiments()[0].query).toEqual(oldQuery);
    else expect(mock.store.getRun(runId).query).toEqual(oldQuery);
  });
}

test('registered Strands connections use arbitrary IDs and server capabilities throughout editing and evaluation', async ({
  page,
}) => {
  const mock = await mockApi(page, {
    local: true,
    localId: 'python-a',
    jevConfigured: false,
  });
  await page.goto('/');
  await page.getByLabel('Connection').selectOption('python-a');
  await expect(page.getByText(/Connected ·/)).toBeVisible();
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(
    LOCAL_MODEL,
  );
  await expect(page.getByLabel('Model', { exact: true })).toHaveAttribute(
    'readonly',
    '',
  );
  await page
    .getByRole('button', { name: 'Save experiment', exact: true })
    .click();
  await page.getByLabel('Connection').selectOption('jev');
  await page.locator('aside .history').first().click();
  await expect(page.getByLabel('Connection')).toHaveValue('python-a');
  await page.getByRole('button', { name: 'Run decision' }).click();
  await expect(
    page.getByRole('heading', { name: 'Blind evaluation', exact: true }),
  ).toBeVisible();
  const run = mock.store.getRun(
    mock.store.listSummaries(mock.store.actor())[0].id,
  );
  expect(run.execution).toMatchObject({
    formatVersion: 2,
    provider: 'python-a',
    adapter: 'strands',
  });
  expect(mock.localCalls()).toBe(1);
  expect(mock.calls()).toBe(0);
});
