// The typing engine compares Unicode code points; DOM selections use UTF-16.
// Count complete input characters, then find that position in the unchanged target.
export function targetOffset(translation, input, selectionStart) {
  let cursor = Math.max(0, Math.min(input.length, Number.isFinite(selectionStart) ? Math.trunc(selectionStart) : input.length));
  if (cursor > 0 && cursor < input.length && /[\uD800-\uDBFF]/.test(input[cursor - 1]) && /[\uDC00-\uDFFF]/.test(input[cursor])) cursor--;
  const count = Array.from(input.slice(0, cursor)).length;
  return Array.from(translation).slice(0, count).join('').length;
}

export function alignmentAtCursor(translation, input, selectionStart, alignment) {
  if (!translation || !alignment?.spans?.length) return null;
  let offset = targetOffset(translation, input, selectionStart);
  // A completed target keeps the final phrase visible. Whitespace moves to the next word.
  if (offset >= translation.length) offset = translation.length - 1;
  while (offset < translation.length - 1 && /\s/u.test(translation[offset])) offset++;
  const span = alignment.spans.find(item => item.englishStart <= offset && offset < item.englishEnd);
  if (!span) return null;
  const words = translation.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu);
  for (const match of words) {
    if (match.index <= offset && offset < match.index + match[0].length) {
      return { span, word: { start: match.index, end: match.index + match[0].length } };
    }
  }
  // Punctuation and emoji still have a semantic group, even without a lexical word.
  return { span, word: { start: span.englishStart, end: span.englishEnd } };
}
