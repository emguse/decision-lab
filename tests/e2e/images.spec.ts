import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { mockApi } from './mock';
const model = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';
async function image(width = 2) {
  return {
    name: `image-${width}.png`,
    mimeType: 'image/png',
    buffer: await sharp({
      create: { width, height: 2, channels: 3, background: '#f00' },
    })
      .png()
      .toBuffer(),
  };
}
test('selects, reorders, saves, restores and labels images without leaking predictions', async ({
  page,
}) => {
  const api = await mockApi(page, {
    local: true,
    vision: true,
    localModel: model,
  });
  await page.goto('/');
  await page
    .getByLabel('Connection', { exact: true })
    .selectOption('strands-local');
  await page
    .getByLabel('Add images')
    .setInputFiles([await image(), await image(3)]);
  await expect(page.getByAltText('Input image 2')).toBeVisible();
  await page.getByLabel('Move image 2 left').click();
  await page
    .getByRole('button', { name: 'Save experiment', exact: true })
    .click();
  await expect(
    page.getByText('Experiment saved.', { exact: true }),
  ).toBeVisible();
  const saved = api.store.listExperiments()[0];
  expect(saved.query.imageIds).toHaveLength(2);
  await page.getByLabel('Remove image 1').click();
  await expect(page.getByAltText('Input image 2')).toHaveCount(0);
  await page
    .locator('.history')
    .filter({ hasText: saved.title })
    .first()
    .click();
  await expect(page.getByAltText('Input image 2')).toBeVisible();
  await page.getByRole('button', { name: 'Run decision ↗' }).click();
  await expect(
    page.getByRole('heading', { name: 'Input and human reference labels' }),
  ).toBeVisible();
  await expect(page.getByAltText('Input image 2')).toBeVisible();
  const blind = api.bodies.find((b) => b.path === '/api/runs')?.body as {
    run: object;
  };
  expect(blind.run).not.toHaveProperty('response');
  expect(api.localCalls()).toBe(1);
});
test('retains attachments on unsupported connections, and supports drop and paste', async ({
  page,
}) => {
  const api = await mockApi(page, {
    local: true,
    vision: true,
    localModel: model,
  });
  await page.goto('/');
  const bytes = Array.from((await image()).buffer);
  await page
    .getByRole('region', { name: 'Image attachments' })
    .evaluate((el, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], 'drop.png', { type: 'image/png' }),
      );
      el.dispatchEvent(
        new DragEvent('drop', { bubbles: true, dataTransfer: transfer }),
      );
    }, bytes);
  await expect(page.getByAltText('Input image 1')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Run decision ↗' }),
  ).toBeDisabled();
  await page
    .getByRole('region', { name: 'Image attachments' })
    .evaluate((el, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], 'paste.png', { type: 'image/png' }),
      );
      el.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }),
      );
    }, bytes);
  await expect(page.getByAltText('Input image 2')).toBeVisible();
  await page
    .getByLabel('Connection', { exact: true })
    .selectOption('strands-local');
  await expect(
    page.getByRole('button', { name: 'Run decision ↗' }),
  ).toBeEnabled();
  expect(api.calls()).toBe(0);
  await page.getByLabel('Connection', { exact: true }).selectOption('jev');
  await expect(page.getByAltText('Input image 2')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Run decision ↗' }),
  ).toBeDisabled();
});
test('image references round-trip through JSON and block invalid requests', async ({
  page,
}) => {
  await mockApi(page, { local: true, vision: true, localModel: model });
  await page.goto('/');
  await page.getByLabel('Connection').selectOption('strands-local');
  await page.getByLabel('Add images').setInputFiles(await image());
  await expect(page.getByAltText('Input image 1')).toBeVisible();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const original = await page.getByLabel('Request JSON').inputValue();
  expect(JSON.parse(original).imageIds).toHaveLength(1);
  await page
    .getByLabel('Request JSON')
    .fill(JSON.stringify({ ...JSON.parse(original), imageIds: ['invalid'] }));
  await expect(
    page.getByRole('button', { name: 'Save experiment', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Request JSON').fill(original);
  await page.getByRole('button', { name: 'Form', exact: true }).click();
  await expect(page.getByAltText('Input image 1')).toBeVisible();
  await page.screenshot({
    path: '/tmp/strands-image-input.png',
    fullPage: true,
  });
});
test('upload failure blocks saving and executing until dismissed', async ({
  page,
}) => {
  await mockApi(page, { local: true, vision: true, localModel: model });
  await page.goto('/');
  await page.getByLabel('Add images').setInputFiles({
    name: 'corrupt.png',
    mimeType: 'image/png',
    buffer: Buffer.from('bad image'),
  });
  await expect(page.getByRole('alert')).toContainText('readable static');
  await expect(
    page.getByRole('button', { name: 'Save experiment', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Dismiss upload error' }).click();
  await expect(
    page.getByRole('button', { name: 'Save experiment', exact: true }),
  ).toBeEnabled();
});
test('late upload and image retrieval cannot update another profile', async ({
  page,
}) => {
  const api = await mockApi(page, {
    local: true,
    vision: true,
    localModel: model,
  });
  const first = api.store.actor();
  const second = api.store.addUser('Image evaluator B').id;
  let uploaded!: () => void;
  const uploadCompleted = new Promise<void>((resolve) => {
    uploaded = resolve;
  });
  await page.route('**/api/images', async (route) => {
    if (route.request().method() === 'POST') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fallback();
      uploaded();
    } else await route.fallback();
  });
  await page.goto('/');
  await page.getByLabel('Add images').setInputFiles(await image());
  await expect(page.getByRole('status')).toContainText('Uploading');
  await page.getByLabel('Local user').selectOption(second);
  await uploadCompleted;
  await expect(page.getByAltText('Input image 1')).toHaveCount(0);
  await expect
    .poll(() => api.bodies.find((b) => b.path === '/api/images')?.user)
    .toBe(first);
  await page.getByLabel('Add images').setInputFiles(await image(3));
  await expect(page.getByAltText('Input image 1')).toBeVisible();
  let retrieved!: () => void;
  const retrievalCompleted = new Promise<void>((resolve) => {
    retrieved = resolve;
  });
  await page.route('**/api/images/*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fallback();
    retrieved();
  });
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const original = await page.getByLabel('Request JSON').inputValue();
  await page
    .getByLabel('Request JSON')
    .fill(JSON.stringify({ ...JSON.parse(original), imageIds: [] }));
  await page.getByLabel('Request JSON').fill(original);
  await page.getByLabel('Local user').selectOption(first);
  await retrievalCompleted;
  await expect(page.getByAltText('Input image 1')).toHaveCount(0);
});
