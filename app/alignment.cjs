'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_CACHE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_SPANS = 512;
const fail = () => { throw new Error('中英对照数据不完整或格式不正确，未保存；请手动重试。'); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validText = (value, maximum) => typeof value === 'string' && value.length <= maximum && value.trim().length > 0 && value.isWellFormed() && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
const safeBoundary = (text, index) => !(index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]));
const validRange = (text, start, end) => Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length && safeBoundary(text, start) && safeBoundary(text, end) && text.slice(start, end).trim().length > 0;

function validatePair(source, translation) {
  if (!validText(source, 260) || !validText(translation, 10000)) fail();
}

// Only English order must be monotonic. Chinese word order and many-to-one
// phrases legitimately produce reversed or overlapping source ranges.
function validateAlignment(source, translation, alignment) {
  validatePair(source, translation);
  if (!exactKeys(alignment, ['version', 'spans']) || alignment.version !== 1 || !Array.isArray(alignment.spans) || !alignment.spans.length || alignment.spans.length > MAX_SPANS) fail();
  const words = [...translation.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu)];
  const splitsWord = offset => words.some(word => offset > word.index && offset < word.index + word[0].length);
  let cursor = 0;
  for (const span of alignment.spans) {
    if (!exactKeys(span, ['englishStart', 'englishEnd', 'sourceStart', 'sourceEnd']) || !validRange(translation, span.englishStart, span.englishEnd) || !validRange(source, span.sourceStart, span.sourceEnd)) fail();
    if (splitsWord(span.englishStart) || splitsWord(span.englishEnd)) fail();
    if (span.englishStart < cursor || /\S/.test(translation.slice(cursor, span.englishStart))) fail();
    cursor = span.englishEnd;
  }
  if (/\S/.test(translation.slice(cursor))) fail();
  return structuredClone(alignment);
}

function occurrenceIndex(source, part, occurrence) {
  if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence >= source.length) fail();
  let index = -1;
  for (let count = 0; count <= occurrence; count++) {
    index = source.indexOf(part, index + 1);
    if (index < 0) fail();
  }
  return index;
}

function parseAlignedResponse(source, rawJSON, existingTranslation) {
  if (typeof rawJSON !== 'string' || Buffer.byteLength(rawJSON, 'utf8') > MAX_RESPONSE_BYTES) fail();
  let data;
  try { data = JSON.parse(rawJSON); } catch { fail(); }
  if (!exactKeys(data, ['translation', 'groups'])) fail();
  validatePair(source, data.translation);
  if (existingTranslation !== undefined && data.translation !== existingTranslation) fail();
  if (!Array.isArray(data.groups) || !data.groups.length || data.groups.length > MAX_SPANS) fail();
  let cursor = 0;
  const spans = data.groups.map(group => {
    if (!exactKeys(group, ['english', 'chinese', 'occurrence']) || !validText(group.english, 10000) || !validText(group.chinese, 260)) fail();
    const english = group.english.trim();
    const englishStart = data.translation.indexOf(english, cursor);
    if (englishStart < 0 || /\S/.test(data.translation.slice(cursor, englishStart))) fail();
    const sourceStart = occurrenceIndex(source, group.chinese, group.occurrence);
    cursor = englishStart + english.length;
    return { englishStart, englishEnd: cursor, sourceStart, sourceEnd: sourceStart + group.chinese.length };
  });
  return { translation: data.translation, alignment: validateAlignment(source, data.translation, { version: 1, spans }) };
}

const fingerprint = (source, translation) => createHash('sha256').update(JSON.stringify([source, translation])).digest('hex');

class AlignmentCache {
  constructor(dataDir) { this.directory = path.join(dataDir, 'alignment-cache'); }

  get(source, translation) {
    try {
      validatePair(source, translation);
      const key = fingerprint(source, translation), file = path.join(this.directory, key + '.json');
      const size = fs.statSync(file).size;
      if (size < 1 || size > MAX_CACHE_BYTES) return null;
      const bytes = fs.readFileSync(file);
      if (bytes.length > MAX_CACHE_BYTES) return null;
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!exactKeys(data, ['version', 'fingerprint', 'alignment']) || data.version !== 1 || data.fingerprint !== key) return null;
      return validateAlignment(source, translation, data.alignment);
    } catch { return null; }
  }

  set(source, translation, alignment) {
    const validated = validateAlignment(source, translation, alignment), key = fingerprint(source, translation);
    const text = JSON.stringify({ version: 1, fingerprint: key, alignment: validated });
    if (Buffer.byteLength(text, 'utf8') > MAX_CACHE_BYTES) fail();
    fs.mkdirSync(this.directory, { recursive: true });
    const file = path.join(this.directory, key + '.json'), temp = file + '.' + randomUUID() + '.tmp';
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
    return validated;
  }
}

module.exports = { validateAlignment, parseAlignedResponse, AlignmentCache };
