export const fixture = {
  model: 'jev-test',
  answers: {
    is_urgent: { type: 'noul', noul: 0.9 },
    department: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.8, technical: 0.1, sales: 0.1 },
      confidence: 0.7,
    },
    frustration: {
      type: 'score',
      score: 1.5,
      probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 },
      legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' },
      confidence: 0.3,
    },
  },
  usage: { input_tokens: 120, output_tokens: 4 },
};
