import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface Host {
  name: string;
  /** Hostname, IP, or an alias already defined in ~/.ssh/config. */
  hostname: string;
  user?: string;
  port?: number;
  identityFile?: string;
  /** ProxyJump target, e.g. "ec2-user@bastion.example.com". */
  jumpHost?: string;
  forwardAgent?: boolean;
  /** Remote shell wrapper. Default "bash -lc". */
  shell?: string;
  /** Default working directory for commands. */
  cwd?: string;
  env?: Record<string, string>;
  /** Extra raw ssh -o options. */
  options?: Record<string, string>;
  /** ControlPersist value for the multiplexed master. Default "10m". */
  controlPersist?: string;
  tags?: string[];
  description?: string;
  /** Local command that prints the sudo password (pass, op, vault, gpg). Preferred. */
  sudoPasswordCommand?: string;
  /** Name of an env var in this server's environment holding the sudo password. */
  sudoPasswordEnv?: string;
  /** Literal sudo password. Last resort; hosts.json is 0600 but still plaintext. */
  sudoPassword?: string;
}

export interface Job {
  id: string;
  host: string;
  command: string;
  pid: number;
  log: string;
  started: string;
}

interface Store {
  hosts: Host[];
  jobs: Job[];
  activeHost?: string;
}

const EMPTY: Store = { hosts: [], jobs: [] };

export function configDir(): string {
  if (process.env.CONNECT_MCP_HOME) return process.env.CONNECT_MCP_HOME;
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "connect-mcp");
}

function storePath() {
  return path.join(configDir(), "hosts.json");
}

export function load(): Store {
  try {
    const raw = fs.readFileSync(storePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Store>;
    return { hosts: parsed.hosts ?? [], jobs: parsed.jobs ?? [], activeHost: parsed.activeHost };
  } catch {
    return { ...EMPTY };
  }
}

export function save(store: Store): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function update<T>(fn: (store: Store) => T): T {
  const store = load();
  const out = fn(store);
  save(store);
  return out;
}

export function resolveHost(name?: string): Host {
  const store = load();
  if (!store.hosts.length) {
    throw new Error("No hosts registered. Add one with host_add (name, hostname, user).");
  }
  const wanted = name || store.activeHost;
  if (!wanted) {
    throw new Error(
      `No host selected. Known hosts: ${store.hosts.map((h) => h.name).join(", ")}. ` +
        "Pick one with host_use, or pass host explicitly.",
    );
  }
  const host = store.hosts.find((h) => h.name === wanted);
  if (!host) {
    throw new Error(`Unknown host "${wanted}". Known: ${store.hosts.map((h) => h.name).join(", ")}.`);
  }
  return host;
}

export function audit(entry: Record<string, unknown>): void {
  try {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, "audit.log"),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    /* auditing must never break a command */
  }
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Minimal ~/.ssh/config parser: concrete Host blocks only, wildcards skipped. */
export function parseSshConfig(text: string): Partial<Host>[] {
  const out: Partial<Host>[] = [];
  let cur: Partial<Host> | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z]+)[\s=]+(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "host") {
      const names = val.split(/\s+/).filter((n) => !n.includes("*") && !n.includes("?"));
      cur = names.length ? { name: names[0], hostname: names[0] } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (key === "hostname") cur.hostname = val;
    else if (key === "user") cur.user = val;
    else if (key === "port") cur.port = Number(val);
    else if (key === "identityfile") cur.identityFile = val;
    else if (key === "proxyjump") cur.jumpHost = val;
    else if (key === "forwardagent") cur.forwardAgent = /yes/i.test(val);
  }
  return out;
}
