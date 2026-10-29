const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let backend;
try { backend = require('../app/library.cjs'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
function setup(t) {
  assert.equal(typeof backend?.Library, 'function', 'Library backend must be implemented');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltype-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, library: new backend.Library(dir) };
}
test('first launch supplies several original bilingual demo passages; state is isolated', t => {
  const { library } = setup(t);
  const state = library.getState({ hasKey: false });
  assert.equal(state.books.length, 1);
  assert.equal(state.books[0].demo, true);
  assert.ok(state.books[0].segments.length >= 4);
  assert.ok(state.books[0].segments.every(s => s.source && s.translation));
  state.books[0].title = 'Changed';
  assert.notEqual(library.getState().books[0].title, 'Changed');
});
test('import chunks preserve exact Chinese source, chapters, long sentences and emoji', t => {
  const { library } = setup(t);
  const text = '第一章 初雪\r\n' + '天空很亮。窗外有风！'.repeat(70) + '\n第二章 河岸\n' + '🌲'.repeat(300);
  const state = library.importText({ title: '测试', text });
  const book = state.books.find(b => b.id === state.activeBookId);
  assert.equal(book.title, '测试');
  assert.equal(book.segments.map(s => s.source).join(''), text);
  assert.ok(book.segments.every(s => s.source.length <= 260 && !s.source.includes('\uFFFD')));
  assert.ok(book.segments.some(s => s.source.startsWith('第二章')));
});
test('import refuses empty, binary, excessively large or invalid input without mutation', t => {
  const { library } = setup(t);
  for (const input of [null, { title: '书', text: '   ' }, { title: '书', text: 'abc\0def' }, { title: '书', text: 'x'.repeat(10 * 1024 * 1024 + 1) }, { title: 'x'.repeat(201), text: '正文' }]) {
    assert.throws(() => library.importText(input), /内容|大小|标题|格式|10 MB/);
  }
  assert.equal(library.getState().books.length, 1);
});
test('progress, cached translation and active book survive restart and completion is idempotent', t => {
  const { dir, library } = setup(t);
  const state = library.importText({ title: '新书', text: '你好，森林。' });
  const id = state.activeBookId;
  library.setTranslation({ bookId: id, index: 0, translation: 'Hello, forest.' });
  const progress = { bookId: id, position: 0, draft: 'Hello, forest.', completed: 0, session: { characters: 14, seconds: 8, accuracy: 100, wpm: 21 } };
  library.saveProgress(progress);
  library.saveProgress(progress);
  const restored = new backend.Library(dir).getState();
  const book = restored.books.find(b => b.id === id);
  assert.equal(restored.activeBookId, id);
  assert.equal(book.draft, 'Hello, forest.');
  assert.deepEqual(book.completed, [0]);
  assert.deepEqual(book.stats, { sessions: 1, characters: 14, seconds: 8 });
  assert.equal(library.getSegment(id, 0).translation, 'Hello, forest.');
  assert.throws(() => library.getSegment('../../other', 0), /书籍/);
  assert.throws(() => library.saveProgress({ ...progress, position: 99 }), /段落/);
  assert.throws(() => library.saveProgress({ ...progress, session: { ...progress.session, seconds: -1 } }), /统计/);
  library.selectBook(restored.books[0].id);
  assert.equal(library.getState().activeBookId, restored.books[0].id);
});
test('backup restores validated books without keys; malformed backup cannot replace live data', t => {
  const { library } = setup(t);
  const snapshot = library.exportData();
  assert.equal(snapshot.version, 1);
  assert.equal('settings' in snapshot, false);
  library.importText({ title: 'Another', text: '新内容。' });
  library.importData(snapshot);
  assert.deepEqual(library.exportData(), snapshot);
  const mutations = [
    x => { x.version = 999; }, x => { x.apiKey = 'secret'; },
    x => { x.books[0].id = '../escape'; }, x => { x.books.push(x.books[0]); },
    x => { x.books[0].position = 999; }, x => { x.books[0].completed = [999]; },
    x => { x.books[0].stats.seconds = -1; }, x => { x.books[0].segments[0].source = 'x'.repeat(261); },
    x => { x.activeBookId = 'unknown'; }, x => { x.books[0].segments[0].translation = 42; },
    x => { x.books[0].extra = 'invalid'; }, x => { x.books[0].completed = [0, 0]; }
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(snapshot); mutate(invalid);
    assert.throws(() => library.importData(invalid), /备份/);
    assert.deepEqual(library.exportData(), snapshot);
  }
});
test('corrupt main file recovers validated backup and preserves corruption evidence', t => {
  const { dir, library } = setup(t);
  library.importText({ title: '保留本', text: '不要丢失。' });
  library.saveProgress({ bookId: library.getState().activeBookId, position: 0, draft: '' });
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'library.json.bak'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'library.json'), '{broken');
  const recovered = new backend.Library(dir);
  assert.deepEqual(recovered.exportData(), expected);
  assert.ok(fs.readdirSync(dir).some(name => name.startsWith('library.corrupt-')));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8')));
});
test('two corrupt copies fail closed instead of silently replacing books with demo', t => {
  const { dir } = setup(t);
  fs.writeFileSync(path.join(dir, 'library.json'), '{broken');
  fs.writeFileSync(path.join(dir, 'library.json.bak'), '{also broken');
  assert.throws(() => new backend.Library(dir), /损坏|恢复/);
  assert.equal(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'), '{broken');
});
test('public state and backup cannot leak extra credential fields', t => {
  const { library } = setup(t);
  const state = library.getState({ provider: 'glm', baseUrl: 'https://example.com', model: 'glm-4.7-flash', hasKey: true, apiKey: 'fixture-key' });
  assert.equal('apiKey' in state.settings, false);
  assert.equal(JSON.stringify(library.exportData()).includes('fixture-key'), false);
});
test('manual translation normalizes curly punctuation and clears obsolete current draft', t => {
  const { library } = setup(t);
  const id = library.getState().activeBookId;
  library.saveProgress({ bookId: id, position: 0, draft: 'Old draft' });
  library.setTranslation({ bookId: id, index: 0, translation: '“Don’t wait…”' });
  assert.equal(library.getSegment(id, 0).translation, '"Don\'t wait..."');
  assert.equal(library.getState().books[0].draft, '');
});
test('failed disk write leaves current in-memory books and main file unchanged', t => {
  const { dir, library } = setup(t);
  const original = library.exportData();
  const originalWrite = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === path.join(dir, 'library.json')) throw new Error('disk failure secret details');
    return originalWrite(source, destination);
  });
  assert.throws(() => library.importText({ title: 'Not saved', text: '新内容。' }), /保存失败/);
  assert.deepEqual(library.exportData(), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8')), original);
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
});
test('ordinary long lines do not create an untranslatable blank passage between them', t => {
  const { library } = setup(t);
  const text = '甲'.repeat(260) + '\n' + '乙'.repeat(400);
  const state = library.importText({ title: '长行', text });
  const book = state.books.find(b => b.id === state.activeBookId);
  assert.equal(book.segments.map(s => s.source).join(''), text);
  assert.ok(book.segments.every(s => s.source.trim().length > 0));
});
test('missing primary recovers from valid backup instead of creating a new demo', t => {
  const { dir, library } = setup(t);
  library.importText({ title: 'Saved', text: '保留内容。' });
  library.selectBook(library.getState().activeBookId);
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'library.json.bak'), 'utf8'));
  fs.unlinkSync(path.join(dir, 'library.json'));
  assert.deepEqual(new backend.Library(dir).exportData(), expected);
});
test('single-character completion with zero elapsed time persists without blocking close', t => {
  const { dir, library } = setup(t);
  const state = library.importText({ title: '一个字', text: '我。' });
  const id = state.activeBookId;
  library.setTranslation({ bookId: id, index: 0, translation: 'I' });
  const progress = { bookId: id, position: 0, draft: 'I', completed: 0, session: { characters: 1, seconds: 0, accuracy: 100, wpm: 0 } };
  library.saveProgress(progress);
  library.saveProgress(progress);
  const book = new backend.Library(dir).getState().books.find(item => item.id === id);
  assert.deepEqual(book.completed, [0]);
  assert.deepEqual(book.stats, { sessions: 1, characters: 1, seconds: 0 });
  assert.throws(() => library.saveProgress({ ...progress, session: { ...progress.session, wpm: 1 } }), /统计/);
});
