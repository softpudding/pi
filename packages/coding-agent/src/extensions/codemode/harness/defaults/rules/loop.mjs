export function decide({ outcome, state, reminders }, options) {
  if (outcome.status === "next" || outcome.status === "finish" || outcome.status === "assistant_finish") return { action: "accept", state: {} };
  const execution = outcome.status === "execution_failed";
  const key = execution ? "executionFailures" : "protocolCorrections";
  const limit = execution ? options.maxExecutionRecoveries : options.maxCorrections;
  const attempts = state[key] ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`Invalid loop recovery budget: ${key}`);
  if (attempts >= limit) return {
    action: "stop", state, reminder: "exhausted",
    text: `${reminders.exhausted.trim()}\nReason: ${outcome.status}; ${key}=${attempts}.`,
  };
  const nextState = { ...state, [key]: attempts + 1 };
  if (!execution) return { action: "continue", state: nextState, reminder: "retry" };
  const errors = outcome.results.filter(result => result.error).map(result => result.error.message);
  const completed = outcome.results.flatMap(result => result.calls).filter(call => call.status === "ok");
  return {
    action: "continue", state: nextState, reminder: "execution",
    text: `${reminders.execution.trim()}\nError: ${errors.join("\n")}\nCompleted operations: ${completed.length ? completed.map(call => call.effect ? `${call.name} [${call.effect.domain}: ${call.effect.path}]` : call.name).join("; ") : "none"}.`,
  };
}
