import type { ChatCompletionTool } from 'openai/resources/chat/completions'

export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name:        'clause_classify',
      description: 'Extract and classify all clauses from the contract. Call this first.',
      parameters: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          clauseTypes: {
            type:  'array',
            items: {
              type: 'string',
              enum: [
                'termination', 'liability', 'indemnification', 'ip_ownership',
                'confidentiality', 'payment', 'dispute_resolution',
                'force_majeure', 'governing_law', 'other',
              ],
            },
          },
        },
        required: ['docId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'vector_search',
      description: 'Search for similar clauses from past contracts as precedents. Call AFTER clause_classify, BEFORE risk_score.',
      parameters: {
        type: 'object',
        properties: {
          query:      { type: 'string' },
          topK:       { type: 'number' },
          sectionTag: { type: 'string' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'risk_score',
      description: 'Score clauses for legal and business risk. Call this last.',
      parameters: {
        type: 'object',
        properties: {
          clauses: {
            type:  'array',
            items: {
              type: 'object',
              properties: {
                clauseId:   { type: 'string' },
                sectionId:  { type: 'string' },
                pageNumber: { type: 'number' },
                type:       { type: 'string' },
                rawText:    { type: 'string' },
              },
              required: ['clauseId', 'sectionId', 'pageNumber', 'type', 'rawText'],
            },
          },
          jurisdiction: { type: 'string' },
        },
        required: ['clauses'],
      },
    },
  },
]
