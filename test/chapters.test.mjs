import test from 'node:test';
import assert from 'node:assert/strict';
import { createChapterIndex } from '../app/chapters.mjs';

const segments = (...sources) => sources.map(source => ({ source, translation: '' }));
const summary = index => index.chapters.map(({ label, start, end }) => ({ label, start, end }));

test('novel chapters preserve heading titles and end at the next chapter boundary', () => {
  const index = createChapterIndex(segments('书籍简介。', '第一章 远行\n清晨出发。', '沿河而行。', '第二章 渡口\n船已经到了。', '暮色渐深。'));
  assert.deepEqual(summary(index), [
    { label: '第一章 远行', start: 1, end: 2 },
    { label: '第二章 渡口', start: 3, end: 4 },
  ]);
  assert.equal(index.chapterAt(0), null);
  assert.equal(index.transitionAt(1), null);
  assert.deepEqual(index.transitionAt(2), { completed: index.chapters[0], next: index.chapters[1], bookEnd: false });
  assert.deepEqual(index.transitionAt(4), { completed: index.chapters[1], next: null, bookEnd: true });
});

test('Arabic and fullwidth chapter numbers, Chinese 回 and explicit separators are recognized', () => {
  const index = createChapterIndex(segments('\uFEFF\n　　第１２章　山风\n风来了。', '第13章：归途\n夜很静。', '第一百零二回 相会\n朋友到了。', '第103章'));
  assert.deepEqual(index.chapters.map(c => c.label), ['第１２章 山风', '第13章：归途', '第一百零二回 相会', '第103章']);
  assert.deepEqual(index.chapters.map(c => c.start), [0, 1, 2, 3]);
});

test('comma headings and a missing title separator are recovered from surrounding chapter numbers', () => {
  const index = createChapterIndex(segments('第四百一十二章 远方', '旧章末段。', '第四百一十三章山风归来\n风穿过树林。', '第四百一十四章 新路', '第四百一十五章，归途仍在', '第416章，新的曙光'));
  assert.deepEqual(index.chapters.map(c => c.label), ['第四百一十二章 远方', '第四百一十三章山风归来', '第四百一十四章 新路', '第四百一十五章，归途仍在', '第416章，新的曙光']);
  assert.equal(index.transitionAt(1).next.start, 2);
});

test('missing separators require corroborating headings, not just a chapter-like word in prose', () => {
  const index = createChapterIndex(segments('第一章 起程', '第二章讲述这段故事', '第二章路过此处。', '第一回合落幕。', '第三章 远处', '第五章未有相邻章号', '第六章 继续'));
  assert.deepEqual(index.chapters.map(c => c.label), ['第一章 起程', '第三章 远处', '第六章 继续']);
  assert.equal(createChapterIndex(segments('第一章风声')).chapters.length, 0);
});

test('Bible verses and merged verses belong to one chapter, including a new book', () => {
  const index = createChapterIndex(segments('【创世记 1:1】\n起初。', '【创世记 1:2-3】\n地上。', '【创世记 2:1】\n完成。', '【出埃及记 1:1】\n名字。'));
  assert.deepEqual(summary(index), [
    { label: '创世记 第 1 章', start: 0, end: 1 },
    { label: '创世记 第 2 章', start: 2, end: 2 },
    { label: '出埃及记 第 1 章', start: 3, end: 3 },
  ]);
  assert.equal(index.transitionAt(0), null);
  assert.equal(index.transitionAt(1).next.label, '创世记 第 2 章');
  assert.equal(index.transitionAt(2).next.label, '出埃及记 第 1 章');
  assert.equal(index.transitionAt(3).bookEnd, true);
});

test('all 66 CUV book labels can start chapters and notes do not become titles', () => {
  const names = '创世记 出埃及记 利未记 民数记 申命记 约书亚记 士师记 路得记 撒母耳记上 撒母耳记下 列王纪上 列王纪下 历代志上 历代志下 以斯拉记 尼希米记 以斯帖记 约伯记 诗篇 箴言 传道书 雅歌 以赛亚书 耶利米书 耶利米哀歌 以西结书 但以理书 何西阿书 约珥书 阿摩司书 俄巴底亚书 约拿书 弥迦书 那鸿书 哈巴谷书 西番雅书 哈该书 撒迦利亚书 玛拉基书 马太福音 马可福音 路加福音 约翰福音 使徒行传 罗马书 哥林多前书 哥林多后书 加拉太书 以弗所书 腓立比书 歌罗西书 帖撒罗尼迦前书 帖撒罗尼迦后书 提摩太前书 提摩太后书 提多书 腓利门书 希伯来书 雅各书 彼得前书 彼得后书 约翰一书 约翰二书 约翰三书 犹大书 启示录'.split(' ');
  assert.equal(names.length, 66);
  const index = createChapterIndex(segments(...names.map(name => `【${name} 1:1】\n正文。\n〔版本分节说明〕`)));
  assert.equal(index.chapters.length, 66);
  assert.deepEqual(index.chapters.map(c => c.label), names.map(name => `${name} 第 1 章`));
});

test('volume headings are chapter-external separators and repeated numbering is distinct', () => {
  const index = createChapterIndex(segments('第一部 早春', '第一章 小路', '旧章末段。', '第二部 盛夏', '卷间说明。', '第一章 新路', '新章末段。'));
  assert.deepEqual(summary(index), [{ label: '第一章 小路', start: 1, end: 2 }, { label: '第一章 新路', start: 5, end: 6 }]);
  assert.equal(index.chapterAt(3), null);
  assert.equal(index.chapterAt(4), null);
  assert.notEqual(index.chapters[0].id, index.chapters[1].id);
  assert.equal(index.transitionAt(2).next, index.chapters[1]);
});

test('prologue and epilogue headings are recognized without inventing a final book boundary', () => {
  const index = createChapterIndex(segments('序章 旧信', '楔子', '第一章 夜路', '尾声：归来', '后记', '第二卷 附录', '附录说明。'));
  assert.deepEqual(index.chapters.map(c => c.label), ['序章 旧信', '楔子', '第一章 夜路', '尾声：归来', '后记']);
  assert.deepEqual(index.transitionAt(4), { completed: index.chapters[4], next: null, bookEnd: false });
  assert.equal(index.chapterAt(6), null);
  assert.equal(index.transitionAt(6), null);
});

test('English Chapter headings use the original title and support Roman numbering', () => {
  const index = createChapterIndex(segments('Chapter 1: A Quiet Door\nThe door opens.', 'A visitor arrives.', 'CHAPTER II\nIt is morning.', 'chapter 3. The River\nThe river shines.'));
  assert.deepEqual(index.chapters.map(c => c.label), ['Chapter 1: A Quiet Door', 'CHAPTER II', 'chapter 3. The River']);
  assert.equal(index.transitionAt(1).next.label, 'CHAPTER II');
});

test('references in ordinary prose, quotations and malformed Bible labels are not chapters', () => {
  const examples = ['第二章讲述了旅程。', '“第一章 远行”写在封面上。', '序章结束以后，他们离开了。', '后记已经写完。', '他翻开书。\n第二章 渡口\n这只是一段引用。', '【京都 1:1】\n一场比赛。', '【创世记 0:1】\n无效。', '【创世记 1:0】\n无效。', '【创世记 1:9-2】\n无效。', '第一章 ' + '这是一段很长的正文。'.repeat(15)];
  const index = createChapterIndex(segments(...examples));
  assert.equal(index.chapters.length, 0);
  for (let i = 0; i < examples.length; i++) { assert.equal(index.chapterAt(i), null); assert.equal(index.transitionAt(i), null); }
});

test('chapter lookups are bounded, isolated and do not mutate source content or expose mutable descriptors', () => {
  const first = segments('第一章 早晨', '午后。', '第二章 夜晚');
  const before = structuredClone(first), index = createChapterIndex(first), other = createChapterIndex(segments('第一章 他乡'));
  for (const bad of [-1, 3, 1.5, NaN, undefined, '1']) { assert.equal(index.chapterAt(bad), null); assert.equal(index.transitionAt(bad), null); }
  assert.equal(other.chapterAt(0).label, '第一章 他乡');
  assert.equal(index.chapterAt(0).label, '第一章 早晨');
  assert.deepEqual(first, before);
  assert.ok(Object.isFrozen(index.chapters));
  assert.ok(Object.isFrozen(index.chapters[0]));
  assert.deepEqual(createChapterIndex([]).chapters, []);
});

test('large-library indexing reads each source once and queries never rescan the book', () => {
  let reads = 0;
  const large = Array.from({ length: 60000 }, (_, i) => ({ get source() { reads++; return i % 20 === 0 ? `第${i / 20 + 1}章 合成章节` : '原创测试内容。'; } }));
  const index = createChapterIndex(large);
  assert.equal(index.chapters.length, 3000);
  assert.equal(reads, 60000);
  for (let i = 0; i < 60000; i += 7) { const chapter = index.chapterAt(i); assert.ok(chapter.start <= i && chapter.end >= i); index.transitionAt(i); }
  assert.equal(reads, 60000);
  assert.equal(index.transitionAt(59999).bookEnd, true);
});
