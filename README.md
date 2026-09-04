# connect-mcp

An MCP server that gives Claude a shell on my remote machines. I register a box once (EC2, VPS, bare metal, a Pi), pick it by name, and Claude runs commands there over a single multiplexed SSH connection.

The point is the connection reuse. Every tool call rides the same `ControlMaster` socket, so a command costs one round trip instead of a full TCP plus key exchange. On localhost that is 80ms per command; against a real EC2 box the difference between multiplexed and cold is roughly 90ms versus 900ms, and Claude fires a lot of commands.

```
me:     "check why the API box is throwing 502s"
claude: ssh_run  systemctl status api        -> active (running), 3 restarts in 5m
        ssh_run  journalctl -u api -n 50     -> OOM killer
        ssh_run  free -h                     -> 96% used
        ssh_read_file /etc/systemd/system/api.service
```

## Install

```bash
git clone <this repo> connect-mcp && cd connect-mcp
npm install && npm run build
```

Register it with Claude Code:

```bash
claude mcp add connect --scope user -- node /absolute/path/to/connect-mcp/dist/index.js
```

For Claude Desktop, add the same command to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "connect": { "command": "node", "args": ["/absolute/path/to/connect-mcp/dist/index.js"] }
  }
}
```

Auth comes from the local ssh agent, my keys, and `~/.ssh/config`. There is no password auth: `BatchMode=yes` is forced, so nothing can ever sit there waiting on a prompt. If a host needs a password, `ssh-copy-id` it first.

## First five minutes

The server loads when a Claude session starts, so after registering it I restart Claude Code once. `/mcp` then lists `connect` and its 13 tools, named `mcp__connect__ssh_run` and so on. I never call those names by hand; I describe what I want and Claude picks the tool.

Then, in plain English:

```
1.  "add my EC2 box: 13.51.4.12, user ubuntu, key ~/.ssh/prod.pem, call it prod"
2.  "probe prod"                        -> OS, cores, memory, disk, what is listening
3.  "why is nginx returning 502 on prod?"
4.  "tail the last 100 lines of the api service log"
5.  "restart the api service"           -> Claude asks, I approve, it runs
```

Step 1 registers the host and verifies the connection in the same call. Step 2 onward, I stop mentioning the host at all: `prod` is selected, so every later command lands there until I say "switch to staging".

The permission prompt shows me the exact command and host before anything runs. Approving "yes, and don't ask again for this tool" makes the rest of the session hands-off.

Things worth saying out loud, because they map onto a tool Claude might otherwise not reach for:

| I say | What happens |
| --- | --- |
| "check disk on all prod boxes" | `ssh_run_many` with the `prod` tag, in parallel |
| "run the migration, it takes a while" | `ssh_job`, detached, survives everything |
| "how is that job doing?" | `ssh_job logs` |
| "let me hit the staging DB locally" | `ssh_forward` 5432, then I use psql normally |
| "copy the dump down here" | `ssh_transfer down` |
| "fix the upstream block in the nginx config" | `ssh_read_file`, edit, `ssh_write_file` with a backup |

## Registering hosts

```
host_add  name: "prod-api"  hostname: "13.51.x.x"  user: "ubuntu"
          identityFile: "~/.ssh/prod.pem"  tags: ["prod","api"]

host_add  name: "db"  hostname: "10.0.1.7"  user: "ec2-user"
          jumpHost: "ec2-user@bastion.acme.io"        # ProxyJump, one hop or many

host_add  name: "staging"  hostname: "staging-web"     # an alias from ~/.ssh/config
          cwd: "/srv/app"
```

`host_import` pulls every concrete `Host` block out of `~/.ssh/config` in one shot (wildcards skipped). `host_list` shows what is registered, which host is selected, and which sockets are live. `host_use` switches the default target, so I say "deploy on staging" once and stop repeating myself.

Hosts live in `~/.config/connect-mcp/hosts.json` (mode 600). Keys are referenced by path, never copied into it.

## Tools

| Tool | What it does |
| --- | --- |
| `host_add` | Register a machine, verify the connection immediately |
| `host_list` | Every host, the selected one, which are connected |
| `host_use` | Choose the default target and open the socket |
| `host_remove` | Forget a host, close its socket |
| `host_import` | Pull hosts out of `~/.ssh/config` |
| `host_status` | `check` / `open` / `close` the socket, or `probe` the machine |
| `ssh_run` | Run any command: exit code, timing, stdout, stderr |
| `ssh_run_many` | Same command across hosts by name or tag, in parallel |
| `ssh_read_file` | Read a remote file, optionally a line range |
| `ssh_write_file` | Write or append, base64 on the wire, backup by default |
| `ssh_transfer` | scp a file or directory either direction |
| `ssh_forward` | Tunnel a remote port to localhost on the existing socket |
| `ssh_job` | Start, tail, list, stop detached long-running work |
| `host_sudo` | Check sudo access, or point a host at its sudo password |

`host_status action: "probe"` is the one I reach for on an unfamiliar box: OS, kernel, cores, memory, disk, load, uptime, whether sudo needs a password, which of docker/kubectl/node/psql/nginx are installed, and what is listening.

## Long-running work

`ssh_run` is for commands that finish. Anything that takes minutes goes through `ssh_job`, which launches it under `setsid nohup` with output to `~/.connect-mcp/<id>.log` and hands back a job id. The work survives the connection dropping, the laptop sleeping, and the conversation ending.

```
ssh_job start  "docker compose build && docker compose up -d"   -> j7f2a1, pid 41233
ssh_job logs   j7f2a1                                           -> STATE: running + tail
ssh_job stop   j7f2a1                                           -> signals the process group
```

`ssh_run` timeouts are enforced on both ends: the remote side runs under `timeout -k 5`, so a killed command does not leave a live process behind on the server.

## Port forwarding

```
ssh_forward start  localPort: 5432  remotePort: 5432    # staging Postgres, local psql
ssh_forward start  localPort: 3000  remotePort: 3000    # remote dev server in my browser
```

Forwards are added to the socket that is already open (`ssh -O forward`), so there is no second connection and no second auth.

## Sudo, with or without a password

`sudo: true` on `ssh_run`, `ssh_write_file` and `ssh_job` runs the command as root. On a box with `NOPASSWD` (every default AWS Ubuntu AMI) that is the whole story: `sudo -n`, one round trip, done.

For a box that prompts, I tell it where the password lives and everything above keeps working unchanged. Four sources, first one that answers wins:

```
host_add  name: "vps"  hostname: "..."  sudoPasswordCommand: "pass show servers/vps"
host_add  name: "vps"  hostname: "..."  sudoPasswordEnv: "VPS_SUDO_PW"
host_sudo action: "check"                      # prints the keyring command to run
```

| Source | Where the secret sits |
| --- | --- |
| `sudoPasswordCommand` | wherever `pass`, `op`, `vault`, or `gpg` already keeps it. Nothing new at rest |
| `sudoPasswordEnv` | an env var in the server's environment |
| OS keyring | libsecret on Linux, Keychain on macOS, under service `connect-mcp` |
| `sudoPassword` | literal in `hosts.json`. Works, but it is plaintext |

`host_sudo check` reports whether sudo prompts, which source is configured, and what uid a command actually lands as. When nothing is configured it prints the exact `secret-tool` or `security` command to run in a terminal, so the password never has to appear in a conversation at all.

### How the password gets to sudo

Not on the command line, and not mixed into the data stream:

1. `sudo -n` first. If the host never prompts, that is the only thing that ever happens.
2. On `sudo: a password is required`, the password is resolved and sent on **its own connection** running `sudo -S -p '' -v`, which validates it and primes sudo's timestamp. Nothing else shares that stdin.
3. The real command re-runs as `sudo -n`, now hitting the cached ticket. So `ssh_write_file` can still stream its base64 payload on stdin while running as root.
4. For hardened sudoers with `timestamp_timeout=0`, where no ticket is ever cached, the password is fed straight to `sudo -S` instead, and only when the caller is not using stdin itself.

A wrong password comes back as "sudo rejected the stored password" and the cached copy is dropped, rather than surfacing as a mystery exit 1. A `requiretty` sudoers config gets a pty automatically.

Only the first sudo command per ticket lifetime pays the extra round trips. After that it is one trip like everything else.

## Permissions

Nothing is filtered on this side. Any command I would type into a terminal goes through: `rm -rf`, `systemctl stop`, `docker rm`, `sed -i`, package installs, `DROP TABLE`, `sudo: true` for root work. No allowlist, no confirm parameter, no per-host mode.

The gate is the client. Claude Code prompts before every MCP tool call, so I see the exact command and the host before it runs, and I approve or deny it there. That is one gate in one place rather than a regex arguing with a shell.

If I want a specific host or tool to stop asking, that is a client-side decision too:

```
/permissions                        # allow mcp__connect__ssh_run to run unprompted
```

Every call is still recorded to `~/.config/connect-mcp/audit.log` as JSONL: host, command, exit code, duration. That is how I find out what ran at 2am, and it is the reason I do not need the server second-guessing me.

## Testing

```bash
npm run build && node test/smoke.mjs        # needs an sshd reachable by key
SMOKE_HOST=1.2.3.4 SMOKE_USER=ubuntu node test/smoke.mjs
```

70 checks, end to end through the real MCP protocol: connection reuse timing, quoting round trips, timeouts reaped on both ends, recursive deletes and `sed -i` and `sudo` passing straight through, file writes with backups, transfers, detached jobs, fan-out by tag, and a port forward that a socket actually speaks SSH through.

The password-sudo path is tested against a `sudo` shim that genuinely demands a password, so priming, ticket reuse, a wrong password, a missing password source, the no-cache fallback, and a base64 write on stdin while root are all covered without touching the machine's real sudoers.

## Limits

- SSH login is keys only, by design. Sudo passwords are supported; SSH passwords are not.
- No interactive commands. Nothing that expects a human at a prompt will work, `tty: true` only helps tools that merely insist a terminal exists.
- `ssh_write_file` needs `base64` on the remote host, which every mainstream distro has.
- Forwards opened in one session are listed in that session. A forward on a socket outlives the process; `ssh -O cancel` clears a stray one.
