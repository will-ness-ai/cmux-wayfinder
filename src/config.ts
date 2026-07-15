/**
 * `tracked.yaml` — the source of truth for which repos sync into cmux.
 *
 *   repos:
 *     - repo: owner/name          # maps auto-discovered by the wayfinder:map label
 *       path: ~/checkout          # local dir the map's workspace opens in
 */

import { parse } from "yaml";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface TrackedRepo {
  repo: string;
  /** Absolute, ~-expanded local checkout path. */
  path: string;
}

/** Expand a leading `~` / `~/` to the current home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export async function loadTracked(configPath: string): Promise<TrackedRepo[]> {
  const raw = await Bun.file(configPath).text();
  const doc = parse(raw) as { repos?: Array<{ repo?: string; path?: string }> } | null;
  const repos = doc?.repos;
  if (!Array.isArray(repos)) {
    throw new Error(`${configPath}: expected a top-level \`repos:\` list`);
  }
  return repos.map((entry, i) => {
    if (!entry?.repo || !entry?.path) {
      throw new Error(`${configPath}: repos[${i}] needs both \`repo\` and \`path\``);
    }
    return { repo: entry.repo, path: expandHome(entry.path) };
  });
}
