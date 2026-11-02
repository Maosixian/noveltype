// Renderer hot-path regression. Synthetic text and an isolated Electron profile only.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltype-typing-latency-'));
const baseline = process.argv.includes('--baseline');
const translation = 'The quiet river carried silver light beyond the sleeping town. '.repeat(20);
const book = { id: 'latency-fixture', title: '合成输入延迟测试', segments: [{ source: '河水流过安静的小镇。', translation }], position: 0, completed: [], draft: '', stats: { sessions: 0, characters: 0, seconds: 0 }, demo: false };
fs.writeFileSync(path.join(data, 'library.json'), JSON.stringify({ version: 1, books: [book], activeBookId: book.id }));
const env = { ...process.env, NOVELTYPE_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
let app;
(async () => {
  try {
    app = await _electron.launch({ args: [root], env, timeout: 30000 });
    assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), path.resolve(data));
    await app.evaluate(({ net }) => { globalThis.latencyRequests = 0; net.fetch = async () => { latencyRequests++; throw new Error('No API calls in typing benchmark'); }; });
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.locator('#translation-text .target-char').first().waitFor();
    await page.waitForTimeout(100);
    const report = await page.evaluate(async () => {
      const input = document.querySelector('#typing-input'), target = document.querySelector('#translation-text');
      const text = target.textContent, first = target.firstChild;
      let added = 0, removed = 0, mutations = 0;
      const observer = new MutationObserver(records => { for (const record of records) { mutations++; added += record.addedNodes.length; removed += record.removedNodes.length; } });
      observer.observe(target, { subtree: true, childList: true, attributes: true });
      input.focus(); const durations = [], frames = []; let last = performance.now();
      for (let i = 1; i <= 180; i++) {
        await new Promise(resolve => requestAnimationFrame(time => { frames.push(time - last); last = time; resolve(); }));
        input.value = text.slice(0, i).toUpperCase(); input.setSelectionRange(i, i);
        const start = performance.now();
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text[i - 1] }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: text[i - 1] }));
        input.dispatchEvent(new Event('select', { bubbles: true }));
        durations.push(performance.now() - start);
      }
      await new Promise(resolve => requestAnimationFrame(resolve)); observer.disconnect();
      const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
      return { inputEvents: durations.length, passageCharacters: text.length, addedCharacterNodes: added, removedCharacterNodes: removed, targetMutations: mutations, stableFirstNode: first === target.firstChild, syncHandlerP50Ms: percentile(durations, .5), syncHandlerP95Ms: percentile(durations, .95), syncHandlerMaxMs: Math.max(...durations), frameP95Ms: percentile(frames.slice(1), .95), draftPreserved: input.value === text.slice(0, 180).toUpperCase(), focused: document.activeElement === input, wrongCount: target.querySelectorAll('.wrong').length };
    });
    report.scope = '180 synthetic uppercase input/keyup/select sets; 1,260-character passage; real Electron renderer; timings exclude physical keyboard latency';
    report.apiRequests = await app.evaluate(() => latencyRequests); report.rendererErrors = errors;
    fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(root, 'evidence', `typing-latency-${baseline ? 'before' : 'after'}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    assert.equal(report.apiRequests, 0); assert.equal(report.draftPreserved, true); assert.equal(report.focused, true); assert.equal(report.wrongCount, 0); assert.deepEqual(errors, []);
    if (!baseline) {
      assert.equal(report.stableFirstNode, true, 'Keystrokes must retain existing target nodes');
      assert.equal(report.addedCharacterNodes, 0, 'Existing characters must not be recreated for input or cursor events');
      assert.ok(report.targetMutations < 180 * 15, 'DOM work must be bounded to the changed characters');
      const motion = await page.evaluate(async () => {
        const { createTypingFeedback } = await import('./typing-feedback.mjs');
        const panel = document.createElement('section'); const bottom = document.createElement('div'); bottom.className = 'typing-bottom'; panel.append(bottom); document.body.append(panel);
        const letter = document.createElement('span'); letter.textContent = 'a'; panel.append(letter);
        const feedback = createTypingFeedback({ panel });
        const setMode = mode => { document.documentElement.dataset.motion = mode; window.dispatchEvent(new Event('noveltype:motion-change')); };
        setMode('full');feedback.input({ before:'', value:'a', target:'a test', complete:false, error:false, nodes:[letter] });
        const full = letter.getAnimations().length;
        setMode('reduced');const cancelled = letter.getAnimations().length === 0;
        feedback.input({ before:'a', value:'a ', target:'a test', complete:false, error:false, nodes:[letter, letter] });
        const reduced = panel.getAnimations({subtree:true}).length === 0 && !panel.querySelector('.typing-feedback').hidden;
        setMode('off');feedback.input({ before:'a ', value:'a test', target:'a test', complete:true, error:false, nodes:[] });
        const off = panel.getAnimations({subtree:true}).length === 0 && panel.querySelector('.typing-feedback').hidden;
        feedback.reset();setMode('full');
        feedback.input({ before:'a', value:'a ', target:'a test', complete:false, error:false, nodes:[] });
        feedback.input({ before:'a ', value:'a', target:'a test', complete:false, error:false, nodes:[] });
        feedback.input({ before:'a', value:'a ', target:'a test', complete:false, error:false, nodes:[] });
        const noDuplicateWord = panel.querySelector('.typing-feedback').textContent === '节奏很好';
        feedback.reset();panel.remove();setMode('full');
        return { full, cancelled, reduced, off, noDuplicateWord };
      });
      assert.equal(motion.full, 1); assert.equal(motion.cancelled, true); assert.equal(motion.reduced, true); assert.equal(motion.off, true);
      assert.equal(motion.noDuplicateWord, true, 'Backspace and retyping must not inflate word streaks');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const reducedBySystem = await page.evaluate(async () => {
        const input = document.querySelector('#typing-input');
        input.value += document.querySelector('#translation-text').textContent[180]; input.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText' }));
        return document.querySelector('#translation-text').getAnimations({subtree:true}).length;
      });
      assert.equal(reducedBySystem, 0, 'System reduced-motion preference must override full motion');
      report.motionChecks = { ...motion, systemReducedMotion:true };
    }
    report.passed = true;
    fs.writeFileSync(path.join(root, 'evidence', `typing-latency-${baseline ? 'before' : 'after'}.json`), JSON.stringify(report, null, 2));
  } finally {
    if (app) await app.close();
    assert.equal(path.dirname(data), path.resolve(os.tmpdir()));
    assert.ok(path.basename(data).startsWith('noveltype-typing-latency-'));
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
