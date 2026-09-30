import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Build the environment for a spawned process, injecting the same PI_* session
 * variables pi's bash tool exposes (see resolveSpawnContext in pi's bash.ts).
 *
 * Starts from a copy of the parent's ambient environment. The pi bin dir PATH
 * prepend from pi's getShellEnv() is intentionally not replicated.
 */
export function buildSessionEnv(ctx: ExtensionContext): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Strip ambient PI_* session vars first: the parent env may carry stale
  // values (e.g. from pi's bash tool), same as pi's resolveSpawnContext.
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) env.PI_SESSION_FILE = sessionFile;
  if (ctx.model) {
    env.PI_PROVIDER = ctx.model.provider;
    env.PI_MODEL = ctx.model.id;
  }
  if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  return env;
}
