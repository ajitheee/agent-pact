/**
 * An error an agent can act on. Serializes flat, e.g.
 * {"error_code":"bid_over_budget","budget_max":200,"your_bid":350,"fix":"bid <= 200"}
 */
export class AgentError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly fix?: string;

  constructor(code: string, details: Record<string, unknown> = {}, fix?: string) {
    super(code);
    this.code = code;
    this.details = details;
    this.fix = fix;
  }

  toJSON(): { error_code: string; fix?: string; [field: string]: unknown } {
    return { error_code: this.code, ...this.details, ...(this.fix ? { fix: this.fix } : {}) };
  }
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
