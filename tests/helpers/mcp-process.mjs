import { spawn } from "node:child_process";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

/**
 * Spawna o servidor MCP para os E2E.
 *
 * Node 26 pode encerrar um filho stdio antes de consumir o primeiro frame
 * quando pai e filho Node estão ligados diretamente por pipes. Em Unix,
 * `script` fornece um PTY e preserva o comportamento real de um host MCP.
 * O parser dos testes ignora frames ecoados pelo terminal.
 */
export function spawnMcp(entry, options = {}) {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  const needsPty = process.platform !== "win32" && major >= 26;
  const common = {
    env: options.env,
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  };

  if (!needsPty) {
    return spawn(process.execPath, [entry], common);
  }

  const command = `stty -echo; exec ${shellQuote(process.execPath)} ${shellQuote(entry)}`;
  const child = spawn("script", ["-qfec", command, "/dev/null"], common);
  child.agentdeskTestPty = true;
  return child;
}
