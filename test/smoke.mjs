#!/usr/bin/env node
/**
 * End-to-end smoke test. Needs an sshd this machine can reach with key auth;
 * defaults to localhost. Override with SMOKE_HOST / SMOKE_USER.
 *
 *   npm run build && node test/smoke.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HOSTNAME = process.env.SMOKE_HOST || "localhost";
const USER = process.env.SMOKE_USER || os.userInfo().username;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "connect-mcp-smoke-"));
const REMOTE_DIR = "/tmp/connect-mcp-smoke";

let pass = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `\n       ${detail.split("\n").slice(0, 6).join("\n       ")}` : ""}`);
  }
}

const client = new Client({ name: "connect-mcp-smoke", version: "0.1.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "dist", "index.js")],
    env: { ...process.env, CONNECT_MCP_HOME: HOME, FAKE_SUDO_PW: "s3cret-pw", FAKE_SUDO_PW_BAD: "wrong-pw" },
    stderr: "inherit",
  }),
);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { text: res.content.map((c) => c.text ?? "").join("\n"), isError: !!res.isError };
};

console.log(`\nconnect-mcp smoke test -> ${USER}@${HOSTNAME}  (state in ${HOME})\n`);

const { tools } = await client.listTools();
check("tools/list returns the full tool set", tools.length === 14, `got ${tools.length}: ${tools.map((t) => t.name).join(", ")}`);
check("every tool has a description", tools.every((t) => t.description?.length > 40));

console.log("\nhosts");
let r = await call("host_add", { name: "rw", hostname: HOSTNAME, user: USER });
check("host_add connects", !r.isError && /Connection: connected/.test(r.text), r.text);
r = await call("host_add", { name: "alt", hostname: HOSTNAME, user: USER, use: false, tags: ["fleet"] });
check("host_add a second host without selecting it", !r.isError, r.text);
r = await call("host_list");
check("host_list marks the active host", /\* rw/.test(r.text) && /  alt/.test(r.text), r.text);
r = await call("host_use", { name: "rw" });
check("host_use selects and connects", !r.isError && /Active host: rw/.test(r.text), r.text);
r = await call("host_status", { action: "check" });
check("multiplexed connection is open", /connection open/.test(r.text), r.text);
r = await call("host_status", { action: "probe" });
check("probe reports identity and listening ports", /## identity/.test(r.text) && /## listening/.test(r.text), r.text);
const fakeSshConfig = path.join(HOME, "ssh_config");
fs.writeFileSync(
  fakeSshConfig,
  ["Host *", "  ServerAliveInterval 30", "", "Host bastion", `  HostName ${HOSTNAME}`, "  User ubuntu", "  Port 2222",
   "", "Host behind-bastion", "  HostName 10.0.1.7", "  User ec2-user", "  ProxyJump bastion", "  IdentityFile ~/.ssh/prod.pem", ""].join("\n"),
);
r = await call("host_import", { file: fakeSshConfig, dryRun: true });
check("host_import dry run lists entries and skips wildcards", /bastion/.test(r.text) && /behind-bastion/.test(r.text) && !/Host \*/.test(r.text), r.text);
r = await call("host_import", { file: fakeSshConfig });
check("host_import registers both entries", /Imported 2 host\(s\)/.test(r.text), r.text);
r = await call("host_list");
check("imported host keeps its ProxyJump", /behind-bastion.*via bastion/.test(r.text), r.text);
await call("host_remove", { name: "bastion" });
await call("host_remove", { name: "behind-bastion" });
await call("host_use", { name: "rw" });

console.log("\ncommands");
r = await call("ssh_run", { command: "echo hello && pwd" });
check("ssh_run returns stdout and exit 0", /exit 0/.test(r.text) && /hello/.test(r.text), r.text);
const timed = [];
for (let i = 0; i < 3; i++) {
  const res = await call("ssh_run", { command: "true" });
  timed.push(Number(res.text.match(/in (\d+)ms/)?.[1] ?? 99999));
}
check(`reused connection is fast (${timed.join("ms, ")}ms)`, Math.min(...timed) < 300, `timings: ${timed}`);
r = await call("ssh_run", { command: "cat", stdin: "piped-in\n" });
check("stdin reaches the remote command", /piped-in/.test(r.text), r.text);
r = await call("ssh_run", { command: "pwd", cwd: "/etc" });
check("cwd is honoured", /^\/etc$/m.test(r.text), r.text);
r = await call("ssh_run", { command: "echo $SMOKE_VAR", env: { SMOKE_VAR: "from-env" } });
check("env is exported", /from-env/.test(r.text), r.text);
r = await call("ssh_run", { command: "exit 3" });
check("non-zero exit is reported as an error", r.isError && /exit 3/.test(r.text), r.text);
r = await call("ssh_run", { command: "echo before-sleep; sleep 30", timeout: 2 });
check("timeout kills the command and keeps partial output", /TIMED OUT/.test(r.text) && /before-sleep/.test(r.text), r.text);
r = await call("ssh_run", { command: "pgrep -x sleep -a | grep -c 'sleep 30$' || true" });
check("timeout reaps the process on the remote side too", /^0$/m.test(r.text), r.text);
r = await call("ssh_run", { command: "for i in $(seq 1 4000); do echo line-$i-padding-padding; done", maxOutput: 1200 });
check("output is clamped", /chars trimmed of/.test(r.text) && r.text.length < 3000, `len=${r.text.length}`);

console.log("\nnothing is blocked");
r = await call("ssh_run", { command: "mkdir -p /tmp/connect-mcp-nuke/a/b && touch /tmp/connect-mcp-nuke/a/b/f" });
check("setup a throwaway tree", !r.isError, r.text);
r = await call("ssh_run", { command: "rm -rf /tmp/connect-mcp-nuke" });
check("recursive delete runs with no confirmation step", !r.isError && /exit 0/.test(r.text), r.text);
r = await call("ssh_run", { command: "test -d /tmp/connect-mcp-nuke && echo STILL || echo GONE" });
check("the delete actually happened", /GONE/.test(r.text), r.text);
r = await call("ssh_run", { command: "echo redirected > /tmp/connect-mcp-redirect && cat /tmp/connect-mcp-redirect" });
check("output redirects run", /redirected/.test(r.text), r.text);
r = await call("ssh_run", { command: "printf 'a\\n' > /tmp/connect-mcp-sed && sed -i s/a/b/ /tmp/connect-mcp-sed && cat /tmp/connect-mcp-sed" });
check("sed -i runs", /^b$/m.test(r.text), r.text);
r = await call("ssh_run", { command: "systemctl stop definitely-not-a-real-unit-xyz 2>&1 || true" });
check("a service stop reaches systemctl instead of being refused", /not.?loaded|not found|Failed|Unit|authentication/i.test(r.text), r.text);
r = await call("ssh_run", { command: "docker rm -f definitely-not-a-real-container-xyz 2>&1 || true" });
check("docker rm reaches docker", !/read-only|Blocked/.test(r.text), r.text);
r = await call("ssh_run", { host: "alt", command: "touch /tmp/connect-mcp-alt-write && rm /tmp/connect-mcp-alt-write" });
check("the second host writes too, no mode to promote", !r.isError, r.text);
r = await call("ssh_write_file", { host: "alt", path: "/tmp/connect-mcp-alt.txt", content: "written\n" });
check("file writes work on any host", !r.isError, r.text);
const sudoProbe = await call("ssh_run", { command: "sudo -n true 2>/dev/null && echo YES || echo NO" });
if (/YES/.test(sudoProbe.text)) {
  r = await call("ssh_run", { command: "id -u", sudo: true });
  check("sudo: true runs as root", /^0$/m.test(r.text), r.text);
} else {
  console.log("  skip passwordless sudo is not configured for this user");
}
await call("ssh_run", { command: "rm -f /tmp/connect-mcp-redirect /tmp/connect-mcp-sed /tmp/connect-mcp-alt.txt" });

console.log("\nsudo");
r = await call("host_sudo", { action: "check" });
check("host_sudo check reports passwordless sudo on this box", !r.isError && /sudo without a password: yes/.test(r.text), r.text);
check("host_sudo check reports the uid", /runs as root uid=0|runs as \w+ uid=\d+/.test(r.text), r.text);

// A sudo that actually demands a password, so the prime-and-retry path is exercised
// for real. PATH is pointed at the shim per host, nothing on this machine changes.
const SHIM = "/tmp/connect-mcp-fakesudo";
const FAKE_PATH = `${SHIM}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const shim = [
  "#!/bin/sh",
  `DIR=${SHIM}`,
  "TICKET=$DIR/ticket",
  "EXPECTED=$(cat $DIR/expected)",
  "MODE=none; VALIDATE=0",
  "while [ $# -gt 0 ]; do",
  "  case \"$1\" in",
  "    -n) MODE=n; shift ;;",
  "    -S) MODE=S; shift ;;",
  "    -p) shift 2 ;;",
  "    -v) VALIDATE=1; shift ;;",
  "    --) shift; break ;;",
  "    -*) shift ;;",
  "    *) break ;;",
  "  esac",
  "done",
  'if [ "$MODE" = S ]; then',
  "  read -r pw",
  '  if [ "$pw" != "$EXPECTED" ]; then echo "Sorry, try again." >&2; exit 1; fi',
  "  [ -f $DIR/nocache ] || : > $TICKET",
  '  [ "$VALIDATE" = 1 ] && exit 0',
  '  exec "$@"',
  "fi",
  "if [ -f $TICKET ]; then",
  '  [ "$VALIDATE" = 1 ] && exit 0',
  '  exec "$@"',
  "fi",
  'echo "sudo: a password is required" >&2',
  "exit 1",
  "",
].join("\n");
await call("ssh_run", { command: `mkdir -p ${SHIM} && printf 's3cret-pw' > ${SHIM}/expected && rm -f ${SHIM}/ticket ${SHIM}/nocache` });
r = await call("ssh_write_file", { path: `${SHIM}/sudo`, content: shim, mode: "755" });
check("shim installed", !r.isError, r.text);

r = await call("host_add", { name: "pwsudo", hostname: HOSTNAME, user: USER, use: false, env: { PATH: FAKE_PATH }, sudoPasswordEnv: "FAKE_SUDO_PW" });
check("register a host whose sudo prompts", !r.isError, r.text);
r = await call("host_add", { name: "pwsudo-bad", hostname: HOSTNAME, user: USER, use: false, env: { PATH: FAKE_PATH }, sudoPasswordEnv: "FAKE_SUDO_PW_BAD" });
check("register the same host with a wrong password", !r.isError, r.text);
r = await call("host_add", { name: "pwsudo-none", hostname: HOSTNAME, user: USER, use: false, env: { PATH: FAKE_PATH } });
check("register it again with no password source", !r.isError, r.text);

r = await call("ssh_run", { host: "pwsudo-none", command: "id -un", sudo: true });
check("no password source: fails with a clear message", r.isError && /password is required/.test(r.text), r.text);
check("no password source: hint points at host_sudo", /host_sudo/.test(r.text), r.text);

r = await call("ssh_run", { host: "pwsudo-bad", command: "id -un", sudo: true });
check("wrong password is reported as rejected, not as a generic failure", r.isError && /rejected the stored password/.test(r.text), r.text);

r = await call("ssh_run", { host: "pwsudo", command: "id -un", sudo: true });
check("correct password: sudo runs after priming", !r.isError && /exit 0/.test(r.text), r.text);
r = await call("ssh_run", { host: "pwsudo", command: "test -f /tmp/connect-mcp-fakesudo/ticket && echo TICKET" });
check("the ticket was primed on its own connection", /TICKET/.test(r.text), r.text);
r = await call("ssh_run", { host: "pwsudo", command: "echo cached", sudo: true });
check("a second sudo call reuses the cached ticket", !r.isError && /cached/.test(r.text), r.text);

r = await call("ssh_write_file", { host: "pwsudo", path: `${SHIM}/written-under-sudo.txt`, content: "quoted ' and $dollar\n", sudo: true, backup: false });
check("stdin data survives a password-required sudo write", !r.isError, r.text);
r = await call("ssh_read_file", { host: "pwsudo", path: `${SHIM}/written-under-sudo.txt` });
check("the written bytes are exact", /quoted ' and \$dollar/.test(r.text), r.text);

await call("ssh_run", { command: `rm -f ${SHIM}/ticket && touch ${SHIM}/nocache` });
r = await call("ssh_run", { host: "pwsudo", command: "echo hardened", sudo: true });
check("sudoers that never caches falls back to feeding the password directly", !r.isError && /hardened/.test(r.text), r.text);
await call("ssh_run", { command: `rm -rf ${SHIM}` });
for (const n of ["pwsudo", "pwsudo-bad", "pwsudo-none"]) await call("host_remove", { name: n });
await call("host_use", { name: "rw" });

console.log("\nfiles");
await call("ssh_run", { command: `mkdir -p ${REMOTE_DIR}` });
const body = "line one\nline two\nquotes ' \" $HOME `backtick`\nline four\n";
r = await call("ssh_write_file", { path: `${REMOTE_DIR}/hello.txt`, content: body, mode: "600" });
check("ssh_write_file writes exact bytes", !r.isError && new RegExp(`file now ${Buffer.byteLength(body)} bytes`).test(r.text), r.text);
r = await call("ssh_read_file", { path: `${REMOTE_DIR}/hello.txt` });
check("ssh_read_file round-trips tricky quoting", r.text.includes("quotes ' \" $HOME `backtick`"), r.text);
r = await call("ssh_read_file", { path: `${REMOTE_DIR}/hello.txt`, startLine: 2, endLine: 2 });
check("ssh_read_file honours a line range", /line two/.test(r.text) && !/line four/.test(r.text), r.text);
r = await call("ssh_write_file", { path: `${REMOTE_DIR}/hello.txt`, content: "appended\n", append: true });
check("ssh_write_file appends", !r.isError, r.text);
r = await call("ssh_write_file", { path: `${REMOTE_DIR}/hello.txt`, content: "replaced\n" });
check("ssh_write_file replaces", !r.isError, r.text);
r = await call("ssh_run", { command: `ls ${REMOTE_DIR} | grep -c 'bak-'` });
check("a backup of the replaced file exists", /exit 0/.test(r.text) && !/^0$/m.test(r.text), r.text);

const localFile = path.join(HOME, "upload.txt");
fs.writeFileSync(localFile, "uploaded payload\n");
r = await call("ssh_transfer", { direction: "up", localPath: localFile, remotePath: `${REMOTE_DIR}/uploaded.txt` });
check("ssh_transfer up", !r.isError, r.text);
r = await call("ssh_transfer", { direction: "down", remotePath: `${REMOTE_DIR}/uploaded.txt`, localPath: path.join(HOME, "back.txt") });
check("ssh_transfer down", !r.isError && fs.readFileSync(path.join(HOME, "back.txt"), "utf8") === "uploaded payload\n", r.text);
r = await call("ssh_transfer", { host: "alt", direction: "up", localPath: localFile, remotePath: `${REMOTE_DIR}/alt.txt` });
check("uploads work on any host", !r.isError, r.text);

console.log("\njobs");
r = await call("ssh_job", { action: "start", command: "echo job-started; sleep 4; echo job-finished" });
const jobId = r.text.match(/Started job (\w+)/)?.[1];
check("ssh_job start returns an id and pid", !!jobId && /pid \d+/.test(r.text), r.text);
await new Promise((res) => setTimeout(res, 1500));
r = await call("ssh_job", { action: "logs", id: jobId });
check("ssh_job logs shows running state and output", /STATE: running/.test(r.text) && /job-started/.test(r.text), r.text);
r = await call("ssh_job", { action: "list" });
check("ssh_job list marks it RUNNING", /RUNNING/.test(r.text), r.text);
await new Promise((res) => setTimeout(res, 3500));
r = await call("ssh_job", { action: "logs", id: jobId });
check("job ran to completion after the call returned", /job-finished/.test(r.text) && /STATE: not running/.test(r.text), r.text);
r = await call("ssh_job", { action: "start", command: "sleep 300" });
const longJob = r.text.match(/Started job (\w+)/)?.[1];
const longPid = r.text.match(/pid (\d+)/)?.[1];
r = await call("ssh_job", { action: "stop", id: longJob });
check("ssh_job stop signals the process group", !r.isError && /Signalled/.test(r.text), r.text);
r = await call("ssh_run", { command: `kill -0 ${longPid} 2>/dev/null && echo ALIVE || echo GONE` });
check("stopped job's process is gone", /GONE/.test(r.text), r.text);

console.log("\nfan-out and forwards");
r = await call("ssh_run_many", { hosts: ["rw", "alt"], command: "hostname" });
check("ssh_run_many hits both hosts", /\[rw\]/.test(r.text) && /\[alt\]/.test(r.text), r.text);
r = await call("ssh_run_many", { tag: "fleet", command: "touch /tmp/fanout-test && echo touched" });
check("fan-out by tag mutates every match", /\[alt\] exit 0/.test(r.text) && /touched/.test(r.text), r.text);
const lport = 45231;
r = await call("ssh_forward", { action: "start", localPort: lport, remotePort: 22 });
check("ssh_forward start", !r.isError && /Forwarding localhost/.test(r.text), r.text);
r = await call("ssh_forward", { action: "list" });
check("ssh_forward list", new RegExp(`${lport}:localhost:22`).test(r.text), r.text);
const carriesTraffic = await new Promise((resolve) => {
  const s = net.connect(lport, "127.0.0.1");
  s.setTimeout(3000);
  s.on("data", (d) => {
    s.destroy();
    resolve(d.toString().startsWith("SSH-"));
  });
  s.on("error", () => resolve(false));
  s.on("timeout", () => {
    s.destroy();
    resolve(false);
  });
});
check("forwarded port actually carries traffic", carriesTraffic);
r = await call("ssh_forward", { action: "stop", localPort: lport, remotePort: 22 });
check("ssh_forward stop", !r.isError, r.text);

console.log("\ncleanup");
r = await call("ssh_run", { command: `rm -r ${REMOTE_DIR} /tmp/fanout-test` });
check("removed the remote scratch files", !r.isError, r.text);
r = await call("host_status", { action: "close" });
check("connection closes", /connection closed/.test(r.text), r.text);
const auditLines = fs.readFileSync(path.join(HOME, "audit.log"), "utf8").trim().split("\n");
check(`audit log recorded every action (${auditLines.length} lines)`, auditLines.length > 15 && auditLines.every((l) => JSON.parse(l).ts));
r = await call("host_remove", { name: "alt" });
check("host_remove", !r.isError, r.text);

await client.close();
fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
