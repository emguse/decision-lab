import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createApp } from '../server/app.js';
import { validateImage } from '../server/images.js';
import { JevProvider } from '../server/provider.js';
import { Store } from '../server/store.js';
// Paid and explicit: sends the image to the Jev API and bills input tokens.
const [path] = process.argv.slice(2);
if (!process.env.TYPESAFE_API_KEY || !path) {
  console.error(
    'Usage: TYPESAFE_API_KEY in .env; npm run test:images:live -- /absolute/path/to/image.png',
  );
  process.exit(1);
}
const model = process.env.JEV_IMAGE_TEST_MODEL || 'jev-latest';
const target = process.env.JEV_IMAGE_TEST_TARGET || 'the main object';
const store = await Store.open(process.env.DATABASE_PATH || 'data/jev.sqlite');
try {
  const actor = store.actor();
  const bytes = readFileSync(path);
  const image = store.saveImage(bytes, await validateImage(bytes), actor);
  const app = createApp(
    store,
    new JevProvider(process.env.TYPESAFE_API_KEY, fetch, 60000, {
      experimentalImages: true,
    }),
    true,
  );
  const res = await app.request('http://127.0.0.1:8787/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-User': actor },
    body: JSON.stringify({
      title: 'Live Jev image smoke test',
      query: {
        model,
        state: 'Experimental image smoke test.',
        imageIds: [image.id],
        questions: {
          present: {
            type: 'noul',
            instructions: `Is ${target} visible in \`images[0]\`?`,
          },
          target: {
            type: 'box',
            instructions: `${target} in \`images[0]\``,
          },
        },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    // Application errors are fixed messages and never include credentials.
    console.error(res.status, data.code, data.error);
    process.exitCode = 1;
  } else
    console.log(
      JSON.stringify({
        id: data.id,
        requestedModel: model,
        model: data.response.model,
        usage: data.response.usage,
        elapsedMs: data.elapsedMs,
        answers: data.response.answers,
      }),
    );
} finally {
  store.close();
}
