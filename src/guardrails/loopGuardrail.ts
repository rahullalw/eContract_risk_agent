import { createHash } from 'crypto'
import type { AgentState } from '../types/index.js'

export class LoopGuardrailError extends Error {
  constructor(reason: string) {
    super(`[LoopGuardrail] ${reason}`)
    this.name = 'LoopGuardrailError'
  }
}

export function checkLoopGuardrail(
  state:    AgentState,
  toolName: string,
  argsJson: string,
): void {
  const maxIter = Number(process.env.AGENT_MAX_ITERATIONS ?? 8)
  if (state.iterationCount >= maxIter) {
    throw new LoopGuardrailError(`Max iterations (${maxIter}) reached`)
  }

  const budget = Number(process.env.AGENT_TOKEN_BUDGET ?? 128000)
  if (state.tokenUsed >= budget) {
    throw new LoopGuardrailError(`Token budget (${budget}) exhausted at ${state.tokenUsed} tokens`)
  }

  const stepHash = createHash('sha256')
    .update(`${toolName}:${argsJson}`)
    .digest('hex')
    .slice(0, 16)

  if (state.stepHashes.has(stepHash)) {
    throw new LoopGuardrailError(`Circular tool call detected: ${toolName} called with identical arguments`)
  }
  state.stepHashes.add(stepHash)
}
