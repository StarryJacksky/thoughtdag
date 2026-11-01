// The name of the agent the embedded harness runs. Imports nothing: the harness
// bridge is loaded by the store, and the agent runtimes load the store.

export const HARNESS_AGENT_MODEL = 'harness/agent';
/** The bare entry or one of its per-model forms ('harness/agent/<provider>/<model>'). */
export const isHarnessAgentModel = (id: string | undefined | null): boolean => !!id && (id === HARNESS_AGENT_MODEL || id.startsWith(HARNESS_AGENT_MODEL + '/'));
