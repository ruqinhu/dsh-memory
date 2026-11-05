/**
 * 不含语义信息的确认语。
 *
 * 召回是每回合都要付费的，所以一个什么都匹配不到的回合不该为它付钱。两张表都只在
 * 去掉标点、转成小写之后再匹配，于是 `好的。` 与 `好的`、`OK!` 与 `ok` 门控结果一致。
 *
 * 这里用显式词表而不是长度规则：`跌停` 和 `止损` 也只有两个字，却是这位 owner 发得
 * 最密的提问。长度不是信号，「在说什么」才是。
 */
const ACKNOWLEDGEMENTS = new Set([
  '好的', '好', '嗯', '嗯嗯', '哦', '收到', '知道了', '明白', '明白了',
  '继续', '可以', '行', '对', '是的', '谢谢', '谢了', '辛苦了', '没事',
  'ok', 'okay', 'yes', 'yep', 'yeah', 'sure', 'thanks', 'thx', 'got it',
  'good', 'nice', 'cool', 'great',
])

/**
 * 结尾那些只起修饰作用、不增加内容的客套词。
 *
 * `收到，谢谢` 仍然是确认语；逗号和道谢是礼貌，不是提问。这里反复剥离，好让
 * `嗯嗯，好的，谢谢` 一路归约到底。
 */
const TRAILING_POLITENESS = ['谢谢', '谢了', '辛苦了', 'thanks', 'thx']

/**
 * 判断一个回合的文本是否薄到不值得为它跑召回。
 *
 * 对齐 Hermes 的 `is_trivial_prompt`，它用同一个问题门控自己的 `prefetch_all`。
 * 这里防的不是白干一次活，而是误报：以空回合为查询的召回仍可能靠一个杂散字符命中
 * 某条记忆，把一条规则注入进一个什么都没问的回合。
 */
export function isTrivialQuery(text: string): boolean {
  const normalised = normalise(text)
  if (normalised === '') return true
  if (ACKNOWLEDGEMENTS.has(normalised)) return true

  // 从尾部剥掉客套后再判一次，于是 `收到，谢谢` 仍然被门控住。
  let reduced = normalised
  for (;;) {
    const word = TRAILING_POLITENESS.find((suffix) => reduced.endsWith(suffix))
    if (word === undefined) break
    const rest = normalise(reduced.slice(0, -word.length))
    if (rest === '') return true
    if (ACKNOWLEDGEMENTS.has(rest)) return true
    reduced = rest
  }
  return false
}

/**
 * 转小写、去掉标点与符号、压缩空白。
 *
 * 标点是被删掉而不是当作边界处理的，因为这道门控是一次集合成员判断：`好的。` 必须
 * 精确归约成 `好的` 才能命中词表。
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim()
}
