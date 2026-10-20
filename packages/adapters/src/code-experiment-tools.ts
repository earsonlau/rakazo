import type {
  AdapterContext,
  CodeExperimentProvider,
  CodeExperimentRequest,
  ConnectorTool,
} from "@rakazo/adapter-kit";

export interface CodeExperimentConnection {
  provider: CodeExperimentProvider;
  spaceId: string;
  userId: string;
}

export function codeExperimentsEnabled(
  connection: CodeExperimentConnection | null | undefined,
  scope: Pick<AdapterContext, "spaceId" | "userId">,
): boolean {
  return Boolean(
    connection && connection.spaceId === scope.spaceId && connection.userId === scope.userId,
  );
}

export async function executeCodeExperimentTool(
  connection: CodeExperimentConnection | null | undefined,
  context: AdapterContext,
  args: Record<string, unknown>,
  savePatch: (experiment: string, patch: string) => Promise<{ path: string; bytes: number }>,
): Promise<Record<string, unknown>> {
  if (!codeExperimentsEnabled(connection, context)) {
    throw new Error("Code experiments are unavailable for this owner and space");
  }
  const request = parseCodeExperimentRequest(args);
  const result = await connection!.provider.execute(request, context);
  if (request.action === "export" && !result.error && typeof result.patch === "string") {
    // Save the delivery file, not its raw contents, in the model/effect history.
    return {
      ref: result.ref,
      base: result.base,
      ...(await savePatch(request.experiment, result.patch)),
    };
  }
  return result;
}

const string = { type: "string", minLength: 1, maxLength: 4096 };
const experiment = { type: "string", pattern: "^[a-z][a-z0-9-]{0,39}$" };
const offset = { type: "integer", minimum: 0 };
const message = { type: "string", maxLength: 4096 };
const fields = {
  list: { offset },
  fork: { experiment, from: string },
  merge: { experiment, left: string, right: string },
  read: {
    ref: string,
    path: string,
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
  },
  write: { experiment, path: string, content: { type: "string", maxLength: 100_000 }, message },
  run: { experiment, command: string, message },
  checkpoint: { experiment, message },
  history: { ref: string, offset },
  diff: { left: string, right: string, offset },
  export: { experiment },
};
const required: Record<keyof typeof fields, string[]> = {
  list: [],
  fork: ["experiment"],
  merge: ["experiment", "left", "right"],
  read: ["ref", "path"],
  write: ["experiment", "path", "content"],
  run: ["experiment", "command"],
  checkpoint: ["experiment"],
  history: ["ref"],
  diff: ["left", "right"],
  export: ["experiment"],
};

export const codeExperimentTool: ConnectorTool = {
  name: "code_experiment",
  description:
    "Optional isolated code experiments, NOT the Team Computer shell. list shows project branches; fork creates your own named experiment from main or a returned ref; merge creates a new experiment from two refs. Use read/write/run here for experiment files. Writes and commands checkpoint automatically, even failed tests. Commands have a 120-second limit; no background services. Use history/diff to compare, or fork from a checkpoint to retry. export writes a Git patch to your ordinary computer after you commit the winning code in Git. It never applies, pushes, or publishes. Do not use ordinary shell/write_file for experiment changes. Share returned refs with other bots. These are file checkpoints, not process snapshots or security boundaries. On uncertainty, stop and ask the operator; never retry blindly.",
  inputSchema: {
    oneOf: Object.entries(fields).map(([action, properties]) => ({
      type: "object",
      properties: { action: { type: "string", const: action }, ...properties },
      required: ["action", ...required[action as keyof typeof fields]],
      additionalProperties: false,
    })),
  },
};

/** Enforce the same surface for scripted calls and approval replays, not just model schemas. */
export function parseCodeExperimentRequest(args: Record<string, unknown>): CodeExperimentRequest {
  if (typeof args.action !== "string" || !Object.hasOwn(fields, args.action)) {
    throw new Error("Unknown code experiment action");
  }
  const action = args.action as keyof typeof fields;
  const properties = fields[action] as Record<string, Record<string, unknown>>;
  for (const key of Object.keys(args)) {
    if (key !== "action" && !Object.hasOwn(properties, key)) {
      throw new Error(`Unexpected code experiment field: ${key}`);
    }
  }
  for (const key of required[action]) {
    if (args[key] === undefined) throw new Error(`Missing code experiment field: ${key}`);
  }
  for (const [key, schema] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined) continue;
    if (schema.type === "integer") {
      if (!Number.isSafeInteger(value) || (value as number) < Number(schema.minimum)) {
        throw new Error(`Invalid code experiment field: ${key}`);
      }
    } else if (
      typeof value !== "string" ||
      value.length < Number(schema.minLength ?? 0) ||
      value.length > Number(schema.maxLength ?? 4096) ||
      (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) ||
      [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 && code !== 9 && code !== 10 && code !== 13;
      })
    ) {
      throw new Error(`Invalid code experiment field: ${key}`);
    }
  }
  if (action === "read" || action === "write") {
    const file = args.path as string;
    if (
      !file.startsWith("/") ||
      file.includes("\\") ||
      file.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error("Experiment paths must be absolute inside the project without traversal");
    }
  }
  if (action === "read" && Number(args.endLine) < Number(args.startLine ?? 1)) {
    throw new Error("endLine must not precede startLine");
  }
  return args as CodeExperimentRequest;
}
