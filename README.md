# @ruqinhu/dsh-memory

English | [中文](README.zh-CN.md)

Long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
two documents, a fixed character budget, and an index the model can walk back from.

DSH ships no persistent-memory package, so every session starts by forgetting the
rules the last one learned. This plugin keeps `MEMORY.md` (durable rules) and
`USER.md` (who the owner is) as §-delimited entries, injects them as dynamic prompt
context, and gives the model a way to read one entry back by id when the documents
are too large to show in full.

The rest of this document is the design, in the order the constraints forced it.
Section 1 is the constraint that decides everything; sections 2–6 are one mechanism
each, every one of them opening with the failure that motivated it and naming the
alternative it rejected; 7 is what was measured; 8 is what is still open. The
install/config/tool reference is at the end, after the argument.

## 1. The constraint that shapes everything

Memory is not a database with a scroll bar. It is prompt context, paid for on every
request, and the window it competes with is the one the task needs.

So both documents carry a hard character cap. A write that would exceed it is
**rejected** — never truncated:

| Document | Default cap | Why a cap at all |
| --- | --- | --- |
| `MEMORY.md` | 2,200 characters | durable rules; grows by one rule at a time |
| `USER.md` | 1,375 characters | the owner's profile and standing preferences |

Truncation is how a memory file quietly goes wrong: the write looks successful and
the next request is missing a constraint. Rejecting forces the compression pass that
a growing document needs anyway. The inherited Hermes deployment is the cautionary
case — `MEMORY.md` had reached 3,687 characters against 2,200 (68% over) and
`USER.md` 2,748 against 1,375 (100% over), and nothing in the pipeline noticed.

Caps are configuration rather than constants because the honest workflow is to raise
the limit, compress, and lower it again.

### Where the pieces sit

```text
  MEMORY.md ─┐
             ├─ § split ─► entries ─► id = hash(target, text)
  USER.md ───┘                  │
                                ├─ combined ≤ 6,000 chars ─► inline in the prompt
                                │                            (context order 130)
                                └─ combined > 6,000 chars ─► index, one line each:
                                     "- m-3f7a1c2d5e · 止损 2.96/走弱 3.02"
                                          │
                             memory_get(id) ◄─┘   the second hop
                                │
  recall / search ─► scored entries ─► budgeted block (skip, never truncate)
  reads, recalls, searches ─► .entry-index.json ─► hits, first/last seen
                                                       │
                                 memory_maintenance ───┘ cold list, largest first
```

## 2. Injection: inline while it fits, an index when it does not

There are two ways to put memory in front of the model, and they fail in opposite
directions.

**2.1 Inline** — the whole document in the dynamic context — is strictly better
while the text is small: no tool round trip, and the rules are simply in view.

**2.2 An index** — one line per entry plus a pointer to the retrieval tools — costs
the model a call, but does not crowd out working context.

The switch is a 6,000-character combined budget. Below it the documents are injected
whole; above it the index is injected instead. Without the switch, a growing memory
silently takes over the window it was supposed to support; with the switch always
on, every small deployment pays a round trip for nothing.

The index is placed at context order 130 — after team identity (125) and before
harness source (200) — and registered through `systemPrompt.context()`, not through
`agent/pre-step`. The context seam is the documented way to inject "durable user-role
snapshot" material, and its text provider is re-evaluated at assembly; `pre-step`
would require fabricating a user message on every step and minting message ids the
harness never issued.

## 3. Identity: ids make the index a jump, not a guess

A truncated first line is not a reference. Before entries had ids, the index showed
80 characters of each rule and told the model to call `memory_search` — so reading
the rest of a rule meant guessing keywords that happened to be in it.

Every entry now has an id: `m-` for `MEMORY.md`, `u-` for `USER.md`, then ten hex
characters of a hash of the entry text. The index prints it, `memory_search` returns
it, recalled lines carry it, and `memory_get(id)` reads the entry in full.

Two properties matter more than the format:

- **The ids are derived, not stored.** They are recomputed from the documents on
  every load, so an existing memory needs no migration, a hand-edited entry simply
  gets a new id, and the documents stay the owner's — no hashes in the text for a
  compression pass to mangle.
- **An edited rule loses its id.** That is the honest behaviour: the rule that was
  read is not the rule that exists now. `memory_get` on a stale id answers "call
  `memory_search`" rather than returning a different rule under the same name.

Positional ids (`entry 7`) were rejected for the same reason: every compression pass
renumbers them, and every reference the model wrote in the previous turn points
silently at a different rule.

**3.1 Why not embeddings.** The obvious modern alternative is a vector index: embed
every entry, retrieve by similarity. It fails this deployment on three counts. The
failure it would solve — "the rule is phrased differently from the question" — is not
the failure that happens here; the actual failure is *stale* rules, which similarity
retrieval cannot detect and the usage statistics in §5 can. An embedding index is
also a second copy of the truth that drifts from the documents the moment a
compression pass rewrites an entry. And it costs an embedding call on every write and
every query, on a plugin whose whole point is that memory should be cheap. Keyword
bigrams with an id to jump by are worse at recall and far better at being explained:
when a rule does not surface, the reason is visible in the query terms.

## 4. Retrieval: terms the owner actually types

CJK has no word separators, so a query is only useful if it is cut into units that
can match. Whole runs — the previous behaviour — only match when the query is a
substring of the entry:

```
query  止损怎么设
entry  止损 2.96/走弱 3.02     → score 0, recall returns nothing
```

Zero is indistinguishable from "no relevant memory", which is how the retrieval path
had been silently useless. Queries are now tokenised as **bigrams**
(`止损`/`损怎`/`么设`), so an entry containing `止损` matches on a term the owner
actually typed. Single characters are not split out (`跌` stays whole) — they match
almost every entry and would turn scoring into noise.

Recall spends a character budget (1,500 by default), highest score first, and
**skips entries that do not fit** instead of truncating them. Half a rule reads like
a complete one, which is worse than having none.

`memory_recall` (off by default) returns a rendered block plus one indicator line —
`🧠 召回 N 条记忆`. The indicator exists because without a deterministic signal,
"the model chose to stay silent" and "recall is broken" look identical. It is
reported once per change, not every turn: a line that never changes stops being
information and becomes furniture.

Automatic recall (off by default) runs the same lookup at the first step of each
turn, with three rules inherited from a deployment that paid for them:

- **A trivial turn is not recalled** — not skipped afterwards, the lookup never
  runs. `好的` matches most entries on one character; looking it up injects an
  unrelated rule into a turn about nothing. The gate is a vocabulary match, not a
  length rule, because `跌停` and `止损` are also two characters and are the densest
  prompts this owner sends.
- **A recall failure never fails the turn.** Memory is an optimisation; losing the
  turn as well trades a degraded answer for no answer.
- **The query is only the owner's own words.** The pre-step batch also carries the
  memory documents, the skill catalog and the time context — recalling against those
  scores memory against memory.

The injected block is `source.kind: 'system-prompt'`, not `'user'`: it is context
the harness put there, and claiming `user` would put words in the owner's mouth on
every replay of the session.

## 5. Compression needs evidence, not taste

The cap forces something out. Without evidence the choice defaults to "whichever
rule I happened to reread first", which is how a still-relevant rule gets deleted
while a dead one survives another year.

**5.1 The sidecar.** Every recall, search and explicit read records a hit in
`.entry-index.json`, keyed by the entry id, alongside `firstSeenAt` and `lastHitAt`.
The file is rebuilt from the documents on every sync, so a removed entry loses its
record and an edited entry starts over. Writes are coalesced for automatic recall (at
most one sidecar write a minute), because a counter is not worth a file write per
turn.

**5.2 The report.** `memory_maintenance` lists what has gone unused: entries with no
hit for 45 days, at most twelve of them, largest first — and never an entry younger
than 14 days, because a rule written yesterday has had one day of chances, and a
report full of fresh entries trains its reader to ignore it.

The evidence is a **lower bound, not a verdict**. An entry injected inline on every
request is in use without ever being counted, so a cold entry is a candidate for
review, never for automatic deletion. The report says so, and nothing in the plugin
deletes an entry.

**5.3 A compression pass, end to end.**

1. `memory_maintenance` — backs both documents up, reports usage, lists the cold
   entries.
2. Read each cold entry before touching it. It may be a rule that only became
   relevant last week.
3. Merge related rules with `memory_replace` rather than deleting: two rules about
   the same topic usually compress into one entry shorter than either.
4. Re-run `memory_maintenance`. Usage under cap, cold list shorter — that is the
   signal to stop.

## 6. The discipline is a skill, not an injected protocol

Knowing *when* to write memory and *how* to compress it is procedure, not data. A
protocol injected on every request would spend context on the rules for writing
rules — the one thing this plugin exists to avoid.

When the profile provides a skill registry (`@deepseek-ai/dsh-skill`), the plugin
registers `memory-curation` into it: what to save, append-versus-replace, how to use
ids, and how to compress with the cold list as evidence. The catalog costs one line;
the body is loaded only in the turns that touch memory.

The registration is a **deferred child fiber** (`ctx.inject(['skills'])`), not a
`static inject` entry: a plugin that requires a skill registry refuses to load in a
profile without one, and trading all of memory for one skill is a bad trade.
`enableSkill: false` turns it off in a profile that has a registry but does not want
the skill.

## 7. What we measured

- **Unit tests**: 118 across 15 files; every decision (caps, ids, index rendering,
  bigram scoring, recall budget, cold selection) is a pure function with its own
  test, and `tsc --noEmit` is clean under `strict`.
- **Round trip on a live deployment**: `memory_search("网关")` returned
  `m-efa7252010`; `memory_get` on that id returned the full 95-character entry; the
  second call was counted in the sidecar (`hits: 2` for that entry).
- **Skill registration**: asked the live agent to list its catalog — `memory-curation`
  is present.
- **Live shape**: the reference deployment runs 38 entries against a raised
  3,000-character cap, still below the 6,000 inlining threshold — so it reads the
  documents inline and uses ids only for the maintenance report and for `memory_get`
  when the model wants one rule verbatim.

## 8. Open questions

- **Automatic recall is off by default.** It pays only once injection has switched
  to an index; below the budget the whole memory is already in context and a recall
  would inject a second copy. The seam exists now so that switch needs no
  restructuring.
- **`snapshot()` returns live records, not copies.** That is convenient for the
  maintenance report and misleading as a name; the tests mutate through it.
- **The cold list is a sample** (twelve entries) — enough to guide one compression
  session, not an inventory.
- **An edited rule resets its statistics.** Intended, but it means heavy editing
  hides usage history that a reviewer might want.
- **No cross-document deduplication.** The same rule in `MEMORY.md` and `USER.md`
  counts as two entries, and nothing merges them.
- **Caps are characters, not tokens.** The two correlate well enough for prose and
  not at all for CJK-versus-ASCII mixes, so a deployment that switches language
  should re-measure rather than trust the number.
- **No cross-device sync.** The documents are files under `memoryDir`; two hosts
  sharing one memory would need a locking story this plugin does not have.

## Compatibility

| Item | Value |
| --- | --- |
| DSH | `0.2.1-rc.5` (peer dependencies pinned to it) |
| Runtime | Node 22+; no native modules |
| Runtime dependencies | `@deepseek-ai/schemastery` only |
| Optional integration | `@deepseek-ai/dsh-skill` — absent means no skill, not no plugin |

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

`memory_replace` is the compression primitive: rewrite a stale rule in place rather
than rewriting the whole document, which is the easiest way to lose one.

## Weekly maintenance

The inherited deployment ran a Saturday compression job. Point a scheduled task at
`memory_maintenance`, then have the agent merge or drop entries — using the cold
list as evidence — with `memory_replace` until usage is back under cap.

## License

[MIT](LICENSE)
