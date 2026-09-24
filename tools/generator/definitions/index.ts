import { AGENTS } from "./agents.js";
import { MCP_SERVER } from "./mcp-server.js";
import { PROMPTS } from "./prompts.js";
import type { GeneratorModel } from "./schema.js";

export { AGENTS } from "./agents.js";
export { PROMPTS } from "./prompts.js";
export { MCP_SERVER } from "./mcp-server.js";
export * from "./schema.js";

/**
 * The real generator model (feature document): the single input the CLI
 * (task 6.11, PR C) validates and renders. Kept as one aggregate so a
 * renderer or the CLI never has to remember to import all three pieces
 * separately.
 */
export const MODEL: GeneratorModel = {
  agents: AGENTS,
  prompts: PROMPTS,
  mcpServer: MCP_SERVER,
};
