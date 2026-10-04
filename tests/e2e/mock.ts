import { LocalDecisionProvider } from '../../server/local-provider';
import { LOCAL_MODEL } from '../../shared/providers';
import type { Page } from '@playwright/test';
import { Store } from '../../server/store';
import { createApp } from '../../server/app';
import { validateResponse, initialQuery } from '../../shared/schema';
import { fixture } from '../fixture';
export async function mockApi(
  page: Page,
  options: {
    failure?: boolean;
    delay?: number;
    local?: boolean;
    localModel?: string;
    localFailure?: boolean;
    jevConfigured?: boolean;
  } = {},
) {
  const store = new Store(':memory:');
  let calls = 0;
  let localCalls = 0;
  const localModel = options.localModel ?? LOCAL_MODEL;
  const local = options.local
    ? new LocalDecisionProvider(
        'http://127.0.0.1:8000',
        localModel,
        async (url) => {
          if (String(url).endsWith('/health'))
            return Response.json({
              status: 'ok',
              model: localModel.split('/').at(-1),
              device: 'mps',
              max_length: 4096,
              base_model: 'Qwen/Qwen3.5-2B-Base',
              checkpoint: '/private/checkpoint',
            });
          localCalls++;
          if (options.localFailure)
            return Response.json({ detail: 'overflow' }, { status: 422 });
          return Response.json({
            ...fixture,
            model: localModel.split('/').at(-1),
          });
        },
      )
    : undefined;
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
    options.jevConfigured ?? true,
    local,
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
  return { store, bodies, calls: () => calls, localCalls: () => localCalls };
}
