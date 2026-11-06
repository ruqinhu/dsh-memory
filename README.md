# @ruqinhu/dsh-memory

English | [中文](README.zh-CN.md)

Long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
two §-delimited documents, a hard character budget, and content-derived ids that make
the index navigable.

## 1. The constraint

| Constraint | Consequence |
| --- | --- |
| Memory is prompt context, paid on every request | both documents carry a hard cap |
| A truncated rule is a rule silently lost | over-cap writes are **rejected**, never truncated |
| The cap forces deletion | deletion needs evidence, so usage is counted |

| Document | Default cap | Holds |
| --- | --- | --- |
| `MEMORY.md` | 2,200 chars | durable rules |
| `USER.md` | 1,375 chars | owner profile and standing preferences |

Reference failure: the inherited Hermes deployment reached 3,687/2,200 (68% over) and
2,748/1,375 (100% over) with nothing noticing.

## 2. Mechanisms

| Problem | Decision | Rejected alternative | Cost paid |
| --- | --- | --- | --- |
| How much to inject | ≤ 6,000 chars combined → whole documents inline; above → index of ids + first lines | always inline: crowds out working context; always index: every small deployment pays a round trip | index mode costs one tool call |
| What an entry is called | id = hash(target, text), 10 hex, prefix `m-`/`u-` | positional ids (`entry 7`) renumber on every compression, silently re-pointing every reference | editing a rule invalidates its id (intended) |
| How to read one rule | `memory_get(id)`; `memory_search` returns ids too | 80-character headlines only: reading the rest means guessing keywords | one more tool |
| How to match CJK | bigrams (`止损怎么设` → `止损`/`损怎`/`么设`), ASCII words ≥2 chars | whole runs: `止损怎么设` scored **0** against `止损 2.96` — recall silently empty | single characters still not split (too broad) |
| How much recall injects | 1,500-char budget, highest score first, entries that do not fit are **skipped** | truncating: half a rule reads like a complete one | a query can return nothing when one rule is too large |
| Where usage evidence lives | `.entry-index.json` sidecar: `hits`, `firstSeenAt`, `lastHitAt` | compression by taste: deletes what is still relevant, keeps what is dead | inline-injected entries are never counted — the evidence is a lower bound |
| When to call it unused | maintenance lists entries unused 45 days, older than 14 days, at most 12, largest first | listing everything: an inventory nobody reads | a sample, not a census |
| Where the write discipline lives | `memory-curation` skill, registered only if a skill registry exists | an injected protocol: spends context on the rules for writing rules | no registry → no skill |

Registration is a deferred child fiber (`ctx.inject(['skills'])`), not a `static
inject` entry — a plugin that requires a skill registry refuses to load without one.

## 3. Failure modes

| Failure | Behaviour |
| --- | --- |
| Write exceeds the cap | rejected with current/cap; forces a compression pass |
| `memory_get` on a stale id | answers "call `memory_search`" instead of resolving to a different rule |
| Recall throws | swallowed; a recall failure never fails the turn |
| Profile has no skill registry | registration skipped, plugin loads normally |
| Sidecar is corrupt | treated as empty and rebuilt from the documents on the next sync |
| Automatic recall fires every turn | sidecar writes are coalesced to one a minute |

## 4. Measured

| Item | Result |
| --- | --- |
| Unit tests | 118 across 15 files; `tsc --noEmit` clean under `strict` |
| Live round trip | `memory_search("网关")` → `m-efa7252010`; `memory_get` returned the full 95-char entry; `hits` reached 2 |
| Skill registration | `memory-curation` present in the live agent's catalog |
| Live shape | 38 entries against a raised 3,000-char cap, still inside the 6,000 inlining threshold |

## 5. Open questions

| Question | Current state |
| --- | --- |
| Automatic recall | off by default; pays only after injection switches to an index |
| `snapshot()` | returns live records, not copies — misleading name, tests mutate through it |
| Cold list | a 12-entry sample, not an inventory |
| Editing a rule | resets its statistics (intended, but hides usage history) |
| Cross-document duplicates | not detected; the same rule in both documents counts twice |
| Cap unit | characters, not tokens — re-measure when switching language |
| Cross-device sharing | none; no locking story |

## 6. Compatibility

| Item | Value |
| --- | --- |
| DSH | `0.2.2-rc.1` (peer dependencies pinned) |
| Runtime | Node 22+, no native modules |
| Runtime dependencies | `@deepseek-ai/schemastery` only |
| Optional integration | `@deepseek-ai/dsh-skill` — absent means no skill, not no plugin |

## 7. Install and configure

```bash
dsh plugin add @ruqinhu/dsh-memory
```

| Key | Default | Meaning |
| --- | --- | --- |
| `memoryCap` | `2200` | `MEMORY.md` cap |
| `userCap` | `1375` | `USER.md` cap |
| `enableInjection` | `true` | inject as dynamic prompt context |
| `backupKeep` | `12` | backup directories retained |
| `memoryDir` | `~/.dsh/memory` | documents and backups |
| `enableRecall` | `false` | register `memory_recall` |
| `enableAutoRecall` | `false` | recall once per turn |
| `recallBudgetChars` | `1500` | ceiling for one recall |
| `staleAfterDays` | `45` | unused this long → cold |
| `staleMinAgeDays` | `14` | never report younger entries as unused |
| `enableSkill` | `true` | register `memory-curation` when a registry exists |

## 8. Tools

| Tool | Purpose |
| --- | --- |
| `memory_read` | read a document with usage and entry count |
| `memory_get` | read one entry in full by id |
| `memory_search` | keyword search; returns scored matches with ids |
| `memory_recall` | search and render a ready-to-use block (`enableRecall`) |
| `memory_write` | replace a document (rejected over cap) |
| `memory_append` | append one entry (rejected over cap) |
| `memory_replace` | replace an exact substring in place — the compression primitive |
| `memory_maintenance` | back up, rotate, report usage, list cold entries |

Weekly pass: point a scheduled task at `memory_maintenance`, then merge or drop
entries with `memory_replace` until usage is back under cap.

## License

[MIT](LICENSE)
