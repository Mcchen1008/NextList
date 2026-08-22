/**
 * Traversal-based search (no index).
 *
 * BFS from the start path, filtering by keyword + scope and paginating
 * in the caller. Limits keep API-backed drivers (Quark, Baidu, ...) from
 * being hammered: a cap on visited directories, max depth, and a cap on
 * collected matches.
 */
import { listItems } from "./storage"

export interface SearchResultNode {
  parent: string
  name: string
  is_dir: boolean
  size: number
  path: string
  type: number
}

const MAX_DEPTH = 10
const MAX_VISITED_DIRS = 500
const MAX_MATCHES = 5000

export async function searchItems(
  parent: string,
  keywords: string,
  scope: number,
): Promise<SearchResultNode[]> {
  const kw = String(keywords || "")
    .trim()
    .toLowerCase()
  if (!kw) return []

  const startPath =
    parent && parent !== "/"
      ? "/" + parent.split("/").filter(Boolean).join("/")
      : "/"

  const queue: Array<{ dir: string; depth: number }> = [
    { dir: startPath, depth: 0 },
  ]
  const visited = new Set<string>()
  const results: SearchResultNode[] = []

  while (
    queue.length > 0 &&
    visited.size < MAX_VISITED_DIRS &&
    results.length < MAX_MATCHES
  ) {
    const { dir, depth } = queue.shift()!
    if (visited.has(dir)) continue
    visited.add(dir)
    if (depth > MAX_DEPTH) continue

    let content: any[]
    try {
      content = (await listItems(dir)).content
    } catch {
      // Unlistable dir (no matching storage / virtual hole) — skip
      continue
    }

    for (const item of content) {
      const itemPath = dir === "/" ? `/${item.name}` : `${dir}/${item.name}`
      if (item.name && String(item.name).toLowerCase().includes(kw)) {
        const scopeHit =
          scope === 0 ||
          (scope === 1 && item.is_dir) ||
          (scope === 2 && !item.is_dir)
        if (scopeHit) {
          results.push({
            parent: dir,
            name: item.name,
            is_dir: !!item.is_dir,
            size: item.size || 0,
            path: itemPath,
            type: item.type ?? (item.is_dir ? 1 : 0),
          })
        }
      }
      if (item.is_dir && depth < MAX_DEPTH) {
        queue.push({ dir: itemPath, depth: depth + 1 })
      }
    }
  }

  return results
}
