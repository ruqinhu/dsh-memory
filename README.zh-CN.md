# @ruqinhu/dsh-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供**字符上限可配置**的长期记忆。

DSH 本身没有持久记忆包，会话之间会丢规则。本插件维护两份以 `§` 分隔的文档，并在每次装配时作为动态上下文注入。

## 为什么不用截断

截断是记忆文件悄悄出错的典型方式：写入看起来成功了，下一次请求却少了某条约束。**超上限的写入会被拒绝**，逼出一次真正的压缩。

参照场景：迁移前 Hermes 的 `MEMORY.md` 已涨到 3,687 字符，上限 2,200（超 68%）；`USER.md` 涨到 2,748，上限 1,375（超 100%）。

## 安装

```bash
dsh plugin add @ruqinhu/dsh-memory
```

## 配置

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `memoryCap` | `2200` | `MEMORY.md` 字符上限 |
| `userCap` | `1375` | `USER.md` 字符上限 |
| `enableInjection` | `true` | 是否作为动态上下文注入 |
| `backupKeep` | `12` | 保留的备份目录数 |
| `memoryDir` | `~/.dsh/memory` | 文档与备份目录 |

上限做成配置项，是为了迁移期先把上限调高、压缩完再调回来。

## 注入策略

文档较小时整体注入。合计超过 6,000 字符后改为注入**条目索引**并提示调用 `memory_search`，避免记忆膨胀后静默挤占工作上下文。

## 工具

| 工具 | 用途 |
| --- | --- |
| `memory_read` | 读文档，含用量与条目数 |
| `memory_search` | 关键词检索，按得分返回 |
| `memory_write` | 整体替换（超上限拒绝） |
| `memory_append` | 追加一条（超上限拒绝） |
| `memory_replace` | 精确替换子串 |
| `memory_maintenance` | 备份、轮转、报告用量 |

`memory_replace` 是压缩用的原语：原地改写过期规则，而不是重写整份文档。

## 每周维护

参考部署每周六跑一次压缩。把定时任务指向 `memory_maintenance`，再让 agent 用 `memory_replace` 合并或删除过期条目，直到用量回到上限内。

## 许可

MIT
