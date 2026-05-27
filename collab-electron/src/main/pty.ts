import * as pty from "node-pty";
import * as os from "os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "crypto";
import { type IDisposable } from "node-pty";
import {
  getTmuxBin,
  getTerminfoDir,
  tmuxExec,
  tmuxSessionName,
  writeSessionMeta,
  readSessionMeta,
  deleteSessionMeta,
  SESSION_DIR,
  type SessionMeta,
} from "./tmux";

interface PtySession {
  pty: pty.IPty;
  shell: string;
  disposables: IDisposable[];
}

const sessions = new Map<string, PtySession>();
let shuttingDown = false;

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

function getWebContents(): typeof import("electron").webContents | null {
  try {
    return require("electron").webContents;
  } catch {
    return null;
  }
}

function sendToSender(
  senderWebContentsId: number | undefined,
  channel: string,
  payload: unknown,
): void {
  if (senderWebContentsId == null) return;
  const wc = getWebContents();
  if (!wc) return;
  const sender = wc.fromId(senderWebContentsId);
  if (sender && !sender.isDestroyed()) {
    sender.send(channel, payload);
  }
}

function utf8Env(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (!env.LANG || !env.LANG.includes("UTF-8")) {
    env.LANG = "en_US.UTF-8";
  }
  const terminfoDir = getTerminfoDir();
  if (terminfoDir) {
    env.TERMINFO = terminfoDir;
  }
  return env;
}

function isExternalSession(sessionId: string): boolean {
  // External sessions (atlas-1, quantum-1, etc.) use their name directly
  // Collab sessions use the collab- prefix
  return !sessionId.match(/^[0-9a-f]{16}$/);
}

function resolveSessionName(sessionId: string): string {
  return isExternalSession(sessionId) ? sessionId : tmuxSessionName(sessionId);
}

function attachClient(
  sessionId: string,
  cols: number,
  rows: number,
  senderWebContentsId?: number,
): pty.IPty {
  const tmuxBin = getTmuxBin();
  const name = resolveSessionName(sessionId);
  const remoteHost = process.env.COLLAB_REMOTE_HOST || "";

  let spawnBin: string;
  let spawnArgs: string[];

  if (remoteHost) {
    // Remote: attach via SSH
    spawnBin = "ssh";
    const sshPort = process.env.COLLAB_SSH_PORT || "22";
    spawnArgs = [
      "-p", sshPort,
      "-o", "ConnectTimeout=5",
      "-o", "StrictHostKeyChecking=no",
      "-t", // force TTY allocation
      remoteHost,
      `tmux -L default -u attach-session -t ${name}`,
    ];
  } else {
    // Local: attach directly — disable status bar for clean view in Collaborator
    try { tmuxExec("set", "-t", name, "status", "off"); } catch {}
    spawnBin = tmuxBin;
    spawnArgs = ["-L", "default", "-u", "attach-session", "-t", name];
  }

  const ptyProcess = pty.spawn(
    spawnBin,
    spawnArgs,
    { name: "xterm-256color", cols, rows, env: utf8Env() },
  );

  const disposables: IDisposable[] = [];

  disposables.push(
    ptyProcess.onData((data: string) => {
      sendToSender(
        senderWebContentsId,
        "pty:data",
        { sessionId, data },
      );
    }),
  );

  disposables.push(
    ptyProcess.onExit(() => {
      if (shuttingDown) {
        sessions.delete(sessionId);
        return;
      }
      try {
        tmuxExec("has-session", "-t", name);
      } catch {
        deleteSessionMeta(sessionId);
        sendToSender(
          senderWebContentsId,
          "pty:exit",
          { sessionId, exitCode: 0 },
        );
      }
      sessions.delete(sessionId);
    }),
  );

  sessions.set(sessionId, {
    pty: ptyProcess,
    shell: "",
    disposables,
  });

  return ptyProcess;
}

export function createSession(
  cwd?: string,
  senderWebContentsId?: number,
  cols?: number,
  rows?: number,
): { sessionId: string; shell: string } {
  const sessionId = crypto.randomBytes(8).toString("hex");
  const shell = process.env.SHELL || "/bin/zsh";
  const name = tmuxSessionName(sessionId);
  const resolvedCwd = cwd || os.homedir();
  const c = cols || 80;
  const r = rows || 24;

  tmuxExec(
    "new-session", "-d",
    "-s", name,
    "-c", resolvedCwd,
    "-x", String(c),
    "-y", String(r),
  );

  tmuxExec(
    "set-environment", "-t", name,
    "COLLAB_PTY_SESSION_ID", sessionId,
  );
  tmuxExec(
    "set-environment", "-t", name,
    "SHELL", shell,
  );

  writeSessionMeta(sessionId, {
    shell,
    cwd: resolvedCwd,
    createdAt: new Date().toISOString(),
  });

  attachClient(sessionId, c, r, senderWebContentsId);

  const session = sessions.get(sessionId)!;
  session.shell = shell;

  return { sessionId, shell };
}

function stripTrailingBlanks(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") {
    end--;
  }
  return lines.slice(0, end).join("\n");
}

export function reconnectSession(
  sessionId: string,
  cols: number,
  rows: number,
  senderWebContentsId: number,
): {
  sessionId: string;
  shell: string;
  meta: SessionMeta | null;
  scrollback: string;
} {
  const name = resolveSessionName(sessionId);

  try {
    tmuxExec("has-session", "-t", name);
  } catch {
    deleteSessionMeta(sessionId);
    throw new Error(`tmux session ${name} not found`);
  }

  let scrollback = "";
  try {
    const raw = tmuxExec(
      "capture-pane", "-t", name,
      "-p", "-e", "-S", "-200000",
    );
    scrollback = stripTrailingBlanks(raw);
  } catch {
    // Proceed without scrollback
  }

  attachClient(sessionId, cols, rows, senderWebContentsId);

  try {
    tmuxExec(
      "resize-window", "-t", name,
      "-x", String(cols), "-y", String(rows),
    );
  } catch {
    // Non-fatal
  }

  const meta = readSessionMeta(sessionId);
  const session = sessions.get(sessionId)!;
  session.shell =
    meta?.shell || process.env.SHELL || "/bin/zsh";

  return { sessionId, shell: session.shell, meta, scrollback };
}

export function writeToSession(
  sessionId: string,
  data: string,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.pty.write(data);
}

export function sendRawKeys(
  sessionId: string,
  data: string,
): void {
  const name = resolveSessionName(sessionId);
  tmuxExec("send-keys", "-l", "-t", name, data);
}

export function resizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.pty.resize(cols, rows);

  const name = resolveSessionName(sessionId);
  try {
    tmuxExec(
      "resize-window", "-t", name,
      "-x", String(cols), "-y", String(rows),
    );
  } catch {
    // Non-fatal
  }
}

export function killSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
    sessions.delete(sessionId);
  }

  // NEVER kill external agent sessions — only kill collab-owned sessions
  if (isExternalSession(sessionId)) {
    return;
  }

  const name = resolveSessionName(sessionId);
  try {
    tmuxExec("kill-session", "-t", name);
  } catch {
    // Session may already be dead
  }

  deleteSessionMeta(sessionId);
}

export function listSessions(): string[] {
  return [...sessions.keys()];
}

export function killAll(): void {
  shuttingDown = true;
  for (const [id, session] of sessions) {
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
    sessions.delete(id);
  }
}

const KILL_ALL_TIMEOUT_MS = 2000;

export function killAllAndWait(): Promise<void> {
  shuttingDown = true;
  if (sessions.size === 0) return Promise.resolve();

  const pending: Promise<void>[] = [];
  for (const [id, session] of sessions) {
    pending.push(
      new Promise<void>((resolve) => {
        session.pty.onExit(() => resolve());
      }),
    );
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
    sessions.delete(id);
  }

  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, KILL_ALL_TIMEOUT_MS),
  );

  return Promise.race([
    Promise.all(pending).then(() => {}),
    timeout,
  ]);
}

export function destroyAll(): void {
  killAll();
  try {
    tmuxExec("kill-server");
  } catch {
    // Server may not be running
  }
}

export interface DiscoveredSession {
  sessionId: string;
  meta: SessionMeta;
}

export function discoverSessions(): DiscoveredSession[] {
  let tmuxNames: string[];
  try {
    const raw = tmuxExec(
      "list-sessions", "-F", "#{session_name}",
    );
    tmuxNames = raw.split("\n").filter(Boolean);
  } catch {
    tmuxNames = [];
  }

  const tmuxSet = new Set(tmuxNames);
  const result: DiscoveredSession[] = [];

  let metaFiles: string[];
  try {
    metaFiles = fs
      .readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith(".json"));
  } catch {
    metaFiles = [];
  }

  for (const file of metaFiles) {
    const sessionId = file.replace(".json", "");
    const name = tmuxSessionName(sessionId);

    if (tmuxSet.has(name)) {
      const meta = readSessionMeta(sessionId);
      if (meta) {
        result.push({ sessionId, meta });
      }
      tmuxSet.delete(name);
    } else {
      deleteSessionMeta(sessionId);
    }
  }

  // Include non-collab sessions (e.g. atlas-1, nova-1) as discovered
  for (const extName of tmuxSet) {
    if (extName.startsWith("collab-")) {
      // Orphan collab session without metadata — kill it
      try {
        tmuxExec("kill-session", "-t", extName);
      } catch {
        // Already dead
      }
    } else {
      // External session (our agent tmux sessions) — include in results
      result.push({
        sessionId: extName,
        meta: {
          shell: process.env.SHELL || "/bin/bash",
          cwd: process.env.HOME || "/home/mav",
          createdAt: new Date().toISOString(),
        },
      });
    }
  }

  return result;
}

export function tmuxKillSession(sessionName: string): void {
  try {
    tmuxExec("kill-session", "-t", sessionName);
  } catch {
    // Session may already be dead
  }
}

export function verifyTmuxAvailable(): void {
  tmuxExec("-V");
}

// ── System metrics ──

export interface SystemMetrics {
  cpuPercent: number;
  ramUsedGB: number;
  ramTotalGB: number;
  diskUsedGB: number;
  diskTotalGB: number;
  netUp: boolean;
  agentsRunning: number;
  agentsTotal: number;
}

// System metrics cache — expensive ops cached longer
const sysMetricsCache: { data: SystemMetrics | null; ts: number } = { data: null, ts: 0 };

export function getSystemMetrics(): SystemMetrics {
  if (process.env.COLLAB_REMOTE_HOST) return {cpuPercent:0,ramUsedGB:0,ramTotalGB:0,diskUsedGB:0,diskTotalGB:0,netUp:true,agentsRunning:0,agentsTotal:0};
  const now = Date.now();
  // Cache for 10s — system metrics don't change fast
  if (sysMetricsCache.data && now - sysMetricsCache.ts < 10000) return sysMetricsCache.data;

  let cpuPercent = 0;
  let ramUsedGB = 0;
  let ramTotalGB = 0;
  let agentsRunning = 0;

  try {
    const memInfo = fs.readFileSync("/proc/meminfo", "utf8");
    const total = parseInt(memInfo.match(/MemTotal:\s+(\d+)/)?.[1] || "0", 10);
    const avail = parseInt(memInfo.match(/MemAvailable:\s+(\d+)/)?.[1] || "0", 10);
    ramTotalGB = Math.round(total / 1024 / 1024 * 10) / 10;
    ramUsedGB = Math.round((total - avail) / 1024 / 1024 * 10) / 10;
  } catch {}

  try {
    const loadavg = fs.readFileSync("/proc/loadavg", "utf8");
    cpuPercent = Math.round(parseFloat(loadavg.split(" ")[0] || "0") * 100 / (os.cpus().length || 1));
  } catch {}

  try {
    const raw = tmuxExec("list-sessions", "-F", "#{session_name}");
    agentsRunning = raw.split("\n").filter((n: string) => n && !n.startsWith("collab-")).length;
  } catch {}

  const result: SystemMetrics = {
    cpuPercent,
    ramUsedGB,
    ramTotalGB,
    diskUsedGB: 0,
    diskTotalGB: 0,
    netUp: true, // Assume true — ping is too expensive
    agentsRunning,
    agentsTotal: ALL_AGENTS.length,
  };
  sysMetricsCache.data = result;
  sysMetricsCache.ts = now;
  return result;
}

// ── Conversation history ──

export interface ConversationSummary {
  sessionId: string;
  agent: string;
  title: string;
  startedAt: string;
  isActive: boolean;
}

const historyCache: { data: ConversationSummary[]; mtime: number } = { data: [], mtime: 0 };

export function getConversationHistory(): ConversationSummary[] {
  if (process.env.COLLAB_REMOTE_HOST) return [];
  const now = Date.now();
  // Cache for 30s — history doesn't change often
  if (historyCache.data.length > 0 && now - historyCache.mtime < 30000) {
    return historyCache.data;
  }

  // Get active session IDs
  const activeSessionIds = new Set<string>();
  try {
    for (const f of fs.readdirSync(CLAUDE_SESSIONS_DIR).filter((f) => f.endsWith(".json"))) {
      try {
        const pid = f.replace(".json", "");
        if (!fs.existsSync(`/proc/${pid}`)) continue;
        const d = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, f), "utf8"));
        if (d.sessionId) activeSessionIds.add(d.sessionId);
      } catch {}
    }
  } catch {}

  try {
    // List JSONL files sorted by mtime — pure Node, no process spawn
    const dir = CLAUDE_PROJECTS_DIR;
    const jsonlFiles = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 50); // Only last 50, not 100

    const results: ConversationSummary[] = [];

    for (const { name } of jsonlFiles) {
      const sid = name.replace(".jsonl", "");
      const fpath = path.join(dir, name);

      try {
        // Read first 8KB — enough for agent-setting + first user message
        const fd = fs.openSync(fpath, "r");
        const buf = Buffer.alloc(8192);
        const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
        fs.closeSync(fd);

        const head = buf.toString("utf8", 0, bytesRead);
        const lines = head.split("\n").filter(Boolean);

        let agent = "";
        let title = "";
        let startedAt = "";

        for (const line of lines) {
          try {
            const d = JSON.parse(line);
            if (d.type === "agent-setting" && d.agentSetting) agent = d.agentSetting;
            if (d.timestamp && !startedAt) startedAt = d.timestamp;
            if (d.type === "user" && !title) {
              const content = d.message?.content;
              if (Array.isArray(content)) {
                for (const b of content) {
                  if (b.type === "text" && b.text) { title = b.text.slice(0, 100); break; }
                }
              } else if (typeof content === "string") {
                title = content.slice(0, 100);
              }
            }
            if (agent && title && startedAt) break; // Got everything we need
          } catch {}
        }

        results.push({
          sessionId: sid,
          agent: agent || "unknown",
          title: title || "Untitled",
          startedAt,
          isActive: activeSessionIds.has(sid),
        });
      } catch {}
    }

    historyCache.data = results;
    historyCache.mtime = now;
    return results;
  } catch {
    return historyCache.data;
  }
}

// ── Agent roster (all known agents) ──

const ALL_AGENTS = [
  { name: "atlas", role: "vp", tier: "opus" },
  { name: "jarvis", role: "vp", tier: "opus" },
  { name: "shield", role: "vp", tier: "opus" },
  { name: "nova", role: "dir", tier: "opus" },
  { name: "apex", role: "dir", tier: "opus" },
  { name: "sage", role: "dir", tier: "opus" },
  { name: "kraken", role: "dir", tier: "opus" },
  { name: "leo", role: "dir", tier: "opus" },
  { name: "sentinel", role: "dir", tier: "opus" },
  { name: "growth", role: "dir", tier: "opus" },
  { name: "audit", role: "dir", tier: "sonnet" },
  { name: "pentest", role: "dir", tier: "sonnet" },
  { name: "relay", role: "worker", tier: "sonnet" },
  { name: "factory", role: "worker", tier: "sonnet" },
  { name: "forge", role: "worker", tier: "sonnet" },
  { name: "droid", role: "worker", tier: "sonnet" },
  { name: "swift", role: "worker", tier: "sonnet" },
  { name: "quantum", role: "worker", tier: "opus" },
  { name: "mentor", role: "worker", tier: "sonnet" },
  { name: "keeper", role: "worker", tier: "sonnet" },
  { name: "sweeper", role: "worker", tier: "sonnet" },
  { name: "maker", role: "worker", tier: "sonnet" },
  { name: "style", role: "worker", tier: "sonnet" },
  { name: "craft", role: "worker", tier: "sonnet" },
  { name: "draft", role: "worker", tier: "sonnet" },
  { name: "oracle", role: "worker", tier: "sonnet" },
  { name: "aria", role: "worker", tier: "sonnet" },
  { name: "scribe", role: "worker", tier: "sonnet" },
  { name: "boost", role: "worker", tier: "sonnet" },
  { name: "creative", role: "worker", tier: "haiku" },
  { name: "vigil", role: "worker", tier: "sonnet" },
  { name: "trace", role: "worker", tier: "haiku" },
  { name: "verify", role: "worker", tier: "sonnet" },
  { name: "scan", role: "worker", tier: "sonnet" },
  { name: "strike", role: "worker", tier: "sonnet" },
  { name: "patch", role: "worker", tier: "sonnet" },
  { name: "tax", role: "worker", tier: "sonnet" },
  { name: "oracle-fin", role: "worker", tier: "sonnet" },
  { name: "vita", role: "worker", tier: "sonnet" },
  { name: "cura", role: "worker", tier: "opus" },
];

export interface AgentInfo {
  name: string;
  role: string;
  tier: string;
  running: boolean;
  tmuxSession: string;
}

export function getAgentRoster(): AgentInfo[] {
  // Get running tmux sessions and map agent → session names
  const agentSessions = new Map<string, string[]>();
  try {
    const raw = tmuxExec("list-sessions", "-F", "#{session_name}");
    for (const sname of raw.split("\n").filter(Boolean)) {
      if (sname.startsWith("collab-")) continue;
      // Extract agent name: "atlas-1" → "atlas", "jarvis-agent" → "jarvis", "vita-builder" → "vita"
      const agent = sname.replace(/-\d+$/, "").replace(/-agent$/, "").replace(/-builder$/, "");
      const list = agentSessions.get(agent) || [];
      list.push(sname);
      agentSessions.set(agent, list);
    }
  } catch {}

  return ALL_AGENTS.map((a) => {
    const sessions = agentSessions.get(a.name) || [];
    return {
      ...a,
      running: sessions.length > 0,
      // Return first session as primary
      tmuxSession: sessions[0] || "",
    };
  });
}

// ── Agent cockpit — JSONL mtime is the single source of truth ──

export interface AgentStatus {
  sessionId: string;
  status: "working" | "thinking" | "waiting" | "bash" | "idle" | "off";
  statusDetail: string;
  currentTool: string;
  promptCount: number;
  memoryMB: number;
  preview: string;
  lastActivity: string;
  needsInput: boolean;
  contextTokens: number;
  contextMax: number;
  contextPercent: number;
}

const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects", "-home-mav");

// Caches
const promptCache = new Map<string, { count: number; size: number }>();
const memoryCache = new Map<string, { mb: number; ts: number }>();

function getClaudeSessionId(panePid: string): string {
  try {
    const raw = fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, `${panePid}.json`), "utf8");
    return (JSON.parse(raw) as { sessionId: string }).sessionId || "";
  } catch {
    return "";
  }
}

// Read last line of a file without spawning a process
function readLastLine(filePath: string): string {
  try {
    const fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) { fs.closeSync(fd); return ""; }
    // Read last 4KB — enough for any single JSONL line
    const readSize = Math.min(4096, stat.size);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter(Boolean);
    return lines[lines.length - 1] || "";
  } catch {
    return "";
  }
}

function getLastJournalEvent(claudeSessionId: string): {
  type: string;
  toolName: string;
  text: string;
  timestamp: string;
} {
  const jpath = path.join(CLAUDE_PROJECTS_DIR, `${claudeSessionId}.jsonl`);
  const line = readLastLine(jpath);
  if (!line) return { type: "", toolName: "", text: "", timestamp: "" };
  try {
    const d = JSON.parse(line);
    const type = d.type || "";
    const ts = d.timestamp || "";
    let toolName = "";
    let text = "";
    if (type === "assistant") {
      const content = d.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "tool_use") toolName = b.name || "";
          if (b.type === "text") text = (b.text || "").slice(0, 60);
        }
      }
    }
    if (type === "progress") {
      const hookName = d.data?.hookName || "";
      toolName = hookName.split(":").pop() || "hook";
    }
    return { type, toolName, text, timestamp: ts };
  } catch {
    return { type: "", toolName: "", text: "", timestamp: "" };
  }
}

const DEFAULT_CONTEXT_LIMIT = 200_000;

function getContextLimit(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("opus")) return 1_000_000;
  if (m.includes("sonnet")) return 200_000;
  if (m.includes("haiku")) return 200_000;
  return DEFAULT_CONTEXT_LIMIT;
}

// Cache context data — only update when file changes
const contextCache = new Map<string, { tokens: number; max: number; size: number }>();

function getContextInfo(claudeSessionId: string): { tokens: number; max: number } {
  const jpath = path.join(CLAUDE_PROJECTS_DIR, `${claudeSessionId}.jsonl`);
  try {
    const stat = fs.statSync(jpath);
    const cached = contextCache.get(claudeSessionId);
    if (cached && cached.size === stat.size) return { tokens: cached.tokens, max: cached.max };

    // Read last 32KB and find last assistant event — no process spawn
    const fd = fs.openSync(jpath, "r");
    const readSize = Math.min(32768, stat.size);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);

    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('"type":"assistant"')) continue;
      try {
        const d = JSON.parse(lines[i]!);
        if (d.type !== "assistant") continue;
        const u = d.message?.usage || {};
        const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        const model = d.message?.model || "";
        const max = getContextLimit(model);
        contextCache.set(claudeSessionId, { tokens, max, size: stat.size });
        return { tokens, max };
      } catch { continue; }
    }
    return { tokens: cached?.tokens || 0, max: cached?.max || DEFAULT_CONTEXT_LIMIT };
  } catch {
    const cached = contextCache.get(claudeSessionId);
    return { tokens: cached?.tokens || 0, max: cached?.max || DEFAULT_CONTEXT_LIMIT };
  }
}

function getJournalMtime(claudeSessionId: string): number {
  const jpath = path.join(CLAUDE_PROJECTS_DIR, `${claudeSessionId}.jsonl`);
  try {
    return fs.statSync(jpath).mtimeMs;
  } catch {
    return 0;
  }
}

function countPrompts(claudeSessionId: string): number {
  const jpath = path.join(CLAUDE_PROJECTS_DIR, `${claudeSessionId}.jsonl`);
  try {
    const stat = fs.statSync(jpath);
    const cached = promptCache.get(claudeSessionId);
    if (cached && cached.size === stat.size) return cached.count;

    // Only read new bytes
    const startByte = cached?.size || 0;
    const fd = fs.openSync(jpath, "r");
    const buf = Buffer.alloc(Math.max(0, stat.size - startByte));
    fs.readSync(fd, buf, 0, buf.length, startByte);
    fs.closeSync(fd);
    let newCount = 0;
    for (const line of buf.toString("utf8").split("\n")) {
      if (line.includes('"type":"user"') || line.includes('"type": "user"')) newCount++;
    }
    const total = (cached?.count || 0) + newCount;
    promptCache.set(claudeSessionId, { count: total, size: stat.size });
    return total;
  } catch {
    return promptCache.get(claudeSessionId)?.count || 0;
  }
}

function getMemory(pid: string): number {
  const now = Date.now();
  const cached = memoryCache.get(pid);
  if (cached && now - cached.ts < 5000) return cached.mb;
  try {
    // Read /proc/pid/status directly — no process spawn
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/VmRSS:\s+(\d+)/);
    const kb = match ? parseInt(match[1]!, 10) : 0;
    const mb = Math.round(kb / 1024);
    memoryCache.set(pid, { mb, ts: now });
    return mb;
  } catch {
    return cached?.mb || 0;
  }
}

export function getAgentStatuses(): AgentStatus[] {
  if (process.env.COLLAB_REMOTE_HOST) return [];
  let panes: Array<{ name: string; pid: string }>;
  try {
    const raw = tmuxExec("list-panes", "-a", "-F", "#{session_name} #{pane_pid}");
    panes = raw.split("\n").filter(Boolean).map((l) => {
      const [name, pid] = l.split(" ");
      return { name: name!, pid: pid! };
    });
  } catch {
    return [];
  }

  const now = Date.now();
  const results: AgentStatus[] = [];

  for (const { name, pid } of panes) {
    if (name.startsWith("collab-")) continue;

    const claudeSessionId = getClaudeSessionId(pid);

    // No Claude session file → it's a plain bash shell
    if (!claudeSessionId) {
      results.push({
        sessionId: name, status: "bash", statusDetail: "Shell",
        currentTool: "", promptCount: 0, memoryMB: getMemory(pid),
        preview: "", lastActivity: new Date().toISOString(), needsInput: false,
      });
      continue;
    }

    const evt = getLastJournalEvent(claudeSessionId);
    const mtime = getJournalMtime(claudeSessionId);

    let status: AgentStatus["status"] = "idle";
    let detail = "Idle";
    let tool = "";
    let needsInput = false;

    // The last JSONL event IS the current state. No timestamps, no thresholds.
    if (evt.type === "assistant" && evt.toolName) {
      status = "working";
      detail = evt.toolName;
      tool = evt.toolName;
    } else if (evt.type === "assistant" && evt.text) {
      status = "thinking";
      detail = "Responding";
    } else if (evt.type === "progress") {
      status = "working";
      detail = evt.toolName || "Processing";
      tool = evt.toolName;
    } else if (evt.type === "user") {
      // "user" = message sent. If JSONL still updating (mtime recent) → processing.
      // If JSONL stopped updating → idle (Claude finished or crashed).
      const ageMs = now - mtime;
      if (ageMs < 5000) {
        status = "thinking";
        detail = "Processing";
      } else {
        status = "waiting";
        detail = "Awaiting input";
        needsInput = true;
      }
    } else if (evt.type === "result") {
      status = "waiting";
      detail = "Awaiting input";
      needsInput = true;
    } else {
      status = "idle";
      detail = "Idle";
    }

    const ctx = getContextInfo(claudeSessionId);
    const contextTokens = ctx.tokens;
    const contextMax = ctx.max;
    const contextPercent = contextMax > 0 ? Math.round((contextTokens / contextMax) * 100) : 0;

    results.push({
      sessionId: name,
      status,
      statusDetail: detail,
      currentTool: tool,
      promptCount: countPrompts(claudeSessionId),
      memoryMB: getMemory(pid),
      preview: detail,
      lastActivity: new Date(mtime).toISOString(),
      needsInput,
      contextTokens,
      contextMax,
      contextPercent: Math.min(contextPercent, 100),
    });
  }

  return results;
}
