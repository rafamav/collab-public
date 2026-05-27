import { execFileSync, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { COLLAB_DIR } from "./paths";

export interface SessionMeta {
  shell: string;
  cwd: string;
  createdAt: string;
}

export const SESSION_DIR = path.join(
  COLLAB_DIR, "terminal-sessions",
);
const SOCKET_NAME = "default";

// Remote host for tmux sessions — if set, tmux commands go via SSH
// Set to empty string for local tmux (desktop), or "mav@100.86.55.27" for remote (laptop→desktop)
const REMOTE_HOST = process.env.COLLAB_REMOTE_HOST || "";
const REMOTE_PORT = process.env.COLLAB_SSH_PORT || "22";

// Electron app module — unavailable in unit tests.
// Lazy-loaded to avoid crashing bun test.
function getApp(): typeof import("electron").app | null {
  try {
    return require("electron").app;
  } catch {
    return null;
  }
}

export function getTmuxBin(): string {
  const app = getApp();
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, "tmux");
  }
  return "tmux";
}


export function getTmuxConf(): string {
  const app = getApp();
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, "tmux.conf");
  }
  // Dev mode: resolve from project root.
  // app.getAppPath() returns project root in electron-vite;
  // fall back to cwd for unit tests.
  const root = app?.getAppPath() ?? process.cwd();
  return path.join(root, "resources", "tmux.conf");
}

export function getTerminfoDir(): string | undefined {
  const app = getApp();
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, "terminfo");
  }
  return undefined;
}

function baseArgs(): string[] {
  return ["-L", SOCKET_NAME, "-u", "-f", getTmuxConf()];
}

function tmuxEnv(): Record<string, string> | undefined {
  const dir = getTerminfoDir();
  if (!dir) return undefined;
  return { ...process.env, TERMINFO: dir } as Record<string, string>;
}

function remoteBaseArgs(): string[] {
  // When remote, don't pass local tmux.conf path — it doesn't exist on remote
  return ["-L", SOCKET_NAME, "-u"];
}

function shellEscape(arg: string): string {
  // Wrap in double quotes if contains # or spaces (tmux format strings)
  if (arg.includes("#") || arg.includes(" ") || arg.includes("{")) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}

export function tmuxExec(...args: string[]): string {
  if (REMOTE_HOST) {
    const escapedArgs = args.map(shellEscape);
    const tmuxCmd = ["tmux", ...remoteBaseArgs(), ...escapedArgs].join(" ");
    return execFileSync(
      "ssh", ["-p", REMOTE_PORT, "-o", "ConnectTimeout=3", "-o", "StrictHostKeyChecking=no", REMOTE_HOST, tmuxCmd],
      { encoding: "utf8", timeout: 8000 },
    ).trim();
  }
  return execFileSync(
    getTmuxBin(), [...baseArgs(), ...args],
    { encoding: "utf8", timeout: 5000, env: tmuxEnv() },
  ).trim();
}

export function tmuxExecAsync(
  ...args: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (REMOTE_HOST) {
      const escapedArgs = args.map(shellEscape);
      const tmuxCmd = ["tmux", ...remoteBaseArgs(), ...escapedArgs].join(" ");
      execFile(
        "ssh", ["-p", REMOTE_PORT, "-o", "ConnectTimeout=3", "-o", "StrictHostKeyChecking=no", REMOTE_HOST, tmuxCmd],
        { encoding: "utf8", timeout: 8000 },
        (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout.trim());
        },
      );
      return;
    }
    execFile(
      getTmuxBin(), [...baseArgs(), ...args],
      { encoding: "utf8", timeout: 5000, env: tmuxEnv() },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      },
    );
  });
}

export function tmuxSessionName(sessionId: string): string {
  return `collab-${sessionId}`;
}

function ensureSessionDir(): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function metaPath(sessionId: string): string {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

export function writeSessionMeta(
  sessionId: string,
  meta: SessionMeta,
): void {
  ensureSessionDir();
  fs.writeFileSync(metaPath(sessionId), JSON.stringify(meta));
}

export function readSessionMeta(
  sessionId: string,
): SessionMeta | null {
  try {
    const raw = fs.readFileSync(metaPath(sessionId), "utf8");
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

export function deleteSessionMeta(sessionId: string): void {
  try {
    fs.unlinkSync(metaPath(sessionId));
  } catch {
    // no-op if file doesn't exist
  }
}
