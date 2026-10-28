import type { Flow, FlowSuite } from './flows.js';
import { definitionSchema } from './exchange.js';
import { initialQuery } from './schema.js';

export const exampleFlowDefinition = definitionSchema.parse({
  kind: 'decision-definition',
  schemaVersion: 1,
  name: 'support-flow-decisions',
  version: 1,
  questions: {
    ...initialQuery.questions,
    is_urgent: {
      ...initialQuery.questions.is_urgent,
      instructions:
        'Does the original request in `input` convey urgency? Prior judgments, if any, are in `decisions`.',
    },
    department: {
      ...initialQuery.questions.department,
      instructions:
        'Which team should handle the original request in `input`? Use prior judgments in `decisions` as model-derived context, not verified facts.',
    },
    frustration: {
      ...initialQuery.questions.frustration,
      instructions:
        'How frustrated is the customer in the original request in `input`?',
    },
  },
});

export const exampleFlow: Flow = {
  kind: 'decision-flow',
  schemaVersion: 1,
  name: 'Support decision flow',
  version: 1,
  nodes: [
    { id: 'input', type: 'input', title: 'Request and photos', next: 'triage' },
    {
      id: 'triage',
      type: 'decision',
      title: 'Select department',
      definition: {
        name: exampleFlowDefinition.name,
        version: exampleFlowDefinition.version,
      },
      branches: [
        {
          conditions: [
            {
              type: 'confidence',
              question: 'department',
              operator: 'lt',
              value: 0.4,
            },
          ],
          target: 'review',
        },
        {
          conditions: [
            { type: 'choice', question: 'department', value: 'billing' },
          ],
          target: 'priority',
        },
      ],
      defaultTarget: 'review',
    },
    {
      id: 'priority',
      type: 'decision',
      title: 'Check urgency',
      definition: {
        name: exampleFlowDefinition.name,
        version: exampleFlowDefinition.version,
      },
      branches: [
        {
          conditions: [
            {
              type: 'noul',
              question: 'is_urgent',
              operator: 'gte',
              value: 0.8,
            },
          ],
          target: 'urgent',
        },
      ],
      defaultTarget: 'billing',
    },
    {
      id: 'urgent',
      type: 'result',
      title: 'Urgent billing support',
      resultId: 'urgent_billing',
      description: 'Prioritize the billing request.',
    },
    {
      id: 'billing',
      type: 'result',
      title: 'Billing support',
      resultId: 'billing',
      description: 'Send the request to billing support.',
    },
    {
      id: 'review',
      type: 'result',
      title: 'Needs review',
      resultId: 'review',
      description: 'Gather more information before selecting a department.',
    },
  ],
};
export const exampleFlowSuite: FlowSuite = {
  kind: 'flow-suite',
  schemaVersion: 1,
  name: 'Support flow evaluation',
  version: 1,
  flow: { name: exampleFlow.name, version: exampleFlow.version },
  settings: { threshold: 0.5, tolerance: 0.5 },
  cases: [
    {
      id: 'refund',
      state: 'I was charged twice. Please refund the duplicate immediately.',
      partition: 'evaluation',
      provenance: {
        source: 'local-example',
        revision: '1',
        sourceCaseId: 'refund',
        license: 'MIT',
        transformVersion: '1',
        language: 'en',
        domain: 'support-workflow',
        evidenceGroup: 'refund',
        labelOrigin: 'synthetic',
      },
      expected: {
        resultId: 'urgent_billing',
        path: ['input', 'triage', 'priority', 'urgent'],
        judgments: {
          triage: { department: 'billing' },
          priority: { is_urgent: true },
        },
      },
    },
    {
      id: 'refund_ja',
      state: '二重に請求されました。至急、重複分を返金してください。',
      partition: 'evaluation',
      provenance: {
        source: 'local-example',
        revision: '1',
        sourceCaseId: 'refund_ja',
        license: 'MIT',
        transformVersion: '1',
        language: 'ja',
        domain: 'support-workflow',
        evidenceGroup: 'refund',
        labelOrigin: 'synthetic',
      },
      expected: { resultId: 'urgent_billing' },
    },
  ],
};
