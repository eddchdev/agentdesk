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

export interface IntegracaoResult {
  branch: string;
  commit: string | null;
  arquivos: string[];
  enviada: boolean;
  pr_url: string | null;
  avisos: string[];
}

// Fecha o ciclo do item: commita o que está na worktree dele, empurra a branch
// e abre o PR. Nunca faz merge: quem decide o que entra na branch principal é
// a pessoa. O `add -A` é seguro aqui porque a worktree foi criada pelo
// AgentDesk para este item e nada mais escreve nela.
export function integrarWorktree(input: {
  worktreePath: string;
  branch: string;
  titulo: string;
  corpo: string;
  enviar: boolean;
  abrirPr: boolean;
  timeoutMs?: number;
}): IntegracaoResult {
  const avisos: string[] = [];
  const cwd = input.worktreePath;
  if (!existsSync(cwd)) throw new Error(`A worktree ${cwd} não existe mais; não há o que integrar.`);
  const timeout = input.timeoutMs ?? 120_000;
  const rodar = (cmd: string, args: string[], dir = cwd) =>
    execFileSync(cmd, args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout });

  const pendentes = rodar("git", ["status", "--porcelain"]).trim();
  const arquivos = pendentes
    ? pendentes.split("\n").map((linha) => linha.slice(3).trim()).filter(Boolean)
    : [];

  let commit: string | null = null;
  if (arquivos.length) {
    rodar("git", ["add", "-A"]);
    try {
      rodar("git", ["commit", "-m", input.titulo, "-m", input.corpo]);
      commit = rodar("git", ["rev-parse", "--short", "HEAD"]).trim();
    } catch (error: any) {
      const saida = [error?.stdout, error?.stderr].filter(Boolean).join("\n");
      if (/user\.email|user\.name|Please tell me who you are/i.test(saida)) {
        throw new Error("git sem autor configurado nesta máquina (git config user.name / user.email).");
      }
      throw new Error(`git commit falhou: ${saida.trim() || error?.message}`);
    }
  } else {
    // Sem mudança pendente ainda pode haver commit local esperando push.
    avisos.push("nada novo para commitar na worktree");
  }

  const temRemote = rodar("git", ["remote"]).trim().length > 0;
  if (!temRemote) {
    avisos.push("repositório sem remote: nada foi enviado, o trabalho está na branch local");
    return { branch: input.branch, commit, arquivos, enviada: false, pr_url: null, avisos };
  }

  let enviada = false;
  if (input.enviar) {
    try {
      rodar("git", ["push", "-u", "origin", input.branch]);
      enviada = true;
    } catch (error: any) {
      const saida = [error?.stdout, error?.stderr].filter(Boolean).join("\n");
      avisos.push(`push falhou: ${saida.trim().split("\n").slice(-2).join(" ") || error?.message}`);
      return { branch: input.branch, commit, arquivos, enviada: false, pr_url: null, avisos };
    }
  }

  let prUrl: string | null = null;
  if (input.abrirPr && enviada) {
    const base = baseDoRepo(cwd, rodar);
    try {
      const saida = rodar("gh", [
        "pr", "create",
        "--base", base,
        "--head", input.branch,
        "--title", input.titulo,
        "--body", input.corpo,
      ]);
      prUrl = saida.trim().split("\n").find((linha) => linha.startsWith("http")) ?? null;
    } catch (error: any) {
      const saida = [error?.stdout, error?.stderr].filter(Boolean).join("\n");
      if (/already exists/i.test(saida)) {
        prUrl = saida.match(/https?:\/\/\S+/)?.[0] ?? null;
        avisos.push("PR já existia para esta branch");
      } else if (error?.code === "ENOENT") {
        avisos.push(`gh não instalado: abra o PR manualmente a partir da branch ${input.branch}`);
      } else {
        avisos.push(`gh pr create falhou: ${saida.trim().split("\n").slice(-2).join(" ") || error?.message}`);
      }
    }
  }

  return { branch: input.branch, commit, arquivos, enviada, pr_url: prUrl, avisos };
}

// Arquivos que a branch deste item realmente mexeu: o que já está commitado
// desde a base mais o que ainda está solto na worktree. A trava declarada só
// pega quem declarou; isto pega o choque de verdade, antes do merge.
export function arquivosTocados(worktreePath: string): string[] {
  if (!existsSync(worktreePath)) return [];
  const rodar = (args: string[]) =>
    execFileSync("git", args, {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
  const arquivos = new Set<string>();
  try {
    for (const linha of rodar(["status", "--porcelain"]).split("\n")) {
      const caminho = linha.slice(3).trim();
      if (caminho) arquivos.add(caminho.split(" -> ").pop()!);
    }
  } catch {
    return [];
  }
  try {
    const base = baseDoRepo(worktreePath, (cmd, args) => rodar(args));
    const merge = rodar(["merge-base", "HEAD", `origin/${base}`]).trim() || rodar(["merge-base", "HEAD", base]).trim();
    if (merge) {
      for (const caminho of rodar(["diff", "--name-only", `${merge}..HEAD`]).split("\n")) {
        if (caminho.trim()) arquivos.add(caminho.trim());
      }
    }
  } catch {
    /* branch sem base comparável: fica só com o que está solto */
  }
  return [...arquivos];
}

function baseDoRepo(cwd: string, rodar: (cmd: string, args: string[], dir?: string) => string): string {
  try {
    const ref = rodar("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
    const nome = ref.split("/").pop();
    if (nome) return nome;
  } catch {
    /* sem origin/HEAD local */
  }
  for (const candidata of ["main", "master"]) {
    try {
      rodar("git", ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidata}`]);
      return candidata;
    } catch {
      /* tenta a próxima */
    }
  }
  return "main";
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
