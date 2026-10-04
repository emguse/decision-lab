import type { Page } from '@playwright/test';
import { Store } from '../../server/store';
import { createApp } from '../../server/app';
import { validateResponse, initialQuery } from '../../shared/schema';
import { fixture } from '../fixture';
export async function mockApi(
  page: Page,
  options: { failure?: boolean; delay?: number } = {},
) {
  const store = new Store(':memory:');
  let calls = 0;
  const app = createApp(
    store,
    {
      evaluate: async () => {
        calls++;
        if (options.delay)
          await new Promise((r) => setTimeout(r, options.delay));
        if (options.failure)
          throw new (await import('../../server/provider')).ProviderError(
            429,
            'rate',
            'レート制限に達しました。',
          );
        return validateResponse(
          {
            ...fixture,
            answers: {
              ...fixture.answers,
              is_urgent: { type: 'noul', noul: 0.95 },
            },
          },
          initialQuery,
        );
      },
    },
    true,
  );
  const bodies: { path: string; body: unknown; user: string | undefined }[] =
    [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reqBody = request.postData() ?? undefined;
    const response = await app.request(request.url(), {
      method: request.method(),
      headers: request.headers(),
      body: reqBody,
    });
    const body = await response.json();
    bodies.push({ path, body, user: request.headers()['x-local-user'] });
    await route.fulfill({ status: response.status, json: body });
  });
  return { store, bodies, calls: () => calls };
}
