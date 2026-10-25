/** Entry point for the stdio MCP server. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openLibrary } from "../core";
import { buildServer } from "./server";

async function main() {
  const lib = openLibrary();
  const server = buildServer(lib, { cwd: process.cwd() });
  await server.connect(new StdioServerTransport());
  console.error(`[component-library mcp] ready, database ${lib.dbPath}`);
  const close = () => { try { lib.db.close(); } catch {} process.exit(0); };
  process.stdin.on("close", close);
  process.on("SIGTERM", close);
}

main().catch((err) => {
  console.error("[component-library mcp] failed to start:", err);
  process.exit(1);
});
