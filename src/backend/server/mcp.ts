import { Hono } from "hono"
import { handleMcpMessage } from "../internal/mcp/mcp"
import { getUserFromContext } from "./middlewares"

export const mcpRouter = new Hono()

/**
 * Auth gate — a request counts as authenticated when it carries:
 *   - a valid JWT (Authorization header or ?token=), or
 *   - the static API token (settings.token), or
 *   - an enabled guest account exists (same semantics as the Web UI).
 * `initialize` and `ping` stay open so clients can complete the handshake.
 */
const OPEN_METHODS = new Set(["initialize", "ping"])

async function authGate(c: any, method?: string): Promise<Response | null> {
  if (OPEN_METHODS.has(method || "")) return null
  const user = await getUserFromContext(c)
  if (!user) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "Unauthorized: provide a Bearer token (JWT or static API token). " +
            "Anonymous access is only available when a guest account is enabled.",
        },
        id: null,
      },
      401,
    )
  }
  return null
}

/** Dispatch a JSON-RPC body and return the HTTP response (200 with JSON-RPC). */
async function dispatch(c: any): Promise<Response> {
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      },
      400,
    )
  }

  // Batch support (JSON-RPC 2.0): array of messages.
  if (Array.isArray(body)) {
    const responses = (
      await Promise.all(body.map((m) => handleMcpMessage(m)))
    ).filter((r) => r !== null)
    return c.json(responses)
  }

  const authError = await authGate(c, body?.method)
  if (authError) return authError

  const response = await handleMcpMessage(body)
  // Notification → 202 Accepted, empty body (streamable HTTP spec).
  if (response === null) {
    return c.body(null, 202)
  }
  return c.json(response)
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport (recommended): POST /api/mcp
// ---------------------------------------------------------------------------

mcpRouter.post("/", async (c) => dispatch(c))

// GET on the streamable endpoint: server offers no SSE stream here.
mcpRouter.get("/", (c) =>
  c.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "GET not supported: POST JSON-RPC messages to /api/mcp, or use the legacy SSE transport at /api/mcp/sse",
      },
      id: null,
    },
    405,
  ),
)

// ---------------------------------------------------------------------------
// Legacy SSE transport: GET /api/mcp/sse + POST /api/mcp/messages
// The SSE stream announces the POST endpoint and then sends keepalive
// comments; JSON-RPC responses are returned synchronously in the POST body
// (simple request/response clients). Stateless-friendly.
// ---------------------------------------------------------------------------

mcpRouter.get("/sse", (c) => {
  c.header("Content-Type", "text/event-stream")
  c.header("Cache-Control", "no-cache")
  c.header("Connection", "keep-alive")

  const encoder = new TextEncoder()
  let timer: any
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`event: endpoint\ndata: /api/mcp/messages\n\n`),
      )
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`))
        } catch {
          clearInterval(timer)
        }
      }, 30_000)
    },
    cancel() {
      clearInterval(timer)
    },
  })
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
})

mcpRouter.post("/messages", (c) => dispatch(c))
