import { definitionSchema, suiteSchema } from './exchange.js';
export const exampleDefinition = definitionSchema.parse({
  kind: 'decision-definition',
  schemaVersion: 1,
  name: 'knowledge-router',
  version: 1,
  questions: {
    route: {
      type: 'choice',
      instructions: 'Which skill should handle the request in `query`?',
      criteria: {
        'sql-analysis':
          'Analyze database schemas, tables, relationships, and SQL.',
        'document-search': 'Find information in manuals or other documents.',
        'direct-answer':
          'Answer directly when database or document access is unnecessary.',
      },
    },
  },
});
export const exampleSuite = suiteSchema.parse({
  kind: 'experiment-suite',
  schemaVersion: 1,
  name: 'routing-evaluation',
  version: 1,
  definition: {
    name: exampleDefinition.name,
    version: exampleDefinition.version,
  },
  cases: [
    {
      id: 'q001',
      state: {
        query: 'テーブル間の関係を調べたい',
        context: '製造業の業務システム',
      },
      expected: { route: 'sql-analysis' },
    },
    {
      id: 'q002',
      state: { query: '装置の保守手順を探したい' },
      expected: { route: 'document-search' },
    },
  ],
});
