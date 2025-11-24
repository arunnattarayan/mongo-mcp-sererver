// server.ts
import express from "express";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Create the MCP server instance
 */
const server = new McpServer({
  name: "optumyte-demo-server",
  version: "0.1.0",
});

/**
 * Register a simple tool: addition
 * Tools are model-invokable actions with typed input/output.
 */
server.registerTool(
  "add",
  {
    title: "Addition Tool",
    description: "Add two numbers",
    inputSchema: { a: z.number(), b: z.number() },
    outputSchema: { result: z.number() },
  },
  async ({ a, b }) => {
    const output = { result: a + b };
    return {
      // textual output LLMs can consume
      content: [{ type: "text", text: `Sum: ${output.result}` }],
      // structured content for programmatic clients
      structuredContent: output,
    };
  }
);

/**
 * Register a resource (dynamic)
 * ResourceTemplate supports variable URIs, e.g. greeting://{name}
 */
server.registerResource(
  "greeting",
  new ResourceTemplate("greeting://{name}", { list: undefined }),
  {
    title: "Greeting Resource",
    description: "Generate a greeting message",
  },
  async (uri, { name }) => {
    return {
      contents: [
        {
          uri: uri.href,
          text: `Hello, ${name}! This is a greeting from ${server.options.name}`,
        },
      ],
    };
  }
);

/**
 * Wire up Express + Streamable HTTP transport
 * Each incoming HTTP request creates a transport and is passed to the server.
 */
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // clean up when client disconnects
  res.on("close", () => transport.close());

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = parseInt(process.env.PORT || "3000");
app.listen(port, () => {
  console.log(`MCP Server running at http://localhost:${port}/mcp`);
});
