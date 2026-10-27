# @ruqinhu/dsh-memory

Persistent long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
with **configurable character caps**.

DSH ships no persistent-memory package, so an agent forgets durable rules between
sessions. This plugin keeps two §-delimited documents and injects them as dynamic
prompt context on every assembly.

## Why not truncate

Truncation is how a memory file quietly goes wrong: the write succeeds, and the
next request is missing a constraint. Writes that would exceed the cap are
**rejected**, which forces a real compression pass instead.

The inherited Hermes deployment is the cautionary case — its `MEMORY.md` had grown
to 3,687 characters against a 2,200-character budget (68% over), and its `USER.md`
to 2,748 against 1,375 (100% over).

## Install

```bash
dsh plugin add @ruqinhu/dsh-memory
```

The bundle patch is applied automatically via `dsh.bundle` in `package.json`.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `memoryCap` | `2200` | Character cap for `MEMORY.md` |
| `userCap` | `1375` | Character cap for `USER.md` |
| `enableInjection` | `true` | Inject the documents as dynamic prompt context |
| `backupKeep` | `12` | Backup directories to retain |
| `memoryDir` | `~/.dsh/memory` | Where the documents and backups live |

Caps are configuration so a deployment can raise them while inherited files are
being compressed, then lower them again.

## Injected context

Documents are injected whole while small. Above a 6,000-character combined budget
the plugin injects an **entry index** plus a pointer to `memory_search` instead, so
a growing memory never silently crowds out working context.

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_read` | Read a document with usage and entry count |
| `memory_search` | Keyword-search entries; returns scored matches |
| `memory_write` | Replace a document (rejected over cap) |
| `memory_append` | Append one entry (rejected over cap) |
| `memory_replace` | Replace an exact substring in place |
| `memory_maintenance` | Back up, rotate, and report usage |

`memory_replace` is the compression primitive: rewrite a stale rule in place
rather than rewriting the whole document.

## Weekly maintenance

The inherited deployment ran a Saturday compression job. Point a scheduled task
at `memory_maintenance`, then have the agent merge or drop stale entries with
`memory_replace` until usage is back under cap.

## License

MIT
