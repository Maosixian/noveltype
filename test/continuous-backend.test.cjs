const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Library } = require('../app/library.cjs');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltype-continuous-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, library: new Library(dir) };
}
const completion = { characters: 3, seconds: 1, accuracy: 100, wpm: 36 };

test('completion and advance can commit together, with duplicate completion deduplicated after restart', t => {
  const { dir, library } = setup(t);
  const bookId = library.getState().activeBookId;
  const advance = { bookId, position: 1, draft: '', completed: 0, session: completion };
  library.saveProgress(advance);
  library.saveProgress({ bookId, position: 1, draft: 'He' });
  const reopened = new Library(dir);
  reopened.saveProgress({ ...advance, draft: 'He' });
  const book = reopened.getState().books[0];
  assert.equal(book.position, 1);
  assert.equal(book.draft, 'He');
  assert.deepEqual(book.completed, [0]);
  assert.deepEqual(book.stats, { sessions: 1, characters: 3, seconds: 1 });
});

test('prefetch translation commit preserves current draft, progress, and unrelated settings bytes', t => {
  const { dir, library } = setup(t);
  const bookId = library.getState().activeBookId;
  const settingsPath = path.join(dir, 'settings.json');
  const fixture = '{"provider":"fixture","encryptedKey":"synthetic-encrypted-value"}';
  fs.writeFileSync(settingsPath, fixture);
  library.saveProgress({ bookId, position: 0, draft: 'At dawn, ' });
  library.setTranslation({ bookId, index: 1, translation: 'The next passage is ready.' });
  const reopened = new Library(dir).getState().books[0];
  assert.equal(reopened.position, 0);
  assert.equal(reopened.draft, 'At dawn, ');
  assert.equal(reopened.segments[1].translation, 'The next passage is ready.');
  assert.deepEqual(reopened.stats, { sessions: 0, characters: 0, seconds: 0 });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), fixture);
});

test('failed completion can be retried before the current draft without losing either completion', t => {
  const { dir, library } = setup(t);
  const bookId = library.getState().activeBookId;
  library.saveProgress({ bookId, position: 0, draft: 'A' });
  const originalSync = fs.fsyncSync;
  let failOnce = true;
  t.mock.method(fs, 'fsyncSync', (fd) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('synthetic disk failure');
    }
    return originalSync(fd);
  });
  const first = { bookId, position: 0, draft: library.getSegment(bookId, 0).translation, completed: 0, session: completion };
  assert.throws(() => library.saveProgress(first), /保存失败/);
  assert.deepEqual(library.getState().books[0].completed, []);
  library.saveProgress(first);
  library.saveProgress({ bookId, position: 1, draft: library.getSegment(bookId, 1).translation, completed: 1, session: completion });
  library.saveProgress({ bookId, position: 2, draft: 'An old' });
  const book = new Library(dir).getState().books[0];
  assert.equal(book.position, 2);
  assert.equal(book.draft, 'An old');
  assert.deepEqual(book.completed, [0, 1]);
  assert.deepEqual(book.stats, { sessions: 2, characters: 6, seconds: 2 });
});

test('full-book completion keeps the last position and rejects an extra advance without mutation', t => {
  const { dir, library } = setup(t);
  const initial = library.getState().books[0];
  for (let index = 0; index < initial.segments.length; index++) {
    library.saveProgress({
      bookId: initial.id,
      position: Math.min(index + 1, initial.segments.length - 1),
      draft: index === initial.segments.length - 1 ? initial.segments[index].translation : '',
      completed: index,
      session: completion,
    });
  }
  const expected = library.exportData();
  assert.throws(() => library.saveProgress({ bookId: initial.id, position: initial.segments.length, draft: '' }), /段落/);
  assert.deepEqual(library.exportData(), expected);
  const book = new Library(dir).getState().books[0];
  assert.equal(book.position, initial.segments.length - 1);
  assert.equal(book.completed.length, initial.segments.length);
  assert.equal(book.stats.sessions, initial.segments.length);
  assert.equal(book.draft, initial.segments.at(-1).translation);
});
