import type { McpServerDefinition } from "./schema.js";

/**
 * The one MCP server every generated platform launches. Feature document,
 * decision user-approved 2026-09-24 (consistent with the deferred ADR 0007
 * fix): the server runs from source through `tsx`, exactly the way the
 * `connectivity-diagnostic` skill already documents
 * (`src/app/composition-root.ts` launches this same file today).
 *
 * `env` names only the environment variable(s) each platform must pass
 * through with its own interpolation syntax — never a value, so no secret
 * can ever be committed through this definition.
 */
export const MCP_SERVER: McpServerDefinition = {
  name: "helpdesk",
  command: "npx",
  args: ["tsx", "src/app/mcp/main.ts"],
  env: ["HELPDESK_PSEUDONYM_KEY"],
};
