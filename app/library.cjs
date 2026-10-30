'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { normalizeTypography } = require('./translation.cjs');

const MAX_BOOK_BYTES = 10 * 1024 * 1024;
const MAX_LIBRARY_BYTES = 64 * 1024 * 1024;
const MAX_SEGMENTS = 100000;
const MAX_TRANSLATION = 10000;
const MAX_BOOKS = 100;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');
const validStats = stats => exactKeys(stats, ['sessions', 'characters', 'seconds']) && integer(stats.sessions, 0, 1000000000) && integer(stats.characters, 0, 1000000000000) && bounded(stats.seconds, 0, 1000000000000);
const progressFields = book => ({ position: book.position, draft: book.draft, completed: book.completed, stats: book.stats });
const clone = value => structuredClone(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const bounded = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const integer = (value, min, max) => Number.isInteger(value) && bounded(value, min, max);
const validText = (value, max, empty = true) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) && value.isWellFormed();
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// Keep every source character, including chapter headings and line breaks.
function chunkText(text) {
  const chunks = [];
  let current = '';
  const flush = () => { if (current) chunks.push(current); current = ''; };
  const append = part => {
    if (current.length + part.length > 260) {
      if (current && !current.trim()) { part = current + part; current = ''; }
      else flush();
    }
    while (part.length > 260) {
      let end = 260;
      const code = part.charCodeAt(end - 1);
      if (code >= 0xD800 && code <= 0xDBFF) end--;
      chunks.push(part.slice(0, end));
      part = part.slice(end);
    }
    current += part;
  };
  for (const line of text.match(/[^\n]*(?:\n|$)/g) || []) {
    if (!line) continue;
    if (/^\s*(?:第[零〇一二三四五六七八九十百千万两\d]+[章回卷节部篇]|序章|楔子|尾声|后记|chapter\s+\d+)/i.test(line)) flush();
    let start = 0;
    const endings = /[。！？!?；;][”’」』）"']*/g;
    for (const match of line.matchAll(endings)) {
      const end = match.index + match[0].length;
      append(line.slice(start, end));
      start = end;
    }
    if (start < line.length) append(line.slice(start));
  }
  flush();
  return chunks.map(source => ({ source, translation: '' }));
}

function validateData(data) {
  const fail = () => { throw new Error('备份格式不正确或数据超出限制，书库未更改。'); };
  if (!exactKeys(data, ['version', 'books', 'activeBookId']) || data.version !== 1 || !Array.isArray(data.books) || data.books.length < 1 || data.books.length > MAX_BOOKS) fail();
  const ids = new Set();
  let totalBytes = 0;
  for (const book of data.books) {
    if (!exactKeys(book, ['id', 'title', 'segments', 'position', 'completed', 'draft', 'stats', 'demo']) || typeof book.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(book.id) || ids.has(book.id)) fail();
    ids.add(book.id);
    if (!validText(book.title, 200, false) || typeof book.demo !== 'boolean' || !validText(book.draft, MAX_TRANSLATION) || !Array.isArray(book.segments) || book.segments.length < 1 || book.segments.length > MAX_SEGMENTS || !integer(book.position, 0, book.segments.length - 1)) fail();
    let sourceBytes = 0;
    let hasContent = false;
    for (const segment of book.segments) {
      if (!exactKeys(segment, ['source', 'translation']) || !validText(segment.source, 260) || segment.source.length === 0 || !validText(segment.translation, MAX_TRANSLATION)) fail();
      sourceBytes += Buffer.byteLength(segment.source, 'utf8');
      totalBytes += Buffer.byteLength(segment.translation, 'utf8') + Buffer.byteLength(segment.source, 'utf8');
      if (sourceBytes > MAX_BOOK_BYTES || totalBytes > MAX_LIBRARY_BYTES) fail();
      hasContent ||= segment.source.trim().length > 0;
    }
    if (!hasContent || !Array.isArray(book.completed) || book.completed.length > book.segments.length || new Set(book.completed).size !== book.completed.length || book.completed.some(index => !integer(index, 0, book.segments.length - 1))) fail();
    if (!exactKeys(book.stats, ['sessions', 'characters', 'seconds']) || !integer(book.stats.sessions, 0, 1000000000) || !integer(book.stats.characters, 0, 1000000000000) || !bounded(book.stats.seconds, 0, 1000000000000)) fail();
  }
  if (!ids.has(data.activeBookId)) fail();
  return clone(data);
}

function demoData() {
  const book = {
    id: 'demo-lighthouse', title: '灯塔来信 · 原创双语示例', demo: true,
    segments: [
      { source: '清晨，林舟推开旧书店的门。窗边放着一封没有邮票的信，信封上只写着两个字：灯塔。', translation: 'At dawn, Lin pushed open the door of the old bookshop. A letter without a stamp lay by the window. Only two words were written on the envelope: The Lighthouse.' },
      { source: '他沿着河边的小路走去。昨夜的雨已经停了，树叶上的水珠映着微光。远处，一艘蓝色的小船正缓缓靠岸。', translation: 'He followed the path beside the river. The rain had stopped, and drops of water caught the light on the leaves. In the distance, a small blue boat was coming ashore.' },
      { source: '船上的老人递给他一把铜钥匙。“有些门，”老人说，“只为愿意停下来听的人打开。”林舟把钥匙握在手心，听见了海浪。', translation: 'An old man on the boat handed him a brass key. "Some doors," the man said, "open only for those who stop to listen." Lin held the key in his palm and listened to the waves.' },
      { source: '灯塔里没有宝箱，只有一本摊开的日记。第一页写着：如果你找到这里，请为下一位旅人留下一句话。林舟坐下来，想了很久。', translation: 'There was no treasure chest in the lighthouse, only an open journal. The first page read: If you find this place, leave a sentence for the next traveler. Lin sat down and thought for a while.' },
      { source: '最后，他写道：“你不必知道整条路，才能迈出第一步。”傍晚回到书店时，他把门口的灯调亮了一点。', translation: 'At last, he wrote, "You do not need to know the whole road to take the first step." When he returned to the bookshop that evening, he turned the light by the door a little brighter.' }
    ],
    position: 0, completed: [], draft: '', stats: { sessions: 0, characters: 0, seconds: 0 }
  };
  return { version: 1, books: [book], activeBookId: book.id };
}

function atomicWrite(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

class Library {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'library.json');
    this.backup = `${this.file}.bak`;
    this.journal = path.join(dataDir, 'library.journal.jsonl');
    this.journalBase = path.join(dataDir, 'library.journal-base.json');
    this.journalReady = false;
    this.journalSequence = 0;
    this.journalBytes = 0;
    this.writeFailed = false;
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = this._load();
    this.serializedBytes = jsonBytes(this.state);
  }

  _read(file) {
    if (fs.statSync(file).size > MAX_LIBRARY_BYTES) throw new Error('书库超过大小限制');
    return validateData(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  _loadSnapshot() {
    const hasMain = fs.existsSync(this.file);
    const hasBackup = fs.existsSync(this.backup);
    if (!hasMain && !hasBackup) {
      const initial = demoData();
      const text = JSON.stringify(initial);
      atomicWrite(this.backup, text);
      atomicWrite(this.file, text);
      return initial;
    }
    if (hasMain) {
      try { return this._read(this.file); } catch { /* Try only a validated backup. */ }
    }
    let restored;
    try { restored = this._read(this.backup); } catch { throw new Error('本地书库与备份损坏，无法自动恢复。请保留数据目录并导入有效备份。'); }
    if (hasMain) fs.copyFileSync(this.file, path.join(this.dataDir, `library.corrupt-${Date.now()}-${randomUUID()}.json`));
    atomicWrite(this.file, JSON.stringify(restored));
    return restored;
  }

  _load() {
    if (!fs.existsSync(this.journal)) return this._loadSnapshot();
    try {
      const size = fs.statSync(this.journal).size;
      if (size > MAX_JOURNAL_BYTES || size < 1) throw new Error('invalid journal size');
      const bytes = fs.readFileSync(this.journal);
      const completeLength = bytes.lastIndexOf(10) + 1;
      if (!completeLength) throw new Error('missing journal header');
      const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, completeLength)).split('\n');
      lines.pop();
      const header = JSON.parse(lines.shift());
      if (!exactKeys(header, ['version', 'baseSha256']) || header.version !== 1 || typeof header.baseSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(header.baseSha256)) throw new Error('invalid journal header');
      if (fs.statSync(this.journalBase).size > MAX_LIBRARY_BYTES) throw new Error('invalid journal base');
      const base = fs.readFileSync(this.journalBase);
      if (digest(base) !== header.baseSha256) throw new Error('journal base mismatch');
      this.state = validateData(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base)));
      this.serializedBytes = jsonBytes(this.state);
      for (const line of lines) {
        const record = JSON.parse(line);
        if (!exactKeys(record, ['sequence', 'change']) || record.sequence !== this.journalSequence + 1) throw new Error('invalid journal sequence');
        const change = this._buildChange(record.change);
        change.apply(); this.serializedBytes += change.delta;
        this.journalSequence = record.sequence;
      }
      this.journalBytes = completeLength;
      this.journalReady = true;
      let primary;
      try { primary = fs.readFileSync(this.file); } catch { /* Recover from the bound journal base. */ }
      if (!primary || digest(primary) !== header.baseSha256) {
        // A completed checkpoint can reach the primary file before the old journal is removed.
        // Any other valid primary is an unrelated restore: do not replay old progress over it.
        let primaryData;
        if (primary) { try { primaryData = validateData(JSON.parse(primary.toString('utf8'))); } catch { /* corrupt primary */ } }
        if (primaryData && JSON.stringify(primaryData) !== JSON.stringify(this.state)) throw new Error('primary and journal mismatch');
        if (primary && !primaryData) fs.copyFileSync(this.file, path.join(this.dataDir, `library.corrupt-${Date.now()}-${randomUUID()}.json`));
        if (completeLength !== bytes.length) fs.copyFileSync(this.journal, path.join(this.dataDir, `library.journal.corrupt-${Date.now()}-${randomUUID()}.jsonl`));
        this._checkpoint();
      } else if (completeLength !== bytes.length) {
        // Only an incomplete final record is recoverable. Complete malformed records fail closed.
        fs.copyFileSync(this.journal, path.join(this.dataDir, `library.journal.corrupt-${Date.now()}-${randomUUID()}.jsonl`));
        const fd = fs.openSync(this.journal, 'r+');
        try { fs.ftruncateSync(fd, completeLength); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      return this.state;
    } catch {
      throw new Error('本地进度日志损坏或与书库不匹配，原文件已保留。请保留整个数据目录后恢复完整备份。');
    }
  }

  _checkpoint() {
    if (!this.journalReady) return;
    const text = JSON.stringify(this.state);
    // Both snapshots include every acknowledged change before journal removal. A crash before
    // removal can replay the old bound base; a crash after removal uses either complete snapshot.
    atomicWrite(this.backup, text);
    atomicWrite(this.file, text);
    fs.unlinkSync(this.journal);
    this.journalReady = false; this.journalSequence = 0; this.journalBytes = 0;
    // An orphan base is harmless and will be replaced before the next journal header is committed.
  }

  _ensureJournal() {
    if (this.journalReady) return;
    const base = fs.readFileSync(this.file);
    atomicWrite(this.journalBase, base);
    const header = JSON.stringify({ version: 1, baseSha256: digest(base) }) + '\n';
    atomicWrite(this.journal, header);
    this.journalReady = true; this.journalSequence = 0; this.journalBytes = Buffer.byteLength(header);
  }

  _append(change) {
    this._assertWritable();
    let fd, originalLength;
    try {
      let text = JSON.stringify({ sequence: this.journalSequence + 1, change }) + '\n';
      if (this.journalReady && this.journalBytes + Buffer.byteLength(text) > MAX_JOURNAL_BYTES) this._checkpoint();
      this._ensureJournal();
      text = JSON.stringify({ sequence: this.journalSequence + 1, change }) + '\n';
      if (this.journalBytes + Buffer.byteLength(text) > MAX_JOURNAL_BYTES) throw new Error('change too large');
      fd = fs.openSync(this.journal, 'r+');
      originalLength = fs.fstatSync(fd).size;
      if (originalLength !== this.journalBytes) { this.writeFailed = true; throw new Error('journal changed externally'); }
      const written = fs.writeSync(fd, text, originalLength, 'utf8');
      if (written !== Buffer.byteLength(text)) throw new Error('short write');
      fs.fsyncSync(fd);
      this.journalBytes += written; this.journalSequence++;
    } catch {
      if (fd !== undefined && originalLength !== undefined && !this.writeFailed) {
        try { fs.ftruncateSync(fd, originalLength); fs.fsyncSync(fd); } catch { this.writeFailed = true; }
      }
      throw new Error('本地保存失败，请检查磁盘空间和数据目录权限。');
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {
          this.writeFailed = true;
          throw new Error('本地保存失败，请重启软件恢复进度日志后重试。');
        }
      }
    }
  }

  _buildChange(record) {
    if (!plain(record)) throw new Error('进度日志格式不正确。');
    const book = this._book(record.bookId);
    let delta, apply;
    if (record.type === 'progress') {
      if (!exactKeys(record, ['type', 'bookId', 'position', 'draft', 'completed', 'stats']) || !validText(record.draft, MAX_TRANSLATION) || !validStats(record.stats)) throw new Error('练习统计或进度格式不正确。');
      this._index(book, record.position);
      let completed = book.completed;
      if (record.completed !== null) {
        this._index(book, record.completed);
        if (!book.segments[record.completed].translation) throw new Error('请先为该段落添加译文。');
        if (!completed.includes(record.completed)) completed = [...completed, record.completed].sort((a,b) => a-b);
      }
      const next = { position: record.position, draft: record.draft, completed, stats: clone(record.stats) };
      delta = jsonBytes(next) - jsonBytes(progressFields(book));
      apply = () => Object.assign(book, next);
    } else if (record.type === 'translation') {
      if (!exactKeys(record, ['type', 'bookId', 'index', 'translation', 'clearDraft']) || !validText(record.translation, MAX_TRANSLATION, false) || typeof record.clearDraft !== 'boolean') throw new Error('译文日志格式不正确。');
      this._index(book, record.index);
      const segment = book.segments[record.index];
      delta = jsonBytes(record.translation) - jsonBytes(segment.translation) + (record.clearDraft ? jsonBytes('') - jsonBytes(book.draft) : 0);
      apply = () => { segment.translation = record.translation; if (record.clearDraft) book.draft = ''; };
    } else if (record.type === 'select') {
      if (!exactKeys(record, ['type', 'bookId'])) throw new Error('选书日志格式不正确。');
      delta = jsonBytes(record.bookId) - jsonBytes(this.state.activeBookId);
      apply = () => { this.state.activeBookId = record.bookId; };
    } else throw new Error('进度日志类型不正确。');
    if (this.serializedBytes + delta > MAX_LIBRARY_BYTES) throw new Error('书库容量超过 64 MB，请先导出备份。');
    return { delta, apply };
  }

  _change(record) {
    const change = this._buildChange(record);
    this._append(record);
    change.apply(); this.serializedBytes += change.delta;
  }

  _progressResult(book) { return clone({ bookId: book.id, ...progressFields(book) }); }

  _assertWritable() {
    if (this.writeFailed) throw new Error('本地保存失败，请重启软件恢复进度日志后重试。');
  }

  _commit(next) {
    this._assertWritable();
    const valid = validateData(next);
    const text = JSON.stringify(valid);
    if (Buffer.byteLength(text, 'utf8') > MAX_LIBRARY_BYTES) throw new Error('书库容量超过 64 MB，请先导出备份。');
    try {
      this._checkpoint();
      atomicWrite(this.backup, JSON.stringify(this.state));
      atomicWrite(this.file, text);
    } catch { throw new Error('本地保存失败，请检查磁盘空间和数据目录权限。'); }
    this.state = valid;
    this.serializedBytes = Buffer.byteLength(text, 'utf8');
    return this.getState();
  }

  _book(id, data = this.state) {
    if (typeof id !== 'string') throw new Error('书籍标识不正确。');
    const book = data.books.find(item => item.id === id);
    if (!book) throw new Error('找不到这本书籍，请重新选择。');
    return book;
  }

  _index(book, index) {
    if (!integer(index, 0, book.segments.length - 1)) throw new Error('段落位置不正确。');
  }

  getState(settingsPublic = {}) {
    const settings = {};
    for (const name of ['provider', 'baseUrl', 'model', 'hasKey']) if (Object.hasOwn(settingsPublic, name)) settings[name] = settingsPublic[name];
    return clone({ books: this.state.books, activeBookId: this.state.activeBookId, settings });
  }

  importText(payload) {
    this._assertWritable();
    if (!plain(payload) || !validText(payload.text, MAX_BOOK_BYTES, false)) throw new Error('小说内容为空、格式不正确或超过 10 MB。');
    if (Buffer.byteLength(payload.text, 'utf8') > MAX_BOOK_BYTES) throw new Error('小说大小不能超过 10 MB。');
    if (!validText(payload.title, 200, false)) throw new Error('书籍标题需为 1 至 200 个字符。');
    if (this.state.books.length >= MAX_BOOKS) throw new Error('书库最多可保存 100 本书。');
    const segments = chunkText(payload.text);
    if (segments.length > MAX_SEGMENTS) throw new Error('小说段落过多，请拆分为较小的文件。');
    const book = { id: randomUUID(), title: payload.title.trim(), segments, position: 0, completed: [], draft: '', stats: { sessions: 0, characters: 0, seconds: 0 }, demo: false };
    const next = clone(this.state);
    next.books.push(book); next.activeBookId = book.id;
    return this._commit(next);
  }

  selectBook(id) {
    this._assertWritable();
    this._book(id);
    if (this.state.activeBookId !== id) this._change({ type: 'select', bookId: id });
    return this.getState();
  }

  saveProgress(payload) {
    this._assertWritable();
    if (!plain(payload)) throw new Error('进度格式不正确。');
    const book = this._book(payload.bookId);
    this._index(book, payload.position);
    if (!validText(payload.draft, MAX_TRANSLATION)) throw new Error('输入内容格式不正确或过长。');
    if (payload.completed !== undefined) this._index(book, payload.completed);
    const session = payload.session;
    if (session !== undefined && (!exactKeys(session, ['characters', 'seconds', 'accuracy', 'wpm']) || !integer(session.characters, 0, MAX_TRANSLATION) || !bounded(session.seconds, 0, 86400) || !bounded(session.accuracy, 0, 100) || !bounded(session.wpm, 0, 10000) || (session.seconds === 0 && session.wpm !== 0))) throw new Error('练习统计格式不正确。');
    const stats = clone(book.stats);
    let completed = null;
    if (payload.completed !== undefined && !book.completed.includes(payload.completed)) {
      if (!book.segments[payload.completed].translation) throw new Error('请先为该段落添加译文。');
      completed = payload.completed;
      if (session) {
        stats.sessions++;
        stats.characters += session.characters;
        stats.seconds += session.seconds;
      }
    }
    if (book.position !== payload.position || book.draft !== payload.draft || completed !== null) this._change({ type: 'progress', bookId: book.id, position: payload.position, draft: payload.draft, completed, stats });
    return this._progressResult(book);
  }

  setTranslation(payload) {
    this._assertWritable();
    if (!plain(payload) || !validText(payload.translation, MAX_TRANSLATION, false)) throw new Error('译文不能为空或超过 10000 个字符。');
    const book = this._book(payload.bookId);
    this._index(book, payload.index);
    const translation = normalizeTypography(payload.translation);
    if (translation.length > MAX_TRANSLATION) throw new Error('译文超过 10000 个字符。');
    if (book.segments[payload.index].translation !== translation) this._change({ type: 'translation', bookId: book.id, index: payload.index, translation, clearDraft: book.position === payload.index });
    return { bookId: book.id, index: payload.index, translation, draft: book.draft };
  }

  getSegment(bookId, index) {
    const book = this._book(bookId); this._index(book, index);
    return clone(book.segments[index]);
  }
  exportData() { return clone(this.state); }
  importData(data) { this._assertWritable(); return this._commit(validateData(data)); }
}

module.exports = { Library, chunkText, MAX_BOOK_BYTES, MAX_LIBRARY_BYTES };
