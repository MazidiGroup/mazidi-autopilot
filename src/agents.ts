/**
 * Agent adapters — the seam between deterministic control and AI judgment.
 *
 * The heartbeat only ever talks to this interface. An adapter that is not
 * configured reports so, and the heartbeat then simply does not claim that
 * agent's tasks: work queues up visible in autopilot.task rather than burning
 * retry attempts against a missing API key. Degraded mode is "waiting", not
 * "failing".
 */
export interface AgentResult {
  outcome: Record<string, unknown>;
  costGbp: number;
  tokens: number;
}

export interface AgentAdapter {
  readonly agentId: string;
  isConfigured(): boolean;
  execute(taskType: string, payload: Record<string, unknown>): Promise<AgentResult>;
}

/**
 * Env-keyed adapter stub. Real inference calls land here (Anthropic for the
 * Claude agents, OpenAI for the strategist and Codex) once API keys exist —
 * that wiring is a blocker only for keys, not for design: execute() is the
 * single place it happens.
 */
export class EnvKeyedAdapter implements AgentAdapter {
  constructor(readonly agentId: string, private readonly envVar: string) {}

  isConfigured(): boolean {
    return Boolean(process.env[this.envVar]);
  }

  async execute(taskType: string, _payload: Record<string, unknown>): Promise<AgentResult> {
    if (!this.isConfigured()) {
      throw new Error(`${this.agentId}: ${this.envVar} is not set`);
    }
    // Inference wiring is deliberately not stubbed with fake output: a fake
    // "research result" flowing into the CRM would be worse than no result.
    throw new Error(`${this.agentId}: inference wiring pending (task ${taskType})`);
  }
}

export const DEFAULT_ADAPTERS: AgentAdapter[] = [
  new EnvKeyedAdapter("claude-growth", "ANTHROPIC_API_KEY"),
  new EnvKeyedAdapter("gpt-strategist", "OPENAI_API_KEY"),
  new EnvKeyedAdapter("codex-product", "OPENAI_API_KEY"),
  new EnvKeyedAdapter("claude-code-infra", "ANTHROPIC_API_KEY"),
];
