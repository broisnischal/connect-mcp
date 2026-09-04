import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Host, expandHome } from "./config.js";
import { forgetCached, needsPassword, requiresTty, resolveSudoPassword, wrongPassword } from "./sudo.js";

const MAX_CAPTURE = 4 * 1024 * 1024;

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  sudo?: boolean;
  shell?: string;
  tty?: boolean;
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}

export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

export function target(host: Host): string {
  return host.user ? `${host.user}@${host.hostname}` : host.hostname;
}

/**
 * Socket path for the multiplexed master. Kept in /tmp so it stays well under
 * the ~104 byte sockaddr_un limit and clears on reboot.
 */
export function controlPath(host: Host): string {
  const dir = path.join(os.tmpdir(), `connect-mcp-${typeof process.getuid === "function" ? process.getuid() : 0}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = `${host.user ?? ""}@${host.hostname}:${host.port ?? 22}:${host.jumpHost ?? ""}`;
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
  return path.join(dir, `${hash}.sock`);
}

export function masterAlive(host: Host): boolean {
  try {
    return fs.statSync(controlPath(host)).isSocket();
  } catch {
    return false;
  }
}

/** Common ssh/scp options, including the ControlMaster multiplexing setup. */
export function sshOpts(host: Host): string[] {
  const a: string[] = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath(host)}`,
    "-o", `ControlPersist=${host.controlPersist ?? "10m"}`,
    "-o", "ServerAliveInterval=20",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=10",
    "-o", "LogLevel=ERROR",
  ];
  if (host.identityFile) a.push("-i", expandHome(host.identityFile), "-o", "IdentitiesOnly=yes");
  if (host.jumpHost) a.push("-J", host.jumpHost);
  if (host.forwardAgent) a.push("-A");
  for (const [k, v] of Object.entries(host.options ?? {})) a.push("-o", `${k}=${v}`);
  return a;
}

function portArgs(host: Host, flag: "-p" | "-P"): string[] {
  return host.port ? [flag, String(host.port)] : [];
}

export function exec(cmd: string, args: string[], stdin?: string, timeoutMs = 60_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      if (out.length < MAX_CAPTURE) out += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < MAX_CAPTURE) err += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout: out, stderr: `${err}${e.message}`, ms: Date.now() - started, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: out, stderr: err, ms: Date.now() - started, timedOut });
    });

    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

type SudoMode = "none" | "n" | "S";

/** Assemble the script the remote shell will run: env, cd, then the command. */
export function remoteScript(host: Host, command: string, opts: RunOpts = {}, mode: SudoMode = "none"): string {
  const parts: string[] = [];
  const env = { ...(host.env ?? {}), ...(opts.env ?? {}) };
  for (const [k, v] of Object.entries(env)) parts.push(`export ${k}=${shQuote(v)}`);
  const cwd = opts.cwd ?? host.cwd;
  if (cwd) parts.push(`cd ${shQuote(cwd)}`);
  const prefix = mode === "n" ? "sudo -n" : mode === "S" ? "sudo -S -p ''" : "";
  parts.push(prefix ? `${prefix} sh -c ${shQuote(command)}` : command);
  return parts.join(" && ");
}

async function runRemote(host: Host, command: string, opts: RunOpts, mode: SudoMode, stdin?: string): Promise<ExecResult> {
  const shell = opts.shell ?? host.shell ?? "bash -lc";
  const script = remoteScript(host, command, opts, mode);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const inner = `${shell} ${shQuote(script)}`;
  // Watchdog on the remote side too: killing the local ssh does not reap the
  // process on the far end, so a timeout would otherwise leak a live process.
  const secs = Math.ceil(timeoutMs / 1000);
  const remote = `if command -v timeout >/dev/null 2>&1; then timeout -k 5 ${secs} ${inner}; else ${inner}; fi`;
  const args = [
    ...sshOpts(host),
    ...portArgs(host, "-p"),
    opts.tty ? "-tt" : "-T",
    target(host),
    "--",
    remote,
  ];
  const res = await exec("ssh", args, stdin !== undefined ? stdin : opts.stdin, timeoutMs + 5000);
  // 124 is what coreutils timeout returns when it fires.
  if (!res.timedOut && res.code === 124 && res.ms >= timeoutMs * 0.9) res.timedOut = true;
  return res;
}

/**
 * Prime sudo's timestamp on a connection of its own, so the password never
 * shares stdin with the caller's data and never lands in a process argument.
 */
export async function sudoPrime(host: Host, password: string, opts: RunOpts = {}): Promise<ExecResult> {
  return runRemote(host, "sudo -S -p '' -v", { ...opts, sudo: false, cwd: undefined }, "none", password + "\n");
}

export async function sshRun(host: Host, command: string, opts: RunOpts = {}): Promise<ExecResult> {
  if (!opts.sudo) return runRemote(host, command, opts, "none");

  const first = await runRemote(host, command, opts, "n");
  if (!needsPassword(first.stderr)) return first;

  const password = await resolveSudoPassword(host);
  if (!password) return first;

  const primed = await sudoPrime(host, password, opts);
  if (wrongPassword(primed.stderr)) {
    forgetCached(host.name);
    return { ...primed, stderr: `sudo rejected the stored password for "${host.name}". ${primed.stderr}` };
  }
  if (primed.code === 0) {
    const retry = await runRemote(host, command, opts, "n");
    if (!needsPassword(retry.stderr)) return retry;
  }
  // Hardened sudoers (timestamp_timeout=0) never caches a ticket. Feed the
  // password straight to sudo, which is only safe when the caller is not
  // using stdin for its own data.
  if (opts.stdin === undefined) {
    const tty = opts.tty || requiresTty(first.stderr) || requiresTty(primed.stderr);
    return runRemote(host, command, { ...opts, tty }, "S", password + "\n");
  }
  return primed.code === 0 ? first : primed;
}

/** ssh -O <control command>: check | exit | forward | cancel */
export async function masterCtl(host: Host, ctl: string, extra: string[] = []): Promise<ExecResult> {
  const args = ["-O", ctl, ...extra, ...sshOpts(host), ...portArgs(host, "-p"), target(host)];
  return exec("ssh", args, undefined, 15_000);
}

export async function scpTransfer(
  host: Host,
  localPath: string,
  remotePath: string,
  direction: "up" | "down",
  recursive: boolean,
  timeoutMs = 300_000,
): Promise<ExecResult> {
  const remote = `${target(host)}:${remotePath}`;
  const local = expandHome(localPath);
  const args = [
    ...sshOpts(host),
    ...portArgs(host, "-P"),
    ...(recursive ? ["-r"] : []),
    "-p",
    ...(direction === "up" ? [local, remote] : [remote, local]),
  ];
  return exec("scp", args, undefined, timeoutMs);
}

export const PROBE_SCRIPT = [
  "echo '## identity'; (hostname -f 2>/dev/null || hostname); whoami",
  "echo '## os'; (grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release 2>/dev/null); uname -srm",
  "echo '## resources'; echo cores=$(nproc 2>/dev/null); free -h 2>/dev/null | head -2; df -h / 2>/dev/null | tail -1; echo load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)",
  "echo '## uptime'; uptime",
  "echo '## sudo'; (sudo -n true 2>/dev/null && echo passwordless) || echo needs-password-or-unavailable",
  "echo '## tools'; for t in docker kubectl node python3 git nginx pm2 psql redis-cli systemctl; do command -v $t >/dev/null 2>&1 && echo $t; done",
  "echo '## listening'; (ss -tlnH 2>/dev/null || netstat -tln 2>/dev/null) | head -20",
].join("; ");
