/**
 * NetEaseMusic StorageDriver.
 * Ported from OpenList drivers/netease_music/driver.go.
 *
 * The NetEase cloud disk is a flat, song-only drive:
 *  - list() returns the user's cloud songs (thumb = album art)
 *  - get() resolves both songs (play URL via linuxapi) and virtual
 *    "<song>.lrc" siblings (lyric text served inline via raw_content)
 *  - remove() deletes a cloud song
 *  - put() uploads an audio file through the cloud upload pipeline
 *  - mkdir/rename/move/copy are not supported (upstream: errs.NotSupport)
 */

import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { NeteaseMusicAddition } from "./types"
import { NeteaseClient } from "./util"

function basename(p: string): string {
  const parts = String(p || "")
    .split("/")
    .filter(Boolean)
  return parts[parts.length - 1] || ""
}

export class NeteaseMusicDriver implements StorageDriver {
  private client: NeteaseClient
  private addition: NeteaseMusicAddition

  constructor(addition: NeteaseMusicAddition) {
    this.addition = addition || {}
    this.client = new NeteaseClient(this.addition)
  }

  async init(): Promise<void> {
    this.client.init()
  }

  async list(_virtualPath: string, _physicalPath: string): Promise<FileItem[]> {
    const items = await this.client.listSongs()
    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    // Flat drive: only root-level files exist.
    if (parts.length !== 1) {
      throw new Error("[NeteaseMusic] Object not found")
    }
    const name = parts[0]

    // Virtual lyric sibling: "<song>.lrc" → lyric text served inline.
    if (name.toLowerCase().endsWith(".lrc")) {
      const meta = await this.client.findByLrcName(name)
      if (!meta) {
        throw new Error(`[NeteaseMusic] Lyric not found: ${name}`)
      }
      const lyric = await this.client.getLyric(meta.songId)
      const size = new TextEncoder().encode(lyric).length
      return {
        name,
        size,
        is_dir: false,
        modified: new Date(meta.addTime).toISOString(),
        sign: "",
        type: 4, // TEXT
        thumb: meta.picUrl,
        raw_content: lyric,
      }
    }

    const meta = await this.client.findByName(name)
    if (!meta) {
      throw new Error(`[NeteaseMusic] Song not found: ${name}`)
    }
    const url = await this.client.getSongLink(meta.songId)
    if (!url) {
      throw new Error(
        `[NeteaseMusic] Song URL is empty for '${name}' (may require VIP / region restriction)`,
      )
    }
    return {
      name,
      size: meta.size,
      is_dir: false,
      modified: new Date(meta.addTime).toISOString(),
      sign: "",
      type: calcFileType(name, false),
      thumb: meta.picUrl,
      raw_url: url,
    }
  }

  async mkdir(): Promise<void> {
    throw new Error("[NeteaseMusic] MakeDir is not supported")
  }

  async rename(): Promise<void> {
    throw new Error("[NeteaseMusic] Rename is not supported")
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    const name = names?.[0] || basename(physicalPath)
    const meta = await this.client.findByName(name)
    if (!meta) {
      throw new Error(`[NeteaseMusic] Song not found: ${name}`)
    }
    await this.client.removeSong(meta.songId)
  }

  async move(): Promise<void> {
    throw new Error("[NeteaseMusic] Move is not supported")
  }

  async copy(): Promise<void> {
    throw new Error("[NeteaseMusic] Copy is not supported")
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Uint8Array,
  ): Promise<void> {
    const name = basename(physicalPath)
    if (!name) {
      throw new Error("[NeteaseMusic] Invalid upload filename")
    }
    await this.client.upload(content, name)
  }
}
