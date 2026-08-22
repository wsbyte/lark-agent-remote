# lark-agent-remote

Control local Codex and Antigravity agents remotely from Feishu/Lark.

> This is an early MVP. The Codex `app-server` integration is available; the Antigravity adapter will be enabled once its `agy` CLI is available.

## Quick start

```bash
npm link
lark-agent-remote setup --workspace /path/to/project
lark-agent-remote run
```

Send these commands in Feishu/Lark:

- `/config` — choose the engine, model, reasoning effort, and permissions.
- `/status` — show the current runtime configuration.
- `/new` — start a new agent session with the next message.
- `/history` — browse the 15 most recent Codex sessions and resume one.
- `/cd /path/to/project` — switch the working directory.

Completed task cards also provide quick actions for starting a new session, browsing history, and opening settings.

## Run in the background on macOS

```bash
lark-agent-remote install
lark-agent-remote restart
```

## Security defaults

- The first user who messages the bot becomes its only owner.
- The default permission mode is `workspace-write`.
- Feishu/Lark credentials and tokens remain managed by the official `lark-cli`; this project does not copy them.

## License

MIT
