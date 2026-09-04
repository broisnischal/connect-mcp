import { spawn } from "node:child_process";
import os from "node:os";
import { Host } from "./config.js";

/**
 * Where a host's sudo password comes from, in priority order:
 *
 *   1. sudoPasswordCommand  any local command that prints it (pass, op, vault, gpg)
 *   2. sudoPasswordEnv      the name of an env var holding it
 *   3. the OS keyring       libsecret on Linux, Keychain on macOS
 *   4. sudoPassword         literal, in hosts.json (0600). Last resort.
 *
 * Resolved values are cached for the life of the process and never written to
 * disk by this server.
 */

const cache = new Map<string, string>();
const KEYRING_SERVICE = "connect-mcp";

function runLocal(cmd: string, args: string[], stdin?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", (e) => resolve({ code: null, out, err: err + e.message }));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(stdin ?? "");
  });
}

export function keyringBackend(): "libsecret" | "keychain" | null {
  if (os.platform() === "darwin") return "keychain";
  if (os.platform() === "linux") return "libsecret";
  return null;
}

/** The command a person can run in their own terminal, so the password never enters a transcript. */
export function keyringStoreHint(hostName: string): string {
  switch (keyringBackend()) {
    case "libsecret":
      return `secret-tool store --label='connect-mcp sudo (${hostName})' service ${KEYRING_SERVICE} account ${hostName}`;
    case "keychain":
      return `security add-generic-password -U -s ${KEYRING_SERVICE} -a ${hostName} -w`;
    default:
      return "(no OS keyring on this platform: use sudoPasswordCommand or sudoPasswordEnv instead)";
  }
}

async function keyringLookup(hostName: string): Promise<string | undefined> {
  const backend = keyringBackend();
  if (!backend) return undefined;
  const res =
    backend === "libsecret"
      ? await runLocal("secret-tool", ["lookup", "service", KEYRING_SERVICE, "account", hostName])
      : await runLocal("security", ["find-generic-password", "-s", KEYRING_SERVICE, "-a", hostName, "-w"]);
  if (res.code !== 0) return undefined;
  const pw = res.out.replace(/\n$/, "");
  return pw || undefined;
}

export async function keyringStore(hostName: string, password: string): Promise<string | null> {
  const backend = keyringBackend();
  if (!backend) return "No OS keyring available on this platform.";
  const res =
    backend === "libsecret"
      ? await runLocal(
          "secret-tool",
          ["store", "--label", `connect-mcp sudo (${hostName})`, "service", KEYRING_SERVICE, "account", hostName],
          password,
        )
      : await runLocal("security", ["add-generic-password", "-U", "-s", KEYRING_SERVICE, "-a", hostName, "-w", password]);
  if (res.code !== 0) return res.err.trim() || `keyring write failed (exit ${res.code})`;
  cache.set(hostName, password);
  return null;
}

export async function keyringForget(hostName: string): Promise<string | null> {
  cache.delete(hostName);
  const backend = keyringBackend();
  if (!backend) return null;
  const res =
    backend === "libsecret"
      ? await runLocal("secret-tool", ["clear", "service", KEYRING_SERVICE, "account", hostName])
      : await runLocal("security", ["delete-generic-password", "-s", KEYRING_SERVICE, "-a", hostName]);
  return res.code === 0 ? null : res.err.trim() || "nothing stored";
}

export async function resolveSudoPassword(host: Host): Promise<string | undefined> {
  const hit = cache.get(host.name);
  if (hit) return hit;

  if (host.sudoPasswordCommand) {
    const res = await runLocal("/bin/sh", ["-c", host.sudoPasswordCommand]);
    const pw = res.out.replace(/\n$/, "");
    if (res.code === 0 && pw) {
      cache.set(host.name, pw);
      return pw;
    }
  }
  if (host.sudoPasswordEnv) {
    const pw = process.env[host.sudoPasswordEnv];
    if (pw) {
      cache.set(host.name, pw);
      return pw;
    }
  }
  const fromKeyring = await keyringLookup(host.name);
  if (fromKeyring) {
    cache.set(host.name, fromKeyring);
    return fromKeyring;
  }
  if (host.sudoPassword) {
    cache.set(host.name, host.sudoPassword);
    return host.sudoPassword;
  }
  return undefined;
}

/** Which source would be used, for reporting without revealing the value. */
export async function sudoPasswordSource(host: Host): Promise<string> {
  if (host.sudoPasswordCommand) {
    const res = await runLocal("/bin/sh", ["-c", host.sudoPasswordCommand]);
    if (res.code === 0 && res.out.trim()) return `sudoPasswordCommand (${host.sudoPasswordCommand})`;
    return `sudoPasswordCommand FAILED: ${res.err.trim() || `exit ${res.code}`}`;
  }
  if (host.sudoPasswordEnv) {
    return process.env[host.sudoPasswordEnv]
      ? `sudoPasswordEnv ${host.sudoPasswordEnv}`
      : `sudoPasswordEnv ${host.sudoPasswordEnv} is not set in this server's environment`;
  }
  if (await keyringLookup(host.name)) return `OS keyring (${keyringBackend()})`;
  if (host.sudoPassword) return "sudoPassword literal in hosts.json";
  return "none configured";
}

export function forgetCached(hostName: string): void {
  cache.delete(hostName);
}

/** sudo said it wants a password rather than failing for some other reason. */
export function needsPassword(stderr: string): boolean {
  return /sudo:\s*a (password|terminal) is required|no askpass program|no tty present/i.test(stderr);
}

export function wrongPassword(stderr: string): boolean {
  return /sorry, try again|incorrect password attempt/i.test(stderr);
}

export function requiresTty(stderr: string): boolean {
  return /you must have a tty to run sudo|no tty present and no askpass/i.test(stderr);
}
