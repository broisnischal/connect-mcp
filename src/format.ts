import { ExecResult } from "./ssh.js";

/** Keep the head and tail of long output; the middle is where the noise lives. */
export function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const cut = text.length - max;
  return (
    text.slice(0, head) +
    `\n... [${cut} chars trimmed of ${text.length} total] ...\n` +
    text.slice(text.length - tail)
  );
}

const HINTS: [RegExp, string][] = [
  [/permission denied \(publickey/i, "Key auth failed. Check identityFile, or run ssh-copy-id for this host from a terminal."],
  [/could not resolve hostname/i, "DNS failed for the hostname."],
  [/connection timed out|operation timed out/i, "No route or the security group / firewall is closed on this port."],
  [/connection refused/i, "Nothing is listening on the ssh port."],
  [/host key verification failed/i, "Host key changed. Fix ~/.ssh/known_hosts from a terminal, then retry."],
  [/no such identity|identity file .* not accessible/i, "The identityFile path does not exist locally."],
  [/sudo: a (password|terminal) is required/i, "sudo wants a password and none is configured. Use host_sudo to point this host at one."],
  [/sudo rejected the stored password/i, "The stored sudo password is wrong. Re-store it with host_sudo."],
  [/you must have a tty to run sudo/i, "This sudoers config needs requiretty. Retry with tty: true."],
  [/batch mode|permission denied, please try again/i, "Password auth is not usable from an agent. Set up key auth."],
];

export function renderRun(label: string, command: string, res: ExecResult, maxOutput: number): string {
  const lines: string[] = [];
  const status = res.timedOut ? "TIMED OUT" : `exit ${res.code ?? `signal ${res.signal}`}`;
  lines.push(`[${label}] ${status} in ${res.ms}ms`);
  lines.push(`$ ${command}`);
  const out = res.stdout.trimEnd();
  const err = res.stderr.trimEnd();
  if (out) lines.push(clamp(out, maxOutput));
  if (err) lines.push(`--- stderr ---\n${clamp(err, Math.min(maxOutput, 8000))}`);
  if (!out && !err) lines.push("(no output)");
  if (res.code !== 0) {
    const hint = HINTS.find(([re]) => re.test(err))?.[1];
    if (hint) lines.push(`hint: ${hint}`);
  }
  if (res.timedOut) {
    lines.push("hint: killed on timeout. Use ssh_job for anything long-running.");
  }
  return lines.join("\n");
}
