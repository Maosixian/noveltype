// Exercise a real Electron IPC/typing session with synthetic books only.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tempRoot = path.resolve(os.tmpdir());
const data = fs.mkdtempSync(path.join(tempRoot, 'noveltype-performance-'));
const reportPath = path.join(root, 'evidence', 'performance-tests.json');
const source = '山'.repeat(225) + '。';
const books = Array.from({ length: 6 }, (_, bookIndex) => ({
  id: `performance-${bookIndex}`,
  title: `合成性能书 ${bookIndex + 1}`,
  segments: Array.from({ length: 10000 }, (_, index) => ({
    source,
    translation: index < 6 ? `Line ${index + 1}.` : '',
  })),
  position: 0,
  completed: [],
  draft: '',
  stats: { sessions: 0, characters: 0, seconds: 0 },
  demo: false,
}));
fs.writeFileSync(path.join(data, 'library.json'), JSON.stringify({ version: 1, books, activeBookId: books[0].id }));
const env = { ...process.env, NOVELTYPE_TEST_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
const report = {
  at: new Date().toISOString(),
  scope: 'Isolated synthetic 6-book library; no user content or API credentials',
  libraryBytes: fs.statSync(path.join(data, 'library.json')).size,
  segments: 60000,
  saves: [],
  passed: false,
};
let app;
let page;
async function launch() {
  app = await _electron.launch({ args: [root], env, timeout: 30000 });
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(path.resolve(userData), path.resolve(data), 'Performance checks must use their temporary profile');
  page = await app.firstWindow();
  await page.locator('#book-title').waitFor({ state: 'visible', timeout: 30000 });
  await app.evaluate(({ net }) => {
    globalThis.performanceRequests = 0;
    net.fetch = async () => { globalThis.performanceRequests++; throw new Error('Unexpected network request in synthetic performance check'); };
  });
}
async function startClocks() {
  await app.evaluate(() => {
    globalThis.performanceMainGaps = [];
    let last = performance.now();
    globalThis.performanceMainTimer = setInterval(() => {
      const current = performance.now();
      performanceMainGaps.push(current - last);
      last = current;
    }, 10);
  });
  await page.evaluate(() => {
    globalThis.performanceRendererGaps = [];
    let last = performance.now();
    globalThis.performanceRendererTimer = setInterval(() => {
      const current = performance.now();
      performanceRendererGaps.push(current - last);
      last = current;
    }, 10);
  });
}
async function stopClocks() {
  return {
    maxMainLoopGapMs: await app.evaluate(() => {
      clearInterval(performanceMainTimer);
      return Math.round(Math.max(0, ...performanceMainGaps) * 10) / 10;
    }),
    maxRendererLoopGapMs: await page.evaluate(() => {
      clearInterval(performanceRendererTimer);
      return Math.round(Math.max(0, ...performanceRendererGaps) * 10) / 10;
    }),
  };
}
async function waitSaved() {
  await page.waitForFunction(() => document.querySelector('#save-state').textContent.startsWith('✓'), null, { timeout: 20000 });
}
async function closeGracefully() {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  app = null;
}

(async () => {
  try {
    await launch();
    await startClocks();
    for (const draft of ['L', 'Li', 'Lin']) {
      const sample = await page.evaluate(async draft => {
        const start = performance.now();
        const ack = await window.novel.saveProgress({ bookId: 'performance-0', position: 0, draft });
        const milliseconds = Math.round((performance.now() - start) * 10) / 10;
        return { milliseconds, ackBytes: new TextEncoder().encode(JSON.stringify(ack)).byteLength, bookId: ack.bookId, position: ack.position, draft: ack.draft };
      }, draft);
      report.saves.push(sample);
      assert.ok(sample.ackBytes < 10000, `A progress save must return a compact ACK, received ${sample.ackBytes} bytes`);
      assert.equal(sample.bookId, 'performance-0');
      assert.equal(sample.position, 0);
      assert.equal(sample.draft, draft);
      await page.waitForTimeout(30);
    }
    report.saveTiming = await stopClocks();
    await page.evaluate(() => window.novel.saveProgress({ bookId: 'performance-0', position: 0, draft: '' }));
    await page.reload();
    await page.locator('.story-passage.is-active').waitFor({ state: 'visible' });
    await startClocks();
    const input = page.locator('#typing-input');
    await input.click();
    await input.pressSequentially('lINE 1.lINE 2.Li', { delay: 12 });
    assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'), '2');
    assert.equal(await input.inputValue(), 'Li', 'Fast typing must preserve the draft after both automatic transitions');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'typing-input');
    await waitSaved();
    report.typingTiming = await stopClocks();
    assert.equal(await app.evaluate(() => performanceRequests), 0, 'Typing cached passages must not send AI requests');
    const progress = await page.evaluate(async () => {
      const state = await window.novel.getState();
      const book = state.books.find(item => item.id === 'performance-0');
      return { position: book.position, draft: book.draft, completed: book.completed, stats: book.stats };
    });
    assert.equal(progress.position, 2);
    assert.equal(progress.draft, 'Li');
    assert.deepEqual(progress.completed, [0, 1]);
    assert.equal(progress.stats.sessions, 2);
    await closeGracefully();
    await launch();
    assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'), '2');
    assert.equal(await page.locator('#typing-input').inputValue(), 'Li');
    const restored = await page.evaluate(async () => {
      const state = await window.novel.getState();
      const book = state.books.find(item => item.id === 'performance-0');
      return { position: book.position, draft: book.draft, completed: book.completed, stats: book.stats };
    });
    assert.deepEqual(restored, progress, 'Restart must restore exact completions, statistics, and current draft');
    assert.equal(await app.evaluate(() => performanceRequests), 0);
    report.fastTypingAndFocus = true;
    report.restartProgress = true;
    report.aiRequests = 0;
    report.passed = true;
    console.log(JSON.stringify(report));
  } finally {
    if (app) await app.close();
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    const cleanup = path.resolve(data);
    assert.equal(path.dirname(cleanup), tempRoot);
    assert.ok(path.basename(cleanup).startsWith('noveltype-performance-'));
    fs.rmSync(cleanup, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
