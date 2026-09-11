// NextList MCP (Model Context Protocol) implementation.
//
// JSON-RPC 2.0 endpoint that lets AI assistants (Claude, Cursor, etc.)
// browse and inspect a NextList instance. Supports both:
//   - Streamable HTTP : POST /api/mcp           (recommended)
//   - Legacy SSE pair : GET  /api/mcp/sse  +  POST /api/mcp/messages
//
// Implemented methods:
//   initialize / notifications/initialized / ping
//   tools/list / tools/call          (list_files, get_file_info, search_files, get_system_info)
//   resources/list / resources/read  (nextlist://storage/metrics, nextlist://storage/list)
//   prompts/list / prompts/get       (summarize_directory)
//
// Auth: every request goes through getUserFromContext — a valid JWT,
// the static API token (settings.token), or an enabled guest account.

import { listItems, getItem } from "../op/storage"
import { searchItems } from "../op/search"
import { getDb } from "../model/db"

export interface McpTool {
  name: string
  description: string
  inputSchema: any
}

export interface McpResource {
  uri: string
  name: string
  mimeType: string
  description: string
}

export interface McpPrompt {
  name: string
  description: string
  arguments: Array<{ name: string; description: string; required: boolean }>
}

/** Protocol versions this server can speak (newest first). */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"]
const LATEST_PROTOCOL_VERSION = "2025-03-26"
const SERVER_VERSION = "alpha0.1.2"

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function listMcpTools(): McpTool[] {
  return [
    {
      name: "list_files",
      description:
        "List files and directories at a path in NextList storage. " +
        "Returns name, directory flag, size and modified time for each entry.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Virtual mount path to list, e.g. / or /NAS/Movies",
          },
          password: {
            type: "string",
            description: "Optional meta password when the path is protected",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "get_file_info",
      description:
        "Get metadata of a single file or directory: size, type, modified " +
        "time and a direct download URL (raw_url).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Full path of the item" },
          password: { type: "string", description: "Optional meta password" },
        },
        required: ["path"],
      },
    },
    {
      name: "search_files",
      description:
        "Recursively search files under a parent path by keyword " +
        "(BFS, capped). scope: 0=all, 1=folders only, 2=files only.",
      inputSchema: {
        type: "object",
        properties: {
          parent: {
            type: "string",
            description: "Directory to start the search from, e.g. /",
          },
          keywords: { type: "string", description: "Keyword to match" },
          scope: {
            type: "number",
            description: "0=all (default), 1=folders, 2=files",
          },
        },
        required: ["parent", "keywords"],
      },
    },
    {
      name: "get_system_info",
      description:
        "Fetch NextList server metrics: version, environment, number of " +
        "mounted storages (by driver), users, shares and metas.",
      inputSchema: { type: "object", properties: {} },
    },
  ]
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export function listMcpResources(): McpResource[] {
  return [
    {
      uri: "nextlist://storage/metrics",
      name: "Storage Metrics",
      mimeType: "application/json",
      description:
        "Current server metrics of NextList (same as get_system_info)",
    },
    {
      uri: "nextlist://storage/list",
      name: "Mounted Storages",
      mimeType: "application/json",
      description: "All mounted storages with mount path, driver and status",
    },
  ]
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function listMcpPrompts(): McpPrompt[] {
  return [
    {
      name: "summarize_directory",
      description: "Ask the assistant to summarize the contents of a folder",
      arguments: [
        {
          name: "path",
          description: "The folder path to summarize",
          required: true,
        },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(size: number): string {
  if (!Number.isFinite(size)) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let v = size
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

function textContent(text: string) {
  return { content: [{ type: "text", text }], isError: false }
}

function errorContent(message: string) {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  }
}

async function getSystemInfo(): Promise<string> {
  const db = await getDb()
  const storages = db.storages || []
  const byDriver: Record<string, number> = {}
  for (const s of storages) {
    if (s.disabled) continue
    byDriver[s.driver] = (byDriver[s.driver] || 0) + 1
  }
  const info = {
    name: "NextList",
    version: SERVER_VERSION,
    storages_total: storages.length,
    storages_enabled: Object.values(byDriver).reduce((a, b) => a + b, 0),
    storages_by_driver: byDriver,
    users: (db.users || []).length,
    shares: (db.shares || []).length,
    metas: (db.metas || []).length,
  }
  return JSON.stringify(info, null, 2)
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function callTool(name: string, args: any): Promise<any> {
  args = args || {}
  switch (name) {
    case "list_files": {
      const path = String(args.path || "/")
      const { content, provider } = await listItems(path)
      const lines = (content || []).map(
        (f: any) =>
          `${f.is_dir ? "[DIR] " : "[FILE]"} ${f.name}  (${formatSize(f.size || 0)}, ${f.modified || "unknown"})`,
      )
      const header = `Listing of ${path} — ${lines.length} item(s), provider: ${provider}`
      return textContent(
        lines.length
          ? `${header}\n${lines.join("\n")}`
          : `${header}\n(empty directory)`,
      )
    }
    case "get_file_info": {
      const path = String(args.path || "/")
      const { item, provider, rawUrl } = await getItem(path)
      return textContent(
        JSON.stringify(
          {
            name: item.name,
            size: item.size,
            size_human: formatSize(item.size || 0),
            is_dir: !!item.is_dir,
            modified: item.modified,
            type: item.type,
            provider,
            raw_url: rawUrl,
          },
          null,
          2,
        ),
      )
    }
    case "search_files": {
      const parent = String(args.parent || "/")
      const keywords = String(args.keywords || "")
      const scope = Number(args.scope) || 0
      const matches = await searchItems(parent, keywords, scope)
      const lines = (matches || [])
        .slice(0, 100)
        .map(
          (m: any) => `${m.is_dir ? "[DIR] " : "[FILE]"} ${m.path || m.name}`,
        )
      const total = (matches || []).length
      return textContent(
        `${total} match(es) for "${keywords}" under ${parent}${total > 100 ? " (showing first 100)" : ""}\n${lines.join("\n") || "(no matches)"}`,
      )
    }
    case "get_system_info":
      return textContent(await getSystemInfo())
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

async function readResource(uri: string): Promise<any> {
  switch (uri) {
    case "nextlist://storage/metrics":
      return {
        uri,
        mimeType: "application/json",
        text: await getSystemInfo(),
      }
    case "nextlist://storage/list": {
      const db = await getDb()
      const list = (db.storages || []).map((s: any) => ({
        id: s.id,
        mount_path: s.mount_path,
        driver: s.driver,
        enabled: !s.disabled,
        order: s.order ?? 0,
      }))
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(list, null, 2),
      }
    }
    default:
      throw new Error(`Unknown resource: ${uri}`)
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatcher
// ---------------------------------------------------------------------------

function ok(id: any, result: any) {
  return { jsonrpc: "2.0", result, id }
}

function err(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: id ?? null }
}

/**
 * Handle one JSON-RPC message.
 * Returns the response object, or null when the message is a
 * notification (no response required).
 */
export async function handleMcpMessage(body: any): Promise<any | null> {
  const { method, id, params } = body || {}

  if (!method || typeof method !== "string") {
    return err(id, -32600, "Invalid Request: missing method")
  }

  // Notifications never produce a response.
  if (
    method === "notifications/initialized" ||
    method === "notifications/cancelled"
  ) {
    return null
  }

  try {
    switch (method) {
      case "initialize": {
        const requested = String(params?.protocolVersion || "")
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION
        return ok(id, {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false },
            prompts: { listChanged: false },
          },
          serverInfo: { name: "NextList", version: SERVER_VERSION },
          instructions:
            "NextList is a file list program backed by multiple cloud storages. " +
            "Use list_files to browse mounted paths (start from /), get_file_info " +
            "for details, search_files to locate items.",
        })
      }

      case "ping":
        return ok(id, {})

      case "tools/list":
        return ok(id, { tools: listMcpTools() })

      case "tools/call": {
        const name = String(params?.name || "")
        if (!listMcpTools().some((t) => t.name === name)) {
          return err(id, -32602, `Unknown tool: ${name}`)
        }
        try {
          const result = await callTool(name, params?.arguments)
          return ok(id, result)
        } catch (e: any) {
          return ok(id, errorContent(e?.message || String(e)))
        }
      }

      case "resources/list":
        return ok(id, { resources: listMcpResources() })

      case "resources/read": {
        const uri = String(params?.uri || "")
        try {
          return ok(id, { contents: [await readResource(uri)] })
        } catch (e: any) {
          return err(id, -32602, e?.message || `Unknown resource: ${uri}`)
        }
      }

      case "prompts/list":
        return ok(id, { prompts: listMcpPrompts() })

      case "prompts/get": {
        const name = String(params?.name || "")
        if (name !== "summarize_directory") {
          return err(id, -32602, `Unknown prompt: ${name}`)
        }
        const path = String(params?.arguments?.path || "/")
        return ok(id, {
          description: `Summarize the contents of ${path}`,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text:
                  `Please summarize the contents of the NextList folder "${path}". ` +
                  `First call the list_files tool with path "${path}", then group the ` +
                  `results by file type and highlight anything notable.`,
              },
            },
          ],
        })
      }

      default:
        return err(id, -32601, `Method not found: ${method}`)
    }
  } catch (e: any) {
    return err(id, -32603, e?.message || "Internal error")
  }
}
