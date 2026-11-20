# Kill Process

> Lists running processes by CPU or memory usage and (force) kills one. Cross-platform, with guardrails for OS-critical processes.

`org.asyar.kill-process` is a Tier 2 Asyar extension (system · macOS, Windows, Linux).

## What it does

The extension provides **1 command**:

| Command | Mode | What it does |
| --- | --- | --- |
| **Kill Process** | `view` | Lists running processes by CPU or memory usage and (force) kills one |

## Permissions

```json
"permissions": [
  "process:read",
  "process:kill"
]
```

## Install

Install from the [Asyar Store](https://asyar.org/extensions).

## Develop

```bash
# from this directory
pnpm install
pnpm dev          # vite dev server
pnpm test:run     # vitest
pnpm build        # emits dist/{worker,view}.js + assets
pnpm link         # registers the dev path with the launcher
asyar publish     # builds, packages, GitHub release, store submission
```

## License

[MIT](./LICENSE) © Khoshbin
