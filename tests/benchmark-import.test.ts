import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../server/store.js';
import { FlowService } from '../server/flows.js';
import { validateExpectation } from '../shared/flows.js';
import { describe, expect, it } from 'vitest';
import {
  banking77Bundle,
  openImagesBundle,
  parseCsv,
} from '../shared/benchmark-import.js';

const options = {
  revision: 'immutable-source-commit',
  split: 'test',
  seed: 42,
  limit: 30,
  partition: 'evaluation' as const,
};
describe('reproducible benchmark preparation', () => {
  it('preserves CSV quotes and rejects malformed source rows', () => {
    expect(
      parseCsv('text,category\r\n"a, ""quoted""\nline",intent\r\n'),
    ).toEqual([
      ['text', 'category'],
      ['a, "quoted"\nline', 'intent'],
    ]);
    expect(() => parseCsv('a,b\n"unclosed,b')).toThrow();
    expect(() => parseCsv('a,b\n1')).toThrow('column count');
  });
  it('pins provenance, source split and selection, samples reproducibly, and hashes evidence independent of partition', () => {
    const csv =
      'text,category\n' +
      Array.from(
        { length: 40 },
        (_, i) => `utterance ${i},${i % 2 ? 'refund' : 'card'}`,
      ).join('\n');
    const bundle = banking77Bundle(csv, ['card', 'refund'], options);
    expect(bundle.suite.cases).toHaveLength(30);
    expect(banking77Bundle(csv, ['card', 'refund'], options)).toEqual(bundle);
    expect(bundle.suite.cases[0].provenance.sourceCaseId).toMatch(/^test\//);
    expect(
      bundle.suite.cases[0].provenance.transformVersion.length,
    ).toBeLessThanOrEqual(100);
    const tuning = banking77Bundle(csv, ['card', 'refund'], {
      ...options,
      partition: 'tuning',
    });
    expect(tuning.suite.cases[0].provenance.evidenceGroup).toBe(
      bundle.suite.cases[0].provenance.evidenceGroup,
    );
    expect(
      bundle.suite.cases[0].expected?.judgments?.classify.intent,
    ).toBeDefined();
    expect(() => banking77Bundle(csv, ['missing', 'refund'], options)).toThrow(
      'absent',
    );
  });
  it('requires explicit original image references, verified licenses and positive or negative source labels', () => {
    const manifest = {
      abc: {
        imageIds: ['00000000-0000-4000-8000-000000000001'],
        sourceUrl: 'https://example.org/abc',
        imageLicense: 'CC-BY-2.0',
        licenseVerified: true,
      },
      def: {
        imageIds: ['00000000-0000-4000-8000-000000000002'],
        sourceUrl: 'https://example.org/def',
        imageLicense: 'CC-BY-2.0',
        licenseVerified: true,
      },
    };
    const csv =
      'ImageID,LabelName,Confidence\nabc,/label,1\ndef,/label,0\nmissing,/label,1\nabc,/other,1';
    const bundle = openImagesBundle(
      csv,
      manifest,
      { id: '/label', description: 'a cat' },
      options,
    );
    expect(bundle.suite.cases).toHaveLength(2);
    expect(
      new Set(bundle.suite.cases.map((c) => c.expected?.resultId)),
    ).toEqual(new Set(['present', 'absent']));
    expect(bundle.suite.cases.every((c) => c.imageIds?.length === 1)).toBe(
      true,
    );
    expect(() =>
      openImagesBundle(
        csv,
        { abc: { ...manifest.abc, licenseVerified: false } },
        { id: '/label', description: 'a cat' },
        options,
      ),
    ).toThrow();
    expect(() =>
      openImagesBundle(
        csv + '\nabc,/label,0',
        manifest,
        { id: '/label', description: 'a cat' },
        options,
      ),
    ).toThrow('Duplicate');
    expect(() =>
      openImagesBundle(
        'ImageID,LabelName,Confidence\nmissing,/label,1',
        manifest,
        { id: '/label', description: 'a cat' },
        options,
      ),
    ).toThrow();
  });
});

describe('BANKING77 option-order comparisons', () => {
  const csv =
    'text,category\ncard request,card\nrefund request,refund\ntransfer request,transfer';
  it('preserves category identities across reordered and expanded selections while retaining option and branch order', () => {
    const orders = [
      ['card', 'refund'],
      ['refund', 'card'],
      ['transfer', 'refund', 'card'],
    ];
    const bundles = orders.map((categories, index) =>
      banking77Bundle(csv, categories, { ...options, version: index + 1 }),
    );
    const identities = bundles.map(
      (bundle) =>
        new Map(
          bundle.flow.nodes
            .filter((node) => node.type === 'result')
            .filter((node) => node.id !== 'review')
            .map((node) => [node.description, node.resultId]),
        ),
    );
    for (const category of orders[0]) {
      expect(identities[1].get(category)).toBe(identities[0].get(category));
      expect(identities[2].get(category)).toBe(identities[0].get(category));
    }
    for (const [index, bundle] of bundles.entries()) {
      const question = bundle.definition.questions.intent;
      const decision = bundle.flow.nodes.find((node) => node.id === 'classify');
      if (question.type !== 'choice' || decision?.type !== 'decision')
        throw new Error('Expected intent judgment.');
      expect(Object.keys(question.criteria)).toEqual(orders[index]);
      expect(decision.branches.map((branch) => branch.conditions[0])).toEqual(
        orders[index].map((value) => ({
          type: 'choice',
          question: 'intent',
          value,
        })),
      );
      expect(decision.branches.map((branch) => branch.target)).toEqual(
        orders[index].map((value) => identities[index].get(value)),
      );
      expect(new Set(identities[index].values()).size).toBe(
        orders[index].length,
      );
      for (const item of bundle.suite.cases) {
        const expected = item.expected!;
        const category = expected.judgments!.classify.intent as string;
        const resultId = identities[index].get(category);
        expect(expected.resultId).toBe(resultId);
        expect(expected.path).toEqual(['input', 'classify', resultId]);
        validateExpectation(
          bundle.flow,
          { classify: bundle.definition },
          expected,
        );
      }
    }
  });
  it.each([
    { variantPrediction: 'card', consistent: 1 },
    { variantPrediction: 'refund', consistent: 0 },
  ])(
    'compares semantic outcomes after reordering (variant predicts $variantPrediction)',
    async ({ variantPrediction, consistent }) => {
      const store = new Store(':memory:'),
        service = new FlowService(store),
        actor = store.actor();
      const directory = mkdtempSync(join(tmpdir(), 'banking77-order-'));
      const metadata = {
        formatVersion: 1 as const,
        provider: 'jev' as const,
        requestedModel: 'jev-test',
        artifactRevision: null,
      };
      try {
        const files: string[] = [];
        for (const version of [1, 2]) {
          const bundle = banking77Bundle(
            csv,
            version === 1 ? ['card', 'refund'] : ['refund', 'card'],
            { ...options, version },
          );
          const item = bundle.suite.cases.find(
            (item) => item.expected?.judgments?.classify.intent === 'card',
          )!;
          item.provenance.variantGroup = 'card-request';
          item.provenance.variant = version === 1 ? 'original' : 'option-order';
          bundle.suite.cases = [item];
          store.saveDocuments([bundle.definition], actor);
          const flowId = service.save(bundle.flow, actor).id;
          const suiteId = service.save(bundle.suite, actor).id;
          const execution = service.create(
            flowId,
            { state: item.state },
            'jev',
            'jev-test',
            actor,
            { fingerprint: 'same-connection', metadata },
            suiteId,
            item.id,
          );
          const prediction = version === 1 ? 'card' : variantPrediction;
          await service.run(execution.id, async (query) => {
            const question = query.questions.intent;
            if (question.type !== 'choice') throw new Error('Expected Choice.');
            return {
              metadata,
              elapsedMs: 1,
              response: {
                model: query.model,
                answers: {
                  intent: {
                    type: 'choice' as const,
                    choice: prediction,
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      Object.keys(question.criteria).map((option) => [
                        option,
                        Number(option === prediction),
                      ]),
                    ),
                  },
                },
                usage: {},
              },
            };
          });
          expect(store.getFlowExecution(execution.id).status).toBe('completed');
          store.revealFlow(execution.id, actor);
          const file = join(directory, `results-${version}.json`);
          writeFileSync(
            file,
            JSON.stringify(
              service.results(suiteId, [execution.id], actor, 'expected'),
            ),
          );
          files.push(file);
        }
        const output = join(directory, 'comparison.json');
        const command = spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            resolve('scripts/compare-flows.ts'),
            '--output',
            output,
            ...files,
          ],
          { encoding: 'utf8' },
        );
        expect(command.status, command.stderr).toBe(0);
        const comparison = JSON.parse(readFileSync(output, 'utf8'));
        expect(comparison.metrics.stability).toEqual({ groups: 1, consistent });
        expect(
          comparison.cases.map(
            (row: { resultPass: boolean }) => row.resultPass,
          ),
        ).toEqual([true, variantPrediction === 'card']);
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
