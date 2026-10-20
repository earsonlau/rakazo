import type { AdapterContext } from "./types.js";

export type CodeExperimentRequest =
  | { action: "list"; offset?: number }
  | { action: "fork"; experiment: string; from?: string }
  | { action: "merge"; experiment: string; left: string; right: string }
  | { action: "read"; ref: string; path: string; startLine?: number; endLine?: number }
  | { action: "write"; experiment: string; path: string; content: string; message?: string }
  | { action: "run"; experiment: string; command: string; message?: string }
  | { action: "checkpoint"; experiment: string; message?: string }
  | { action: "history"; ref: string; offset?: number }
  | { action: "diff"; left: string; right: string; offset?: number }
  | { action: "export"; experiment: string };

/** Experimental project state, separate from a bot's ordinary computer. */
export interface CodeExperimentProvider {
  execute(
    request: CodeExperimentRequest,
    context: AdapterContext,
  ): Promise<Record<string, unknown>>;
}
