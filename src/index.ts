#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Host,
  Job,
  audit,
  configDir,
  load,
  parseSshConfig,
  resolveHost,
  save,
  update,
} from "./config.js";
import {
  PROBE_SCRIPT,
  masterAlive,
  masterCtl,
  scpTransfer,
  shQuote,
  sshRun,
  target,
} from "./ssh.js";
import { clamp, renderRun } from "./format.js";
import { keyringForget, keyringStore, keyringStoreHint, sudoPasswordSource } from "./sudo.js";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

const REMOTE_STATE = ".connect-mcp";

function describeHost(h: Host, active?: string): string {
  const bits = [
    `${h.name === active ? "* " : "  "}${h.name}`,
    `${target(h)}${h.port ? `:${h.port}` : ""}`,
  ];
  if (h.jumpHost) bits.push(`via ${h.jumpHost}`);
  if (h.cwd) bits.push(`cwd ${h.cwd}`);
  if (h.tags?.length) bits.push(`tags: ${h.tags.join(",")}`);
  if (masterAlive(h)) bits.push("(connected)");
  if (h.description) bits.push(`- ${h.description}`);
  return bits.join(" ");
}

async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const server = new McpServer(
  { name: "connect-mcp", version: "0.1.0" },
  {
    instructions: [
      "Runs shell commands on remote machines over multiplexed SSH.",
      "Register hosts with host_add (or host_import from ~/.ssh/config), pick one with host_use,",
      "then use ssh_run. Every tool takes an optional host; it defaults to the selected one.",
      "Any command is allowed, including ones that change or remove things; the user approves each call",
      "through the client's own permission prompt. Still say what a command will do before running",
      "something the user cannot undo, and prefer the reversible version when there is one.",
      "Use ssh_job for anything long-running (builds, migrations, deploys) instead of a long timeout.",
    ].join(" "),
  },
);

server.registerTool(
  "host_add",
  {
    title: "Register a remote host",
    description:
      "Register a machine so it can be targeted by name (an EC2 box, a VPS, a bare-metal server, a Pi). " +
      "hostname can be an IP, a DNS name, or an alias already defined in ~/.ssh/config. " +
      "Auth uses the local ssh agent and keys; there is no password auth.",
    inputSchema: {
      name: z.string().describe("Short label used to target the host, e.g. \"prod-api\""),
      hostname: z.string().describe("IP, DNS name, or ~/.ssh/config alias"),
      user: z.string().optional().describe("SSH login user, e.g. ubuntu / ec2-user / root"),
      port: z.number().int().optional().describe("SSH port (default 22)"),
      identityFile: z.string().optional().describe("Private key path, e.g. ~/.ssh/prod.pem"),
      jumpHost: z.string().optional().describe("ProxyJump/bastion target, e.g. ec2-user@bastion.acme.io"),
      forwardAgent: z.boolean().optional().describe("Forward the local ssh agent (for git pulls on the remote)"),
      cwd: z.string().optional().describe("Default remote working directory, e.g. /srv/app"),
      shell: z.string().optional().describe('Remote shell wrapper, default "bash -lc"'),
      env: z.record(z.string(), z.string()).optional().describe("Env vars exported before every command"),
      options: z.record(z.string(), z.string()).optional().describe("Extra raw ssh -o options"),
      tags: z.array(z.string()).optional().describe("Labels for fan-out with ssh_run_many, e.g. [\"web\",\"prod\"]"),
      description: z.string().optional(),
      sudoPasswordCommand: z.string().optional().describe("Local command that prints the sudo password, e.g. \"pass show servers/prod\" or \"op read op://vault/prod/password\""),
      sudoPasswordEnv: z.string().optional().describe("Name of an env var holding the sudo password, e.g. \"PROD_SUDO_PW\""),
      test: z.boolean().optional().describe("Verify the connection now (default true)"),
      use: z.boolean().optional().describe("Make this the selected host (default true)"),
    },
  },
  async (a) => {
    const host: Host = {
      name: a.name,
      hostname: a.hostname,
      user: a.user,
      port: a.port,
      identityFile: a.identityFile,
      jumpHost: a.jumpHost,
      forwardAgent: a.forwardAgent,
      shell: a.shell,
      cwd: a.cwd,
      env: a.env,
      options: a.options,
      tags: a.tags,
      description: a.description,
      sudoPasswordCommand: a.sudoPasswordCommand,
      sudoPasswordEnv: a.sudoPasswordEnv,
    };
    update((store) => {
      store.hosts = store.hosts.filter((h) => h.name !== host.name).concat(host);
      if (a.use !== false) store.activeHost = host.name;
    });
    audit({ tool: "host_add", host: host.name, target: target(host) });

    let verdict = "not tested";
    if (a.test !== false) {
      const res = await sshRun(host, "echo connected", { timeoutMs: 20_000 });
      verdict =
        res.code === 0
          ? `connected in ${res.ms}ms (master socket open, later commands reuse it)`
          : `FAILED: ${(res.stderr || res.stdout).trim().split("\n").slice(0, 3).join(" | ") || `exit ${res.code}`}`;
    }
    return ok(
      `Registered "${host.name}" -> ${target(host)}${host.port ? `:${host.port}` : ""}\n` +
        `Connection: ${verdict}\n` +
        (a.use !== false ? `Selected "${host.name}" as the active host.` : ""),
    );
  },
);

server.registerTool(
  "host_list",
  {
    title: "List registered hosts",
    description: "List every registered host, which one is selected, and which already have a live multiplexed connection.",
    inputSchema: { tag: z.string().optional().describe("Only hosts carrying this tag") },
    annotations: { readOnlyHint: true },
  },
  async ({ tag }) => {
    const store = load();
    const hosts = tag ? store.hosts.filter((h) => h.tags?.includes(tag)) : store.hosts;
    if (!hosts.length) return ok("No hosts registered. Use host_add, or host_import to pull them from ~/.ssh/config.");
    return ok(
      `${hosts.length} host(s) (* = selected):\n` +
        hosts.map((h) => describeHost(h, store.activeHost)).join("\n") +
        `\n\nConfig: ${path.join(configDir(), "hosts.json")}`,
    );
  },
);

server.registerTool(
  "host_use",
  {
    title: "Select the active host",
    description:
      "Pick which registered host later tools target by default, and open the multiplexed connection to it now. " +
      "Ask the user which host to use when the request is ambiguous and more than one is registered.",
    inputSchema: { name: z.string().describe("Registered host name") },
  },
  async ({ name }) => {
    const host = resolveHost(name);
    update((store) => {
      store.activeHost = host.name;
    });
    const res = await sshRun(host, "echo ready; uptime", { timeoutMs: 20_000 });
    audit({ tool: "host_use", host: host.name });
    if (res.code !== 0) {
      return fail(`Selected "${host.name}" but the connection failed:\n${(res.stderr || res.stdout).trim()}`);
    }
    return ok(
      `Active host: ${host.name} (${target(host)}) - connected in ${res.ms}ms\n` +
        res.stdout.trim(),
    );
  },
);

server.registerTool(
  "host_remove",
  {
    title: "Remove a host",
    description: "Forget a registered host and close its multiplexed connection.",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    const host = resolveHost(name);
    if (masterAlive(host)) await masterCtl(host, "exit");
    update((store) => {
      store.hosts = store.hosts.filter((h) => h.name !== name);
      store.jobs = store.jobs.filter((j) => j.host !== name);
      if (store.activeHost === name) store.activeHost = store.hosts[0]?.name;
    });
    return ok(`Removed "${name}".`);
  },
);

server.registerTool(
  "host_import",
  {
    title: "Import hosts from ~/.ssh/config",
    description:
      "Read ~/.ssh/config and register its concrete Host entries (wildcards skipped). " +
      "Fastest way to make every machine the user already reaches by ssh available here.",
    inputSchema: {
      file: z.string().optional().describe("Config path (default ~/.ssh/config)"),
      dryRun: z.boolean().optional().describe("List what would be imported without saving"),
    },
  },
  async ({ file, dryRun }) => {
    const configPath = file ? file.replace(/^~/, os.homedir()) : path.join(os.homedir(), ".ssh", "config");
    let text: string;
    try {
      text = fs.readFileSync(configPath, "utf8");
    } catch (e) {
      return fail(`Cannot read ${configPath}: ${(e as Error).message}`);
    }
    const parsed = parseSshConfig(text).filter((h) => h.name && h.hostname);
    if (!parsed.length) return ok(`No concrete Host entries found in ${configPath}.`);
    const store = load();
    const existing = new Set(store.hosts.map((h) => h.name));
    const fresh = parsed.filter((h) => !existing.has(h.name!));
    if (dryRun) {
      return ok(
        `${configPath} has ${parsed.length} host(s), ${fresh.length} not yet registered:\n` +
          fresh.map((h) => `  ${h.name} -> ${h.user ? `${h.user}@` : ""}${h.hostname}`).join("\n"),
      );
    }
    const added = fresh.map((h) => ({ ...h }) as Host);
    store.hosts.push(...added);
    save(store);
    return ok(
      `Imported ${added.length} host(s):\n` + added.map((h) => `  ${h.name} -> ${target(h)}`).join("\n"),
    );
  },
);

server.registerTool(
  "host_status",
  {
    title: "Connection status and machine facts",
    description:
      "check: is the multiplexed connection open. open: establish it. close: tear it down. " +
      "probe: OS, kernel, cores, memory, disk, load, uptime, sudo, installed tooling, listening ports. " +
      "Run probe before touching an unfamiliar machine.",
    inputSchema: {
      host: z.string().optional(),
      action: z.enum(["check", "open", "close", "probe"]).optional().describe("Default probe"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ host, action }) => {
    const h = resolveHost(host);
    const act = action ?? "probe";
    if (act === "check") {
      const res = await masterCtl(h, "check");
      return ok(`${h.name}: ${res.code === 0 ? "connection open" : "no live connection"}\n${(res.stderr || res.stdout).trim()}`);
    }
    if (act === "close") {
      const res = await masterCtl(h, "exit");
      return ok(`${h.name}: ${res.code === 0 ? "connection closed" : "was not connected"}`);
    }
    if (act === "open") {
      const res = await sshRun(h, "echo up", { timeoutMs: 20_000 });
      return res.code === 0
        ? ok(`${h.name}: connected in ${res.ms}ms, socket persists for ${h.controlPersist ?? "10m"} of idle.`)
        : fail(renderRun(h.name, "echo up", res, 2000));
    }
    const res = await sshRun(h, PROBE_SCRIPT, { timeoutMs: 45_000 });
    return res.code === 0
      ? ok(`${h.name} (${target(h)}) in ${res.ms}ms\n\n${clamp(res.stdout.trim(), 6000)}`)
      : fail(renderRun(h.name, "probe", res, 3000));
  },
);

server.registerTool(
  "ssh_run",
  {
    title: "Run a command on a remote host",
    description:
      "Run any shell command on a registered host over the multiplexed connection (no per-command handshake). " +
      "Returns exit code, timing, stdout and stderr. Defaults to the selected host. " +
      "Nothing is filtered here: installs, restarts, deletes, migrations and root work via sudo all go through. " +
      "sudo: true works whether or not the host has passwordless sudo; a password-required host is handled " +
      "automatically once host_sudo knows where its password comes from. " +
      "For anything that outlives a request (builds, deploys, long installs) use ssh_job instead of a big timeout.",
    inputSchema: {
      command: z.string().describe("Shell command; pipes, &&, and here-strings are fine"),
      host: z.string().optional().describe("Registered host name (default: selected host)"),
      cwd: z.string().optional().describe("Remote working directory for this command"),
      env: z.record(z.string(), z.string()).optional(),
      timeout: z.number().int().min(1).max(1800).optional().describe("Seconds before the command is killed (default 60)"),
      sudo: z.boolean().optional().describe("Run the command as root. Handles both passwordless and password-required sudo"),
      stdin: z.string().optional().describe("Data piped to the command's stdin"),
      maxOutput: z.number().int().min(200).max(200_000).optional().describe("Character cap on returned output (default 20000)"),
      tty: z.boolean().optional().describe("Allocate a pseudo-terminal (for tools that insist on one)"),
    },
  },
  async (a) => {
    const h = resolveHost(a.host);
    const res = await sshRun(h, a.command, {
      cwd: a.cwd,
      env: a.env,
      timeoutMs: (a.timeout ?? 60) * 1000,
      sudo: a.sudo,
      stdin: a.stdin,
      tty: a.tty,
    });
    audit({ tool: "ssh_run", host: h.name, command: a.command, code: res.code, ms: res.ms });
    const text = renderRun(h.name, a.command, res, a.maxOutput ?? 20_000);
    return res.code === 0 ? ok(text) : fail(text);
  },
);

server.registerTool(
  "ssh_run_many",
  {
    title: "Run one command across several hosts",
    description:
      "Fan the same command out to several hosts at once, by name or by tag. " +
      "Use it to check a version, patch a config, or restart a service across a fleet.",
    inputSchema: {
      command: z.string(),
      hosts: z.array(z.string()).optional().describe("Host names. Omit to use tag, or all registered hosts"),
      tag: z.string().optional().describe("Target every host carrying this tag"),
      timeout: z.number().int().min(1).max(600).optional().describe("Per-host seconds (default 60)"),
      concurrency: z.number().int().min(1).max(32).optional().describe("Parallel connections (default 8)"),
      maxOutputPerHost: z.number().int().min(100).max(20_000).optional().describe("Default 3000"),
    },
  },
  async (a) => {
    const store = load();
    let targets: Host[];
    if (a.hosts?.length) targets = a.hosts.map((n) => resolveHost(n));
    else if (a.tag) targets = store.hosts.filter((h) => h.tags?.includes(a.tag!));
    else targets = store.hosts;
    if (!targets.length) return fail("No matching hosts.");

    const results = await pooled(targets, a.concurrency ?? 8, async (h) => {
      const res = await sshRun(h, a.command, { timeoutMs: (a.timeout ?? 60) * 1000 });
      audit({ tool: "ssh_run_many", host: h.name, command: a.command, code: res.code });
      return renderRun(h.name, a.command, res, a.maxOutputPerHost ?? 3000);
    });
    return ok(`${targets.length} host(s) | $ ${a.command}\n\n${results.join("\n\n")}`);
  },
);

server.registerTool(
  "ssh_read_file",
  {
    title: "Read a remote file",
    description: "Read a file from a remote host, optionally a line range. Use this instead of cat when you want the content back cleanly.",
    inputSchema: {
      path: z.string().describe("Absolute remote path, or relative to the host cwd"),
      host: z.string().optional(),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
      maxBytes: z.number().int().min(100).max(500_000).optional().describe("Default 60000"),
      sudo: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) => {
    const h = resolveHost(a.host);
    const cap = a.maxBytes ?? 60_000;
    const q = shQuote(a.path);
    const cmd =
      a.startLine || a.endLine
        ? `sed -n ${shQuote(`${a.startLine ?? 1},${a.endLine ?? "$"}p`)} ${q} | head -c ${cap}`
        : `head -c ${cap} ${q}`;
    const res = await sshRun(h, cmd, { sudo: a.sudo, timeoutMs: 60_000 });
    if (res.code !== 0) return fail(renderRun(h.name, cmd, res, 2000));
    const size = await sshRun(h, `wc -c < ${q} 2>/dev/null; wc -l < ${q} 2>/dev/null`, { sudo: a.sudo, timeoutMs: 30_000 });
    const [bytes, lines] = size.stdout.trim().split("\n");
    return ok(
      `${h.name}:${a.path} (${bytes ?? "?"} bytes, ${lines ?? "?"} lines)\n` +
        `--- content ---\n${res.stdout}` +
        (res.stdout.length >= cap ? `\n--- truncated at ${cap} bytes ---` : ""),
    );
  },
);

server.registerTool(
  "ssh_write_file",
  {
    title: "Write a remote file",
    description:
      "Write or append content to a file on a remote host, transferred base64-encoded so quoting and binary bytes survive. " +
      "Backs up an existing file by default. Ideal for nginx configs, systemd units, .env files. " +
      "Pair with sudo: true to write anywhere on the box.",
    inputSchema: {
      path: z.string().describe("Absolute remote path"),
      content: z.string(),
      host: z.string().optional(),
      append: z.boolean().optional().describe("Append instead of replacing"),
      mode: z.string().optional().describe("chmod value applied after write, e.g. \"600\""),
      makeDirs: z.boolean().optional().describe("mkdir -p the parent (default true)"),
      backup: z.boolean().optional().describe("Copy an existing file to <path>.bak-<epoch> first (default true)"),
      sudo: z.boolean().optional(),
    },
  },
  async (a) => {
    const h = resolveHost(a.host);
    const q = shQuote(a.path);
    const steps: string[] = [];
    if (a.makeDirs !== false) steps.push(`mkdir -p ${shQuote(path.posix.dirname(a.path))}`);
    if (a.backup !== false && !a.append) steps.push(`{ [ -f ${q} ] && cp -p ${q} ${q}.bak-$(date +%s) || true; }`);
    steps.push(`base64 -d ${a.append ? ">>" : ">"} ${q}`);
    if (a.mode) steps.push(`chmod ${a.mode} ${q}`);
    steps.push(`wc -c < ${q}`);
    const cmd = steps.join(" && ");
    const res = await sshRun(h, cmd, {
      stdin: Buffer.from(a.content, "utf8").toString("base64"),
      sudo: a.sudo,
      timeoutMs: 120_000,
    });
    audit({ tool: "ssh_write_file", host: h.name, path: a.path, bytes: a.content.length, code: res.code });
    if (res.code !== 0) return fail(renderRun(h.name, `write ${a.path}`, res, 2000));
    return ok(
      `${a.append ? "Appended to" : "Wrote"} ${h.name}:${a.path} (${a.content.length} bytes sent, file now ${res.stdout.trim()} bytes)` +
        (a.mode ? `, mode ${a.mode}` : "") +
        (a.backup !== false && !a.append ? "\nPrevious version saved as <path>.bak-<epoch> if one existed." : ""),
    );
  },
);

server.registerTool(
  "ssh_transfer",
  {
    title: "Copy files to or from a host",
    description:
      "scp a file or directory over the multiplexed connection. direction \"up\" sends local -> remote, \"down\" pulls remote -> local. " +
      "Use it for build artifacts, dumps, log bundles, certificates.",
    inputSchema: {
      direction: z.enum(["up", "down"]),
      localPath: z.string(),
      remotePath: z.string(),
      host: z.string().optional(),
      recursive: z.boolean().optional().describe("Needed for directories"),
      timeout: z.number().int().min(5).max(3600).optional().describe("Seconds (default 300)"),
    },
  },
  async (a) => {
    const h = resolveHost(a.host);
    const res = await scpTransfer(h, a.localPath, a.remotePath, a.direction, a.recursive ?? false, (a.timeout ?? 300) * 1000);
    audit({ tool: "ssh_transfer", host: h.name, direction: a.direction, localPath: a.localPath, remotePath: a.remotePath, code: res.code });
    const arrow = a.direction === "up" ? `${a.localPath} -> ${h.name}:${a.remotePath}` : `${h.name}:${a.remotePath} -> ${a.localPath}`;
    return res.code === 0
      ? ok(`Copied ${arrow} in ${res.ms}ms`)
      : fail(renderRun(h.name, `scp ${arrow}`, res, 3000));
  },
);

const forwards = new Map<string, { host: string; spec: string }>();

server.registerTool(
  "ssh_forward",
  {
    title: "Port forward over the existing connection",
    description:
      "Tunnel a remote port to localhost through the already-open multiplexed connection, so a remote app, database, or admin UI " +
      "can be reached locally (e.g. a staging Postgres on 5432, or a service on 3000). Forwards last as long as the connection does.",
    inputSchema: {
      action: z.enum(["start", "stop", "list"]),
      host: z.string().optional(),
      localPort: z.number().int().min(1).max(65535).optional(),
      remotePort: z.number().int().min(1).max(65535).optional(),
      remoteHost: z.string().optional().describe("Host as seen from the remote side (default localhost)"),
    },
  },
  async (a) => {
    if (a.action === "list") {
      if (!forwards.size) return ok("No forwards opened in this session.");
      return ok(
        [...forwards.entries()].map(([k, v]) => `${k}  ${v.host}  -L ${v.spec}`).join("\n"),
      );
    }
    const h = resolveHost(a.host);
    if (!a.localPort || !a.remotePort) return fail("localPort and remotePort are required.");
    const spec = `${a.localPort}:${a.remoteHost ?? "localhost"}:${a.remotePort}`;
    if (!masterAlive(h)) {
      const open = await sshRun(h, "echo up", { timeoutMs: 20_000 });
      if (open.code !== 0) return fail(renderRun(h.name, "open connection", open, 2000));
    }
    const res = await masterCtl(h, a.action === "start" ? "forward" : "cancel", ["-L", spec]);
    const key = `${h.name}:${spec}`;
    if (res.code === 0) {
      if (a.action === "start") forwards.set(key, { host: h.name, spec });
      else forwards.delete(key);
    }
    audit({ tool: "ssh_forward", host: h.name, action: a.action, spec, code: res.code });
    return res.code === 0
      ? ok(
          a.action === "start"
            ? `Forwarding localhost:${a.localPort} -> ${h.name}:${a.remoteHost ?? "localhost"}:${a.remotePort}`
            : `Cancelled forward ${spec} on ${h.name}`,
        )
      : fail(`ssh -O ${a.action === "start" ? "forward" : "cancel"} failed: ${(res.stderr || res.stdout).trim()}`);
  },
);

server.registerTool(
  "ssh_job",
  {
    title: "Long-running remote jobs",
    description:
      "start: launch a command detached on the remote host (survives the connection dropping), logging to a file, and get a job id back. " +
      "logs: tail that log. list: show known jobs and whether they are still alive. stop: signal the job's process group. " +
      "This is the right tool for deploys, builds, migrations, dumps, and anything else that takes minutes.",
    inputSchema: {
      action: z.enum(["start", "logs", "list", "stop"]),
      host: z.string().optional(),
      command: z.string().optional().describe("Required for start"),
      id: z.string().optional().describe("Job id, for logs and stop"),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      lines: z.number().int().min(1).max(2000).optional().describe("Log lines to tail (default 100)"),
    },
  },
  async (a) => {
    const store = load();

    if (a.action === "list") {
      const jobs = a.host ? store.jobs.filter((j) => j.host === a.host) : store.jobs;
      if (!jobs.length) return ok("No jobs recorded.");
      const byHost = new Map<string, Job[]>();
      for (const j of jobs) byHost.set(j.host, [...(byHost.get(j.host) ?? []), j]);
      const lines: string[] = [];
      for (const [hostName, hostJobs] of byHost) {
        let alive = new Set<string>();
        try {
          const h = resolveHost(hostName);
          const probe = await sshRun(
            h,
            hostJobs.map((j) => `kill -0 ${j.pid} 2>/dev/null && echo ${j.id}`).join("; "),
            { timeoutMs: 30_000 },
          );
          alive = new Set(probe.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
        } catch {
          /* host may have been removed */
        }
        for (const j of hostJobs) {
          lines.push(`${j.id}  ${j.host}  pid ${j.pid}  ${alive.has(j.id) ? "RUNNING" : "finished/unknown"}  started ${j.started}\n     $ ${j.command}`);
        }
      }
      return ok(lines.join("\n"));
    }

    if (a.action === "start") {
      if (!a.command) return fail("command is required for start.");
      const h = resolveHost(a.host);
      const id = "j" + crypto.randomBytes(3).toString("hex");
      const log = `$HOME/${REMOTE_STATE}/${id}.log`;
      const inner = `${h.shell ?? "bash -lc"} ${shQuote(a.command)}`;
      const launch =
        `mkdir -p $HOME/${REMOTE_STATE} && ` +
        `{ setsid nohup ${inner} > ${log} 2>&1 < /dev/null & echo $!; }`;
      const res = await sshRun(h, launch, { cwd: a.cwd, env: a.env, timeoutMs: 30_000 });
      const pid = Number(res.stdout.trim().split("\n").pop());
      if (res.code !== 0 || !Number.isFinite(pid) || pid <= 0) {
        return fail(renderRun(h.name, "job start", res, 3000));
      }
      const job: Job = { id, host: h.name, command: a.command, pid, log, started: new Date().toISOString() };
      update((s) => {
        s.jobs.push(job);
      });
      audit({ tool: "ssh_job", action: "start", host: h.name, id, pid, command: a.command });
      return ok(
        `Started job ${id} on ${h.name} (pid ${pid}, detached)\n$ ${a.command}\n` +
          `Log: ${log}\nTail it with ssh_job action "logs", id "${id}".`,
      );
    }

    if (!a.id) return fail("id is required for logs and stop.");
    const job = store.jobs.find((j) => j.id === a.id);
    if (!job) return fail(`Unknown job "${a.id}". Use action "list".`);
    const h = resolveHost(job.host);

    if (a.action === "logs") {
      const res = await sshRun(
        h,
        `kill -0 ${job.pid} 2>/dev/null && echo "STATE: running" || echo "STATE: not running"; tail -n ${a.lines ?? 100} ${job.log}`,
        { timeoutMs: 60_000 },
      );
      return res.code === 0
        ? ok(`Job ${job.id} on ${job.host} - $ ${job.command}\n${clamp(res.stdout.trimEnd(), 20_000)}`)
        : fail(renderRun(h.name, `tail ${job.log}`, res, 2000));
    }

    const res = await sshRun(h, `kill -TERM -${job.pid} 2>/dev/null || kill -TERM ${job.pid}`, { timeoutMs: 30_000 });
    audit({ tool: "ssh_job", action: "stop", host: h.name, id: job.id, code: res.code });
    if (res.code === 0) {
      update((s) => {
        s.jobs = s.jobs.filter((j) => j.id !== job.id);
      });
      return ok(`Signalled job ${job.id} (pid ${job.pid}) on ${job.host}. Log kept at ${job.log}.`);
    }
    return fail(renderRun(h.name, `stop ${job.id}`, res, 2000));
  },
);

server.registerTool(
  "host_sudo",
  {
    title: "Sudo access for a host",
    description:
      "check: report whether sudo works on the host, as which uid, and where its password comes from. " +
      "store: save a sudo password into the OS keyring for this host. " +
      "forget: delete it. " +
      "A host with passwordless sudo needs none of this. For one that prompts, point it at a password source and " +
      "sudo: true then works everywhere, including ssh_write_file and ssh_job. " +
      "Prefer sudoPasswordCommand on host_add (pass, 1Password, vault) or the terminal command that check prints, " +
      "so the password never passes through a conversation at all.",
    inputSchema: {
      action: z.enum(["check", "store", "forget"]).optional().describe("Default check"),
      host: z.string().optional(),
      password: z.string().optional().describe("Only for store. This value passes through the conversation, so prefer the terminal command that check prints"),
    },
  },
  async ({ action, host, password }) => {
    const h = resolveHost(host);
    const act = action ?? "check";

    if (act === "forget") {
      const err = await keyringForget(h.name);
      return ok(`Cleared any keyring entry and cached password for "${h.name}"${err ? ` (${err})` : ""}.`);
    }

    if (act === "store") {
      if (!password) {
        return fail(
          `password is required for store. To keep it out of this conversation entirely, run this in a terminal instead:\n\n  ${keyringStoreHint(h.name)}\n\nThen run host_sudo check.`,
        );
      }
      const err = await keyringStore(h.name, password);
      if (err) return fail(`Could not write to the OS keyring: ${err}`);
      const probe = await sshRun(h, "id -un", { sudo: true, timeoutMs: 45_000 });
      audit({ tool: "host_sudo", action: "store", host: h.name, verified: probe.code === 0 });
      return probe.code === 0
        ? ok(`Stored the sudo password for "${h.name}" in the OS keyring and verified it: sudo runs as ${probe.stdout.trim()}.`)
        : fail(`Stored it, but sudo still failed:\n${renderRun(h.name, "sudo id -un", probe, 2000)}`);
    }

    const source = await sudoPasswordSource(h);
    const passwordless = await sshRun(h, "sudo -n true 2>&1 && echo PASSWORDLESS || echo PROMPTS", {});
    const probe = await sshRun(h, "id -un; id -u", { sudo: true, timeoutMs: 45_000 });
    const lines = [
      `Host: ${h.name} (${target(h)})`,
      `sudo without a password: ${/PASSWORDLESS/.test(probe.stdout) || /PASSWORDLESS/.test(passwordless.stdout) ? "yes" : "no, it prompts"}`,
      `password source: ${source}`,
      probe.code === 0
        ? `sudo works: runs as ${probe.stdout.trim().split("\n").join(" uid=")}`
        : `sudo FAILED: ${(probe.stderr || probe.stdout).trim().split("\n").slice(0, 3).join(" | ")}`,
    ];
    if (probe.code !== 0) {
      lines.push(
        "",
        "To give this host a password without putting it in a transcript, run in a terminal:",
        `  ${keyringStoreHint(h.name)}`,
        "",
        "Or re-register the host with sudoPasswordCommand (pass/1Password/vault) or sudoPasswordEnv.",
      );
    }
    audit({ tool: "host_sudo", action: "check", host: h.name, works: probe.code === 0 });
    return probe.code === 0 ? ok(lines.join("\n")) : fail(lines.join("\n"));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
