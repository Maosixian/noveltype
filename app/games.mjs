import { TypingSession } from './typing.mjs';

// Keep the same lexical boundary as the reading alignment code. Only Latin words
// enter the keyboard defense game; punctuation inside a word remains significant.
const WORDS = /[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu;
const LATIN_WORD = /^(?=.*\p{Script=Latin})[\p{Script=Latin}\p{M}\p{N}]+(?:['’\-][\p{Script=Latin}\p{M}\p{N}]+)*$/u;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const numeric = (value, fallback, min, max) => Number.isFinite(value) ? clamp(value, min, max) : fallback;
const clockValue = value => {
  if (!Number.isFinite(value)) throw new Error('游戏计时无效。');
  return value;
};

export function buildWordPool(passages, { limit = 160 } = {}) {
  const pool = [], seen = new Set();
  const maximum = Math.floor(numeric(limit, 160, 1, 500));
  for (const passage of Array.isArray(passages) ? passages.slice(0, 96) : []) {
    if (typeof passage?.translation !== 'string') continue;
    for (const match of passage.translation.slice(0, 20000).matchAll(WORDS)) {
      const word = match[0], key = word.toLowerCase();
      if (!LATIN_WORD.test(word) || word.length < 2 || word.length > 32 || seen.has(key)) continue;
      seen.add(key);
      pool.push({ word, source: String(passage.source || ''), translation: passage.translation, passageId: String(passage.id ?? '') });
      if (pool.length >= maximum) return pool;
    }
  }
  return pool;
}

/** All game time is supplied by the caller; no timers, storage or network here. */
class GameClock {
  constructor(duration) {
    this.duration = duration;
    this.status = 'ready';
    this.elapsedMs = 0;
    this.lastNow = null;
  }

  _timeAt(now) {
    clockValue(now);
    return this.elapsedMs + (this.status === 'running' ? Math.max(0, now - this.lastNow) : 0);
  }

  _commit(now, elapsedMs) {
    this.elapsedMs = elapsedMs;
    this.lastNow = this.lastNow === null ? now : Math.max(this.lastNow, now);
  }

  _finish(status, elapsedMs = this.elapsedMs) {
    this.elapsedMs = elapsedMs;
    this.status = status;
    this.lastNow = null;
  }

  start(now) {
    clockValue(now);
    if (this.status === 'ready') {
      this.lastNow = now;
      this.status = 'running';
      this._onStart?.();
    }
    return this.snapshot(now);
  }

  pause(now) {
    this.update(now);
    if (this.status === 'running') this._finish('paused');
    return this.snapshot(now);
  }

  resume(now) {
    clockValue(now);
    if (this.status === 'paused') { this.status = 'running'; this.lastNow = now; }
    return this.snapshot(now);
  }

  end(now) {
    this.update(now);
    if (this.status === 'running' || this.status === 'paused') this._finish('ended');
    return this.snapshot(now);
  }

  _seconds(now) { return Math.min(this.duration, this._timeAt(now) / 1000); }
}

export function paragraphRaceTimeLimit(text) {
  // Allow a beginner roughly ten words per minute, bounded by a one-hour round.
  return clamp(Math.ceil(Array.from(String(text)).length / 5 / 10 * 60 + 30),180,3600);
}

export class RaceSession extends GameClock {
  constructor({ text, opponentWpm = 35, timeLimit = 180, minAccuracy = 0 } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 10000) throw new Error('竞速需要一段有效的英文译文。');
    super(numeric(timeLimit, 180, 1, 3600));
    this.text = text;
    this.length = Array.from(text).length;
    this.opponentWpm = numeric(opponentWpm, 35, 1, 500);
    this.minAccuracy = numeric(minAccuracy, 0, 0, 100);
    this.typing = new TypingSession(text);
  }

  update(now) {
    const elapsed = this._timeAt(now);
    if (this.status === 'running') {
      this._commit(now, Math.min(this.duration * 1000, elapsed));
      if (elapsed >= this.duration * 1000) this._finish('lost');
    }
    return this.snapshot(now);
  }

  input(value, now) {
    this.update(now);
    if (this.status === 'running') {
      this.typing.input(String(value).slice(0, this.text.length + 100), now);
      if (this.typing.complete) this._finish(this.typing.snapshot(now).accuracy >= this.minAccuracy ? 'won' : 'lost');
    }
    return this.snapshot(now);
  }

  snapshot(now) {
    const seconds = this._seconds(now);
    const typing = this.typing.snapshot(now);
    const opponentSeconds = this.length / 5 / this.opponentWpm * 60;
    const wonRace = this.typing.complete && seconds <= opponentSeconds;
    const stars = this.status === 'won' ? (typing.accuracy >= 98 && wonRace ? 3 : typing.accuracy >= 95 ? 2 : 1) : 0;
    return {
      mode: 'race', status: this.status, seconds, timeLeft: Math.max(0, this.duration - seconds),
      text: this.text, value: typing.value, complete: typing.complete,
      progress: clamp(typing.correct / this.length, 0, 1),
      opponentProgress: clamp(seconds / opponentSeconds, 0, 1), opponentWpm: this.opponentWpm,
      accuracy: typing.accuracy, attempts: typing.attempts, errors: typing.errors,
      wpm: seconds > 0 ? Math.round(typing.correct / 5 / (seconds / 60)) : 0,
      wonRace, stars, score: this.status === 'won' ? Math.round(this.length * typing.accuracy / 10) : 0,
    };
  }
}

function normalizeWords(words) {
  const normalized = [], seen = new Set();
  for (const item of Array.isArray(words) ? words.slice(0, 500) : []) {
    const entry = typeof item === 'string' ? { word: item } : item;
    if (typeof entry?.word !== 'string' || !LATIN_WORD.test(entry.word) || entry.word.length > 32) continue;
    const key = entry.word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ word: entry.word, source: String(entry.source || ''), translation: String(entry.translation || ''), passageId: String(entry.passageId || '') });
  }
  if (!normalized.length) throw new Error('防御战需要已缓存译文中的英文单词。');
  return normalized;
}

export class DefenseSession extends GameClock {
  constructor({ words, duration = 60, spawnEvery = 2400, fallDuration = 14000, lives = 3, target = 12, random = Math.random } = {}) {
    super(numeric(duration, 60, 1, 180));
    this.words = normalizeWords(words);
    this.spawnEvery = numeric(spawnEvery, 2400, 250, 20000);
    this.fallDuration = numeric(fallDuration, 14000, 500, 60000);
    this.initialLives = Math.floor(numeric(lives, 3, 1, 9));
    this.lives = this.initialLives;
    this.target = Math.floor(numeric(target, 12, 1, 100));
    this.random = typeof random === 'function' ? random : Math.random;
    this.enemies = [];
    this.sequence = 0;
    this.nextSpawn = 0;
    this.kills = 0;
    this.combo = 0;
    this.score = 0;
    this.value = '';
    this.attempts = 0;
    this.errors = 0;
  }

  _onStart() { this._spawn(0); this.nextSpawn = this.spawnEvery; }

  _spawn(at) {
    if (this.enemies.length >= 8) return;
    const active = new Set(this.enemies.map(enemy => enemy.word.toLowerCase()));
    const available = this.words.filter(item => !active.has(item.word.toLowerCase()));
    if (!available.length) return;
    const choice = Math.floor(numeric(this.random(), 0, 0, 0.999999) * available.length);
    const item = available[choice];
    this.enemies.push({ ...item, id: ++this.sequence, lane: (this.sequence - 1) % 4, born: at });
  }

  update(now) {
    const requested = Math.min(this.duration * 1000, this._timeAt(now));
    if (this.status === 'running') {
      // Process deadlines in chronological order. A suspended renderer cannot
      // spawn an unbounded backlog or charge the same escaped word twice.
      while (this.status === 'running') {
        const expiry = Math.min(...this.enemies.map(enemy => enemy.born + this.fallDuration));
        const eventTime = Math.min(this.nextSpawn, expiry, this.duration * 1000);
        if (eventTime > requested) break;
        this.elapsedMs = eventTime;
        if (expiry <= eventTime) {
          const escaped = this.enemies.filter(enemy => enemy.born + this.fallDuration <= eventTime);
          this.enemies = this.enemies.filter(enemy => enemy.born + this.fallDuration > eventTime);
          this.lives = Math.max(0, this.lives - escaped.length);
          this.combo = 0;
          if (!this.lives) { this._finish('lost'); break; }
        }
        if (eventTime >= this.duration * 1000) { this._finish('lost'); break; }
        if (this.nextSpawn <= eventTime) { this._spawn(eventTime); this.nextSpawn += this.spawnEvery; }
      }
      if (this.status === 'running') this._commit(now, requested);
    }
    return this.snapshot(now);
  }

  input(value, now) {
    this.update(now);
    if (this.status !== 'running') return this.snapshot(now);
    const next = String(value).slice(0, 64), previous = this.value;
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(previous.length, next.length) && previous[prefix] === next[prefix]) prefix++;
    while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
    for (let index = prefix; index < next.length - suffix; index++) {
      this.attempts++;
      const partial = next.slice(0, index + 1).toLowerCase();
      if (!this.enemies.some(enemy => enemy.word.toLowerCase().startsWith(partial))) this.errors++;
    }
    this.value = next;
    const match = this.enemies.find(enemy => enemy.word.toLowerCase() === next.toLowerCase());
    if (!match) return this.snapshot(now);
    this.enemies = this.enemies.filter(enemy => enemy.id !== match.id);
    this.kills++; this.combo++;
    this.score += match.word.length * 10 + Math.min(this.combo, 20) * 5;
    this.value = '';
    if (this.kills >= this.target) this._finish('won');
    return { ...this.snapshot(now), matchedId: match.id };
  }

  snapshot(now) {
    const seconds = this._seconds(now);
    const accuracy = this.attempts ? Math.round((this.attempts - this.errors) / this.attempts * 100) : 100;
    const stars = this.status === 'won' ? (this.lives === this.initialLives && accuracy >= 95 ? 3 : this.lives >= Math.max(1, this.initialLives - 1) && accuracy >= 85 ? 2 : 1) : 0;
    return {
      mode: 'defense', status: this.status, seconds, timeLeft: Math.max(0, this.duration - seconds),
      accuracy, attempts: this.attempts, errors: this.errors, score: this.score, stars,
      value: this.value, lives: this.lives, kills: this.kills, combo: this.combo, target: this.target, matchedId: null,
      enemies: this.enemies.map(({ born, ...enemy }) => ({ ...enemy, progress: clamp((seconds * 1000 - born) / this.fallDuration, 0, 1) })),
    };
  }
}

const names = ['晨光起跑', '守住书店', '河岸小径', '渡口来信', '山间追风', '雾中守望', '穿过林海', '山谷防线', '星夜疾行', '灯火不熄', '逐风向前', '抵达灯塔'];
export const LEVELS = Object.freeze(names.map((title, index) => {
  const chapter = Math.floor(index / 4) + 1;
  const mode = index % 2 ? 'defense' : 'race';
  return Object.freeze({
    id: index + 1, chapter, title, name: title, mode,
    ...(mode === 'race'
      ? { opponentWpm: [20, 30, 40][chapter - 1], timeLimit: [180, 150, 120][chapter - 1], minAccuracy: [80, 85, 90][chapter - 1] }
      : { duration: 60, spawnEvery: [2600, 2200, 1800][chapter - 1], fallDuration: [16000, 14000, 12000][chapter - 1], target: [8, 12, 16][chapter - 1], lives: 3 }),
  });
}));

export function isLevelUnlocked(levelId, levelsProgress = {}) {
  if (!Number.isInteger(levelId) || !LEVELS.some(level => level.id === levelId)) return false;
  return levelId === 1 || Number(levelsProgress?.[levelId - 1]?.stars) >= 1;
}

export function levelStars(levelId, snapshot) {
  const level = LEVELS.find(item => item.id === levelId);
  if (!level || snapshot?.status !== 'won' || snapshot.mode !== level.mode) return 0;
  if (level.mode === 'race' && snapshot.accuracy < level.minAccuracy) return 0;
  return Math.floor(numeric(snapshot.stars, 0, 0, 3));
}
