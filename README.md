# lark-agent-remote

Control local Codex and Antigravity agents remotely from Feishu/Lark.

Codex uses the app bundled with Codex Desktop. Antigravity uses Google's official `agy` headless CLI with structured streaming output.

## Quick start

```bash
npm link
lark-agent-remote setup --workspace /path/to/project
```

`setup` also installs and starts the macOS background service. Use `--no-install` only when you want to run it manually with `lark-agent-remote run`.

Send these commands in Feishu/Lark:

- `/config` — choose the engine, model, reasoning effort, and permissions.
- `/status` — show the current runtime configuration.
- `/new` — start a new agent session with the next message.
- `/history` — browse the 15 most recent Codex sessions and resume one.
- `/cd /path/to/project` — switch the working directory.

Completed task cards also provide quick actions for starting a new session, browsing history, and opening settings.

Running tasks can be interrupted from their card. Full-computer access always requires an explicit confirmation, while recoverable runtime failures are reported in the same task card with a suggested next step.

## Antigravity

Install and authenticate the official CLI once:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy
```

After onboarding, open the bot settings and switch the engine to Antigravity. The bridge discovers available models dynamically, streams progress into the task card, persists independent Antigravity conversation IDs, and can resume recent CLI conversations that exist locally.

### Proxy configuration

Proxy use is optional. During `setup` or `install`, the bridge checks the current macOS HTTPS proxy and writes it into the launchd service only when one is enabled. This is useful for `agy`, which may not reliably inherit GUI/TUN routing in a background process.

To explicitly configure a proxy instead of using auto-detection:

```bash
LARK_AGENT_REMOTE_PROXY=http://127.0.0.1:7897 lark-agent-remote install
```

To explicitly disable proxy injection, even when the macOS system proxy is enabled:

```bash
LARK_AGENT_REMOTE_PROXY=none lark-agent-remote install
```

The proxy value is captured when the service is installed. Run `install` again after changing it. `127.0.0.1`, `localhost`, and `::1` are always excluded so local Codex and Antigravity helper services continue to connect directly.

## Images and files

The bot accepts Feishu image and file messages. Resources are downloaded into the private `~/.lark-agent-remote/attachments/` directory and supplied to the selected agent as local paths. Downloads older than seven days are removed automatically.

Agents can send generated files back by ending their response with one or more lines in this form:

```text
LARK_FILE: /absolute/path/inside/the/workspace
```

Only existing files inside the configured workspace are uploaded, with a 20 MB limit and at most three files per task. The Feishu app needs the `im:resource` and message resource read permissions for attachment transfer.

## Background service and diagnostics

```bash
lark-agent-remote install
lark-agent-remote restart
lark-agent-remote status
lark-agent-remote doctor
```

## Security defaults

- The first user who messages the bot becomes its only owner.
- The default permission mode is `workspace-write`.
- Feishu/Lark credentials and tokens remain managed by the official `lark-cli`; this project does not copy them.
- Generated files are only uploaded from inside the configured workspace.

## License

MIT
