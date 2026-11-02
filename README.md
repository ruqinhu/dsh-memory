# @ruqinhu/dsh-memory

English | [中文](README.zh-CN.md)

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
| `enableRecall` | `false` | Register `memory_recall` |
| `enableAutoRecall` | `false` | Recall automatically once per turn |
| `recallBudgetChars` | `1500` | Character ceiling for one recall |
| `staleAfterDays` | `45` | Unused for this long → listed as cold by maintenance |
| `staleMinAgeDays` | `14` | Never report an entry younger than this as unused |
| `enableSkill` | `true` | Register the `memory-curation` skill when the profile has a skill registry |

Caps are configuration so a deployment can raise them while inherited files are
being compressed, then lower them again.

## Injected context

Documents are injected whole while small. Above a 6,000-character combined budget
the plugin injects an **entry index** plus a pointer to `memory_search` instead, so
a growing memory never silently crowds out working context.

## Search and recall

CJK is tokenised as **bigrams** (`止损怎么设` → `止损`/`损怎`/`么设`). This is not a
detail. With whole runs kept intact, a query only matched when it happened to be a
substring of the entry, so `止损怎么设` scored **zero** against
`止损 2.96/走弱 3.02` and recall returned nothing — indistinguishable from "no
relevant memory", which is exactly how the search path had been silently useless.
Single characters are still not split out (`跌` stays whole), or almost every entry
would match.

`memory_search` returns a scored **list of entries** for the model to read.

`memory_recall` (off by default) returns a **rendered context block** plus one
indicator line (`🧠 召回 N 条记忆`), filled highest-score first until the character
budget is spent. Entries that do not fit are **skipped, not truncated** — half a
rule reads like a complete one, which is worse than having none.

Recall is off by default because below the 6,000-character inline budget the whole
memory is already in context and a recall would inject a second copy. It pays only
once injection has switched to an index. The seam exists now so that change needs
no restructuring.

The indicator line follows Hermes' `describe_recall`, for the same reason: without a
deterministic signal, "the model chose to stay silent" and "recall is broken" look
identical. This deployment already paid for that lesson on the delivery side.

### Automatic recall

`enableAutoRecall` (off by default) runs the same lookup without the model asking,
at the **first step of each turn**, and appends the result to that turn only. Three
rules come straight from Hermes' `prefetch`, each with a failure behind it:

- **A trivial turn is not recalled.** Not skipped afterwards — the lookup never
  runs. `好的` matches most entries on one character, so looking it up does not
  merely waste a read: it injects an unrelated rule into a turn about nothing.
  The gate is a vocabulary match (`好的`/`收到`/`ok`/…) rather than a length rule,
  because `跌停` and `止损` are also two characters and are the densest prompts
  this owner sends.
- **A recall failure never fails the turn.** Memory is an optimisation; losing the
  turn as well as the recall trades a degraded answer for no answer.
- **The indicator is reported once, not every turn.** A line that never changes
  stops being information and becomes furniture — and then a broken recall and a
  silent one look the same.

The injected block is a `user`-role message with `source.kind: 'system-prompt'`,
not `'user'`. It is context the harness put there; claiming `user` would put words
in the owner's mouth on every replay of the session.

Only the owner's own words are used as the query. The pre-step batch also carries
the memory documents themselves, the skill catalog and the time context — recalling
against those would score memory against memory, and the top hit would always be
the document already in context.

## Entry ids and the second hop

Every entry has a stable id — `m-` for `MEMORY.md`, `u-` for `USER.md`, then ten hex
characters derived from the entry text.

The ids exist because an index is only useful if the model can get back from it.
Before they did, the over-budget injection rendered each entry as an 80-character
headline and pointed at `memory_search` — so reading a rule whose first line had
been cut meant guessing keywords that happened to be in it. An id turns that guess
into a jump: `memory_get('m-3f7a1c2d5e')` returns the entry the index just named,
and recalled lines carry their id too.

They are content-derived rather than positional on purpose. A positional id
(`entry 7`) renumbers on every compression pass, so every reference the model wrote
in the previous turn silently points at a different rule. A content hash changes
only when the rule itself changes — which is exactly when the old reference should
stop resolving, and why `memory_get` answers a stale id with "call memory_search"
rather than an empty result.

The ids are **not** written into `MEMORY.md` or `USER.md`. The documents belong to
the owner, an id in the text would be one more thing for a compression pass to get
wrong, and they are recomputed from the documents on every load — so an existing
memory needs no migration, and a hand-edited entry simply gets a new id.

## Usage evidence for compression

`memory_maintenance` records which entries were actually used — recalled, searched,
or read by id — in a `.entry-index.json` sidecar, and reports the entries that have
gone unused for `staleAfterDays`, largest first.

The cap forces something out, and without evidence the choice defaults to
"whichever rule I happened to reread first" — which is how a still-relevant rule
gets deleted while a dead one survives another year. The evidence is a lower bound,
not a verdict: an entry injected inline on every request is in use without ever
being counted, so cold entries are **candidates for review, never for automatic
deletion**. Entries younger than `staleMinAgeDays` are never listed at all; a rule
written yesterday has had one day of chances, and a report full of fresh entries
trains its reader to ignore it.

## Curation skill

When the profile provides a skill registry (`dsh-skill`), the plugin registers
`memory-curation` into it: when to write, how to write without duplicating, and how
to compress.

The discipline is a skill rather than an injected protocol because a protocol has
to be sent on every request to be seen, and that is the one thing this plugin
exists to avoid. The catalog costs one line; the procedure is loaded only in the
turns that touch memory. The skill is optional in both directions — a profile with
no registry simply skips the registration (`enableSkill: false` also skips it).

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_read` | Read a document with usage and entry count |
| `memory_get` | Read one entry in full by id |
| `memory_search` | Keyword-search entries; returns scored matches with ids |
| `memory_recall` | Search and render a ready-to-use context block (`enableRecall`) |
| `memory_write` | Replace a document (rejected over cap) |
| `memory_append` | Append one entry (rejected over cap) |
| `memory_replace` | Replace an exact substring in place |
| `memory_maintenance` | Back up, rotate, report usage, and list cold entries |

`memory_replace` is the compression primitive: rewrite a stale rule in place
rather than rewriting the whole document.

## Weekly maintenance

The inherited deployment ran a Saturday compression job. Point a scheduled task
at `memory_maintenance`, then have the agent merge or drop entries — using the
cold list as evidence — with `memory_replace` until usage is back under cap.

## License

[MIT](LICENSE)
