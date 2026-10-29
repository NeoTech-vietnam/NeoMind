/** Deterministic in-process test adapter. It is not a real provider or a security boundary. */
export interface FakeEvent { sequence: number; type: 'started' | 'completed' | 'stopped'; attemptId: string }
export interface FakeAttempt { attemptId: string; sessionId: string; requestId: string; status: 'running' | 'completed' | 'stopped'; result?: unknown }

export class FakeAdapter {
  private readonly sessions = new Set<string>();
  private readonly attempts = new Map<string, FakeAttempt>();
  private readonly requests = new Map<string, { attemptId: string; sessionId: string }>();
  private readonly events: FakeEvent[] = [];

  capabilities() {
    return { kind: 'fake' as const, simulated: true, auth: 'not_applicable' as const,
      delegationEnforcement: 'unsupported' as const, stopConfirmation: 'supported_verified' as const };
  }
  createSession(sessionId: string): string {
    if (this.sessions.has(sessionId)) throw new Error(`Duplicate session ${sessionId}`);
    this.sessions.add(sessionId); return sessionId;
  }
  dispatch(sessionId: string, attemptId: string, requestId: string): FakeAttempt {
    if (!this.sessions.has(sessionId)) throw new Error(`Unknown session ${sessionId}`);
    const prior = this.requests.get(requestId);
    if (prior) {
      if (prior.attemptId !== attemptId || prior.sessionId !== sessionId) throw new Error('Idempotency key reused for a different invocation');
      return structuredClone(this.attempts.get(prior.attemptId)!);
    }
    if (this.attempts.has(attemptId)) throw new Error(`Duplicate attempt ${attemptId}`);
    const attempt: FakeAttempt = { attemptId, sessionId, requestId, status: 'running' };
    this.attempts.set(attemptId, attempt); this.requests.set(requestId, { attemptId, sessionId });
    this.events.push({ sequence: this.events.length + 1, type: 'started', attemptId });
    return structuredClone(attempt);
  }
  complete(attemptId: string, result: unknown): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.status !== 'running') throw new Error('Attempt is not running');
    attempt.status = 'completed'; attempt.result = structuredClone(result);
    this.events.push({ sequence: this.events.length + 1, type: 'completed', attemptId });
  }
  stop(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.status !== 'running') throw new Error('Attempt is not running');
    attempt.status = 'stopped';
    this.events.push({ sequence: this.events.length + 1, type: 'stopped', attemptId });
  }
  status(attemptId: string): FakeAttempt | undefined {
    const value = this.attempts.get(attemptId); return value ? structuredClone(value) : undefined;
  }
  observe(after = 0): FakeEvent[] { return structuredClone(this.events.filter(e => e.sequence > after)); }
}
