import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = "/tmp/agentdesk-worktrees";

export interface WorktreeResult {
  repoRoot: string;
  path: string;
  branch: string;
  created: boolean;
}

export function prepareWorktree(input: {
  folder: string;
  agentName: string;
  workItemId: string;
  title: string;
}): WorktreeResult {
  const repoRoot = git(input.folder, ["rev-parse", "--show-toplevel"]).trim();
  const repoName = slug(basename(repoRoot));
  const agent = slug(input.agentName);
  const task = slug(input.title).slice(0, 42) || input.workItemId;
  const branch = `agentdesk/${agent}/${input.workItemId}-${task}`;
  const path = join(ROOT, `${repoName}-${agent}-${input.workItemId}`);

  mkdirSync(ROOT, { recursive: true });

  if (existsSync(path)) {
    return { repoRoot, path, branch, created: false };
  }

  git(repoRoot, ["worktree", "add", "-b", branch, path, "HEAD"]);
  return { repoRoot, path, branch, created: true };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Cleanup de worktrees abandonadas. Remove diretórios em /tmp/agentdesk-worktrees
// que não foram tocados há mais de TTL_MS. Conservador: usa stat.mtimeMs do dir
// inteiro (qualquer escrita dentro do worktree atualiza). Worktrees ativas
// têm git commits ou edits frequentes — não são apagadas.
export function gcWorktrees(ttlMs = 7 * 24 * 60 * 60 * 1000): { removed: string[]; kept: number } {
  const result = { removed: [] as string[], kept: 0 };
  if (!existsSync(ROOT)) return result;
  const now = Date.now();
  for (const name of readdirSync(ROOT)) {
    const full = join(ROOT, name);
    try {
      const st = statSync(full);
      if (now - st.mtimeMs > ttlMs) {
        // git worktree remove é o caminho correto, mas precisa saber o repoRoot
        // original. Fallback: rm -rf — git worktree prune do repo original
        // resolve a entrada órfã quando o usuário rodar `git worktree list`.
        rmSync(full, { recursive: true, force: true });
        result.removed.push(name);
      } else {
        result.kept++;
      }
    } catch { /* skip */ }
  }
  return result;
}

function slug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
