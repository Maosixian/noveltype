// Derived, local-only chapter metadata. The Library format and every source
// character remain untouched. Build once for a book's segment array, then use
// the binary-search queries at navigation/completion boundaries.
const BIBLE_BOOKS = new Set('创世记 出埃及记 利未记 民数记 申命记 约书亚记 士师记 路得记 撒母耳记上 撒母耳记下 列王纪上 列王纪下 历代志上 历代志下 以斯拉记 尼希米记 以斯帖记 约伯记 诗篇 箴言 传道书 雅歌 以赛亚书 耶利米书 耶利米哀歌 以西结书 但以理书 何西阿书 约珥书 阿摩司书 俄巴底亚书 约拿书 弥迦书 那鸿书 哈巴谷书 西番雅书 哈该书 撒迦利亚书 玛拉基书 马太福音 马可福音 路加福音 约翰福音 使徒行传 罗马书 哥林多前书 哥林多后书 加拉太书 以弗所书 腓立比书 歌罗西书 帖撒罗尼迦前书 帖撒罗尼迦后书 提摩太前书 提摩太后书 提多书 腓利门书 希伯来书 雅各书 彼得前书 彼得后书 约翰一书 约翰二书 约翰三书 犹大书 启示录'.split(' '));
const NUMBER = '[零〇一二三四五六七八九十百千万两\\d０-９]+';
const SEPARATOR = '(?=$|[\\s:：.．、\\-—（(])';
const CHAPTER_PARTS = new RegExp(`^第(${NUMBER})([章回])(.*)$`);
const VOLUME = new RegExp(`^第${NUMBER}[部卷]${SEPARATOR}`);
const SPECIAL = new RegExp(`^(?:序章|楔子|尾声|后记)${SEPARATOR}`);
const ENGLISH = /^chapter\s+(?:\d+|[ivxlcdm]+)(?=$|[\s:.—-])/i;

function chapterNumber(value) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  value = value.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (/^\d+$/.test(value)) return Number(value);
  if ([...value].every(c => Object.hasOwn(digits, c))) return Number([...value].map(c => digits[c]).join(''));
  let total = 0, section = 0, digit = 0;
  for (const character of value) {
    if (Object.hasOwn(digits, character)) digit = digits[character];
    else if (character === '万') { total += (section + digit || 1) * 10000; section = digit = 0; }
    else {
      const unit = { 十: 10, 百: 100, 千: 1000 }[character];
      if (!unit) return NaN;
      section += (digit || 1) * unit; digit = 0;
    }
  }
  return total + section + digit;
}

function heading(source) {
  if (typeof source !== 'string') return null;
  // A chapter heading must lead a segment. Finding a title inside an already
  // started paragraph cannot give an exact completion boundary without changing
  // existing text, progress and cached translations, so leave it unclassified.
  const line = source.trimStart().split(/\r?\n/, 1)[0].trim();
  if (!line || line.length > 96) return null;
  const bible = /^【([^\s【】]+)\s+(\d{1,3}):(\d{1,3})(?:[-–](\d{1,3}))?】$/.exec(line);
  if (bible && BIBLE_BOOKS.has(bible[1])) {
    const chapter = Number(bible[2]), verse = Number(bible[3]);
    if (chapter < 1 || verse < 1 || (bible[4] && Number(bible[4]) < verse)) return null;
    return { type: 'bible', key: `${bible[1]}:${chapter}`, label: `${bible[1]} 第 ${chapter} 章` };
  }
  if (VOLUME.test(line)) return { type: 'separator' };
  const numbered = CHAPTER_PARTS.exec(line);
  if (numbered) {
    const title = numbered[3], metadata = { label: line.replace(/\s+/g, ' '), number: chapterNumber(numbered[1]), unit: numbered[2] };
    if (!title || /^[\s:：.．、,，\-—（(]/.test(title)) return { type: 'novel', ...metadata };
    // Some existing TXT editions omit the separator. A short, sentence-free
    // candidate is only accepted below when both neighboring numbered headings
    // confirm its sequence; ordinary mentions such as 第二章讲述… stay prose.
    if (title.length <= 40 && !/[。.!?！？]/.test(title) && !/^(?:的|中|里|讲述|介绍|说明|提到|已经|开始|结束|写到|讲到|写的是|内容)/.test(title)) {
      return { type: 'candidate', ...metadata };
    }
    return null;
  }
  if (SPECIAL.test(line) || ENGLISH.test(line)) {
    return { type: 'novel', label: line.replace(/\s+/g, ' ') };
  }
  return null;
}

export function createChapterIndex(segments) {
  const total = Array.isArray(segments) ? segments.length : 0;
  const chapters = [];
  const headings = [];
  for (let index = 0; index < total; index++) {
    const found = heading(segments[index]?.source);
    if (found) headings.push({ ...found, start: index });
  }
  let current = null;
  function finish(end) {
    if (!current) return;
    chapters.push(Object.freeze({ id: `chapter-${current.start}`, label: current.label, start: current.start, end }));
    current = null;
  }
  for (let position = 0; position < headings.length; position++) {
    let found = headings[position];
    const index = found.start;
    if (found.type === 'candidate') {
      const previous = headings[position - 1], next = headings[position + 1];
      if (previous?.type !== 'novel' || next?.type !== 'novel' || previous.unit !== found.unit || next.unit !== found.unit || previous.number + 1 !== found.number || next.number - 1 !== found.number) continue;
      found = { ...found, type: 'novel' };
    }
    if (found.type === 'separator') { finish(index - 1); continue; }
    if (found.type === 'bible' && current?.type === 'bible' && found.key === current.key) continue;
    finish(index - 1);
    current = { ...found, start: index };
  }
  finish(total - 1);
  Object.freeze(chapters);

  function find(index) {
    if (!Number.isInteger(index) || index < 0 || index >= total) return -1;
    let low = 0, high = chapters.length - 1, found = -1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (chapters[middle].start <= index) { found = middle; low = middle + 1; }
      else high = middle - 1;
    }
    return found >= 0 && chapters[found].end >= index ? found : -1;
  }
  return Object.freeze({
    chapters,
    chapterAt(index) { const found = find(index); return found < 0 ? null : chapters[found]; },
    // This reports structure only. The caller decides whether every paragraph
    // in start..end has actually been completed before claiming a whole chapter.
    transitionAt(index) {
      const found = find(index);
      if (found < 0 || chapters[found].end !== index) return null;
      return { completed: chapters[found], next: chapters[found + 1] || null, bookEnd: index === total - 1 };
    },
  });
}
