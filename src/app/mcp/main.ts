#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildApp } from "../composition-root.js";
import { loadConfig } from "../config/load-config.js";
import { createServer } from "./server.js";

/**
 * Stdio entrypoint (design "Composition root"). `loadConfig(process.env)` ->
 * `buildApp` -> `createServer` -> `StdioServerTransport`. The logger writes
 * to stderr only (`loadConfig`'s dev-key warning, `error-mapper`'s
 * INTERNAL_ERROR detail, and the fatal-startup handler below) - stdout is
 * reserved exclusively for the MCP protocol stream the transport owns.
 *
 * Runs identically whether launched via `tsx src/app/mcp/main.ts` (the
 * `dev` script) or `node dist/src/app/mcp/main.js` (the `start` script,
 * built by `npm run build`/`prepare`): `loadConfig` resolves the package
 * root by walking up to the nearest `package.json` from its own module
 * location, so every path it derives (`dataDir`, `serviceCatalogPath`, and
 * the diagnostic runner's `scriptPath`/`tsxBinPath`, resolved in the
 * composition root) lands in the same place at either depth.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const app = buildApp(config);
  // Ensure the one-time config.warning audit entry (if HELPDESK_PSEUDONYM_KEY
  // is absent) is recorded before the server starts accepting tool calls.
  await app.ready;

  const server = createServer(app);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = (): void => {
    // DiagnosticRunner (the port) has no dispose() - only the concrete
    // ChildProcessDiagnosticRunner adapter does, as a best-effort kill
    // switch for any in-flight probe subprocess. A test double naturally
    // has nothing to dispose, hence the guarded, narrowly-typed call.
    const disposable = app.ports.diagnosticRunner as { dispose?: () => void };
    disposable.dispose?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[helpdesk] fatal error during startup: ${detail}\n`);
  process.exitCode = 1;
});
