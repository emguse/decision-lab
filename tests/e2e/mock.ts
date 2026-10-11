import { SystemOneProvider } from '../../server/systemone-provider';
import { parseConnections } from '../../server/connections';
import { StrandsProvider } from '../../server/connection-providers';
import { validateConnection } from '../../server/connections';
import { LOCAL_MODEL } from '../fixture';
import type { Page } from '@playwright/test';
import { Store } from '../../server/store';
import { createApp } from '../../server/app';
import { validateResponse, initialQuery } from '../../shared/schema';
import { fixture } from '../fixture';
export async function mockApi(
  page: Page,
  options: {
    connections?: boolean;
    failure?: boolean;
    delay?: number;
    local?: boolean;
    localModel?: string;
    localId?: string;
    localFailure?: boolean;
    jevConfigured?: boolean;
  } = {},
) {
  const store = new Store(':memory:');
  let calls = 0;
  let localCalls = 0;
  const localModel = options.localModel ?? LOCAL_MODEL;
  const local = options.local
    ? new StrandsProvider(
        validateConnection({
          id: options.localId ?? 'strands-local',
          label: 'Local · Strands Decider',
          adapter: 'strands',
          endpoint: 'http://127.0.0.1:8000/v1/systemone',
          model: localModel,
        }),
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
            'Rate limit reached. Wait before trying again.',
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
    [
      ...(local ? [local] : []),
      ...(options.connections
        ? parseConnections(`version = 1
[[connections]]
id = "clef-local"
label = "Clef test"
adapter = "llamacpp"
endpoint = "http://127.0.0.1:8080/v1/systemone"
model = "clef"
question_interaction = "joint"
[[connections]]
id = "custom"
label = "Custom test"
adapter = "systemone"
endpoint = "https://example.com/api"
model = "custom-default"
`).map(
            (c) =>
              new SystemOneProvider(c, undefined, async (url, init) => {
                if (String(url).endsWith('/health'))
                  return Response.json({ status: 'ok' });
                if (String(url).endsWith('/v1/models'))
                  return Response.json({
                    data: [
                      {
                        id: 'clef',
                        architecture: { output_modalities: ['decisions'] },
                      },
                    ],
                  });
                localCalls++;
                return Response.json({
                  ...fixture,
                  model: JSON.parse(String(init?.body)).model,
                });
              }),
          )
        : []),
    ],
  );
  const bodies: { path: string; body: unknown; user: string | undefined }[] =
    [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reqBody = request.postData() ?? undefined;
    // Production API accepts the application ports; this test runs an isolated Vite port.
    const headers: Record<string, string> = {
      ...request.headers(),
      host: '127.0.0.1:5173',
    };
    if (headers.origin === new URL(request.url()).origin)
      headers.origin = 'http://127.0.0.1:5173';
    const response = await app.request(`http://127.0.0.1:5173${path}`, {
      method: request.method(),
      headers,
      body: reqBody,
    });
    const body = await response.json();
    bodies.push({ path, body, user: request.headers()['x-local-user'] });
    await route.fulfill({ status: response.status, json: body });
  });
  return { store, bodies, calls: () => calls, localCalls: () => localCalls };
}
