import { readFile } from 'node:fs/promises';
import { grade } from '../shared/evaluation.js';
const origin = 'http://127.0.0.1:8787';
const connectionId = process.env.DECISION_TEST_CONNECTION_ID ?? 'strands-local';
async function request(path: string, body?: unknown) {
  const response = await fetch(`${origin}/api/${path}`, {
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
    signal: AbortSignal.timeout(65000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? 'Local image verification failed.');
  return data;
}
try {
  const path = process.argv[2];
  if (!path) throw new Error('Pass a local PNG, JPEG or WebP path.');
  const config = await request('config');
  if (config.providers[connectionId]?.adapter !== 'strands')
    throw new Error('Select a configured Strands connection.');
  const health = await request(`providers/${connectionId}/health`);
  if (health.status !== 'ready' || health.vision !== true)
    throw new Error(
      'Start the configured Python server with --vision before this check.',
    );
  const data = await readFile(path);
  const form = new FormData();
  form.append('file', new File([new Uint8Array(data)], 'smoke-image'));
  const upload = await fetch(`${origin}/api/images`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(65000),
  });
  const image = await upload.json();
  if (!upload.ok) throw new Error(image.error ?? 'Upload failed.');
  const questions = {
    has_input: {
      type: 'noul' as const,
      instructions: 'Is there input to evaluate?',
    },
    input_kind: {
      type: 'choice' as const,
      instructions: 'What kind of input is provided?',
      criteria: {
        image: 'An image is attached',
        text: 'Only text is provided',
      },
    },
    image_count: {
      type: 'score' as const,
      instructions: 'How many images are attached?',
      criteria: ['No images', 'One image'],
    },
  };
  for (const withImage of [true, false]) {
    const labels = {
      has_input: true,
      input_kind: withImage ? 'image' : 'text',
      image_count: withImage ? 1 : 0,
    };
    const query = {
      model: config.providers[connectionId].model,
      state: withImage ? '' : 'A text-only smoke test.',
      questions,
      ...(withImage ? { imageIds: [image.id] } : {}),
    };
    const saved = await request('runs', {
      title: withImage
        ? 'Local image smoke test'
        : 'Local text compatibility test',
      query,
      provider: connectionId,
      blind: true,
    });
    if ('response' in saved.run || 'rawResponse' in saved.run)
      throw new Error('Blind response exposed predictions.');
    const draft = {
      labels,
      note: 'Fixed smoke references; not a general accuracy benchmark.',
      settings: { threshold: 0.5, tolerance: 0.5 },
    };
    const evaluation = await request(`runs/${saved.run.id}/finalize`, draft);
    const reloaded = await request(`runs/${saved.run.id}/evaluation`);
    if (
      JSON.stringify(reloaded.run.query.imageIds ?? []) !==
      JSON.stringify(query.imageIds ?? [])
    )
      throw new Error('Image references did not reload.');
    if (withImage) {
      const response = await fetch(`${origin}/api/images/${image.id}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (
        !response.ok ||
        !Buffer.from(await response.arrayBuffer()).equals(data)
      )
        throw new Error('Image bytes did not reload.');
    }
    console.log(
      JSON.stringify({
        id: saved.run.id,
        vision: health.vision,
        device: health.device,
        execution: evaluation.run.execution,
        elapsedMs: evaluation.run.elapsedMs,
        grading: grade(evaluation.run, draft.labels, draft.settings),
      }),
    );
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Local image check failed.',
  );
  process.exitCode = 1;
}
