/**
 * Acknowledgements that carry no semantic signal.
 *
 * Recall is paid on every turn, so a turn that cannot match anything should not
 * pay for one. Both lists are matched only after the punctuation is stripped and
 * the text is lowercased, so `好的。` and `OK!` gate the same as `好的` and `ok`.
 *
 * Kept as an explicit vocabulary rather than a length rule: `跌停` and `止损` are
 * also two characters and are the densest prompts this owner sends. Length is not
 * a signal; aboutness is.
 */
const ACKNOWLEDGEMENTS = new Set([
  '好的', '好', '嗯', '嗯嗯', '哦', '收到', '知道了', '明白', '明白了',
  '继续', '可以', '行', '对', '是的', '谢谢', '谢了', '辛苦了', '没事',
  'ok', 'okay', 'yes', 'yep', 'yeah', 'sure', 'thanks', 'thx', 'got it',
  'good', 'nice', 'cool', 'great',
])

/**
 * Trailing words that decorate an acknowledgement without adding content.
 *
 * `收到，谢谢` is still an acknowledgement; the comma and the thanks are politeness,
 * not a question. Stripped repeatedly so `嗯嗯，好的，谢谢` reduces all the way.
 */
const TRAILING_POLITENESS = ['谢谢', '谢了', '辛苦了', 'thanks', 'thx']

/**
 * Whether a turn's text is too thin to be worth recalling against.
 *
 * Mirrors Hermes' `is_trivial_prompt`, which gates its `prefetch_all` on the same
 * question. The failure it prevents is not wasted work but a false positive:
 * recall keyed on an empty turn can still match an entry on a stray character and
 * inject a rule into a turn that was about nothing.
 */
export function isTrivialQuery(text: string): boolean {
  const normalised = normalise(text)
  if (normalised === '') return true
  if (ACKNOWLEDGEMENTS.has(normalised)) return true

  // Peel politeness off the end and re-test, so `收到，谢谢` still gates.
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
 * Lowercase, strip punctuation and separators, collapse whitespace.
 *
 * Punctuation is removed rather than treated as a boundary because the gate is a
 * membership test: `好的。` has to reduce to exactly `好的` to hit the vocabulary.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim()
}
