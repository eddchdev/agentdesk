#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getDb } from "./db.js";
import { gcOldData, sweepSessions } from "./lifecycle.js";
import { disableNotifier } from "./notifier.js";
import { tools } from "./tools.js";

async function main() {
  // Initialize DB up-front (creates ~/.agentdesk + tables).
  getDb();

  const server = new Server(
    { name: "agentdesk", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Ferramenta desconhecida: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler(req.params.arguments ?? {});
      return result;
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Erro: ${e?.message ?? String(e)}` }],
        isError: true,
      };
    }
  });

  // Background sweep every 30s: marca sessões mortas e libera travas órfãs.
  const sweepInterval = setInterval(() => {
    try {
      sweepSessions(getDb());
    } catch {
      /* ignore */
    }
  }, 30_000);
  sweepInterval.unref?.();

  // GC: limpa events/chat/sessions antigas a cada 1h. Idempotente — vários
  // MCP servers podem rodar GC simultâneo sem conflito (tx.immediate serializa).
  const gcInterval = setInterval(() => {
    try {
      gcOldData(getDb());
    } catch {
      /* ignore */
    }
  }, 60 * 60 * 1000);
  gcInterval.unref?.();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    disableNotifier();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("agentdesk fatal:", err);
  process.exit(1);
});
