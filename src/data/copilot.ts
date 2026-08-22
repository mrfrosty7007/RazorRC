/**
 * Copilot port.
 *
 * Phase 1 ships no model provider, and deliberately ships no simulated
 * conversation either: a fake assistant would make the engine's real,
 * explainable output look like the same kind of guesswork. The composer reads
 * this status and tells the user exactly what is missing instead.
 *
 * Phase 2 registers a provider that satisfies `CopilotProvider` and the
 * composer starts working with no changes to the surrounding screen.
 */

export type CopilotAvailability =
  | { status: 'not_configured'; missing: string[] }
  | { status: 'ready'; model: string }
  | { status: 'error'; message: string };

export interface CopilotQuestion {
  prompt: string;
  /** Job ids the question is scoped to, so answers can cite them. */
  jobIds: string[];
}

export interface CopilotAnswer {
  text: string;
  citedJobIds: string[];
}

export interface CopilotProvider {
  availability(): CopilotAvailability;
  ask(question: CopilotQuestion): Promise<CopilotAnswer>;
}

export class CopilotNotConfiguredError extends Error {
  constructor(readonly missing: string[]) {
    super(`Copilot provider is not configured. Missing: ${missing.join(', ')}`);
    this.name = 'CopilotNotConfiguredError';
  }
}

const MISSING_KEYS = ['COPILOT_PROVIDER', 'COPILOT_API_KEY'];

/** Default provider: honest about being absent. */
export const copilot: CopilotProvider = {
  availability: () => ({ status: 'not_configured', missing: MISSING_KEYS }),
  ask: () => Promise.reject(new CopilotNotConfiguredError(MISSING_KEYS)),
};
