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
