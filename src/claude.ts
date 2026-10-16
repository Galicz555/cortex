import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DATA } from "./config.ts";
import { logLine } from "./shared.ts";

export type Model = "sonnet" | "opus";

const ModelUsage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
  costUSD: z.number().optional(),
});

const Envelope = z.object({
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown(),
  modelUsage: z.record(z.string(), ModelUsage).optional(),
});

/** One line of `data/usage.jsonl`: what a model call cost, so the subscription use is visible. */
export interface UsageRecord {
  at: string;
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * One headless Claude Code call on the subscription, answering in JSON that matches `schema`.
 *
 * The prompt carries text scraped from the web, so the model is given nothing to act with:
 * no tools, no MCP servers, and safe mode turns off hooks, plugins, skills and CLAUDE.md
 * discovery. The worst an injected instruction can do is distort the answer, which the
 * schema and the callers' checks then bound. The caller writes every file itself.
 */
export const askClaude = async <T>(request: {
  /** What the call is for (e.g. "triage"), recorded with its token use. */
  purpose: string;
  model: Model;
  prompt: string;
  schema: z.ZodType<T>;
  timeoutMs: number;
}): Promise<T> => {
  const cwd = path.join(DATA, "claude-cwd");
  await mkdir(cwd, { recursive: true });
  const stdout = await runClaude({
    cwd,
    timeoutMs: request.timeoutMs,
    input: request.prompt,
    args: [
      "-p",
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model",
      request.model,
      "--output-format",
      "json",
      "--json-schema",
      toCliJsonSchema(request.schema),
    ],
  });
  const envelope = Envelope.parse(JSON.parse(stdout));
  await recordUsage(usageRecords(envelope, request.purpose, new Date()));
  if (envelope.is_error) throw new Error(`claude -p failed: ${envelope.result ?? "no detail"}`);
  return request.schema.parse(envelope.structured_output);
};

/** One record per model the call used; a call without usage data records nothing. */
export const usageRecords = (
  envelope: z.infer<typeof Envelope>,
  purpose: string,
  at: Date,
): UsageRecord[] =>
  Object.entries(envelope.modelUsage ?? {}).map(([model, usage]) => ({
    at: at.toISOString(),
    purpose,
    model,
    inputTokens:
      usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
    outputTokens: usage.outputTokens,
    costUsd: usage.costUSD ?? 0,
  }));

// Usage is bookkeeping: failing to record it must not fail the call that already succeeded.
const recordUsage = async (records: UsageRecord[]): Promise<void> => {
  if (records.length === 0) return;
  await appendFile(
    path.join(DATA, "usage.jsonl"),
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  ).catch((error: unknown) => {
    logLine(`usage not recorded: ${String(error)}`);
  });
};

// The CLI's validator does not resolve the draft 2020-12 meta-schema URI zod stamps on.
const toCliJsonSchema = (schema: z.ZodType): string => {
  const jsonSchema: Record<string, unknown> = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return JSON.stringify(jsonSchema);
};

const runClaude = (call: {
  cwd: string;
  args: string[];
  input: string;
  timeoutMs: number;
}): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", call.args, {
      cwd: call.cwd,
      timeout: call.timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else
        reject(
          new Error(
            `claude exited with ${code ?? signal ?? "?"}: ${Buffer.concat(err).toString("utf8").slice(0, 2000)}`,
          ),
        );
    });
    child.stdin.end(call.input);
  });
