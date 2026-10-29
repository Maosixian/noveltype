/** Compare letters without changing the displayed text, spaces or punctuation. */
export function charactersMatch(actual, expected) {
  return typeof actual === 'string' && typeof expected === 'string'
    && actual.toLowerCase() === expected.toLowerCase();
}

function textMatches(actual, expected) {
  const value = Array.from(actual);
  const target = Array.from(expected);
  return target.length > 0 && value.length === target.length
    && value.every((character, index) => charactersMatch(character, target[index]));
}

/** Pure typing state. Clock values are monotonic milliseconds supplied by the caller. */
export class TypingSession {
  constructor(target, draft = '') {
    this.target = String(target);
    this.value = String(draft);
    this.attempts = 0;
    this.errors = 0;
    this.elapsed = 0;
    this.startedAt = null;
    this.hasStarted = false;
    this.complete = textMatches(this.value, this.target);
    this.claimed = this.complete;
    this.baseline = this.correctCount();
  }

  correctCount() {
    const expected = Array.from(this.target);
    return Array.from(this.value).filter((character, i) => charactersMatch(character, expected[i])).length;
  }

  input(value, now) {
    if (this.complete) return;
    const next = Array.from(String(value));
    const previous = Array.from(this.value);
    const expected = Array.from(this.target);
    let prefix = 0;
    while (prefix < Math.min(previous.length, next.length) && previous[prefix] === next[prefix]) prefix++;
    let suffix = 0;
    while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
    const end = next.length - suffix;
    if (end > prefix && !this.hasStarted) {
      this.hasStarted = true;
      this.startedAt = now;
    }
    for (let i = prefix; i < end; i++) {
      this.attempts++;
      if (!charactersMatch(next[i], expected[i])) this.errors++;
    }
    this.value = next.join('');
    this.complete = textMatches(this.value, this.target);
    if (this.complete) this.pause(now);
  }

  pause(now) {
    if (this.startedAt !== null) {
      this.elapsed += Math.max(0, now - this.startedAt);
      this.startedAt = null;
    }
  }

  resume(now) {
    if (this.hasStarted && !this.complete && this.startedAt === null) this.startedAt = now;
  }

  snapshot(now) {
    const seconds = (this.elapsed + (this.startedAt === null ? 0 : Math.max(0, now - this.startedAt))) / 1000;
    const correct = this.correctCount();
    const characters = Math.max(0, correct - this.baseline);
    return {
      value: this.value,
      correct,
      characters,
      attempts: this.attempts,
      errors: this.errors,
      accuracy: this.attempts ? Math.round((this.attempts - this.errors) / this.attempts * 100) : 100,
      seconds,
      wpm: seconds > 0 ? Math.round(characters / 5 / (seconds / 60)) : 0,
      complete: this.complete,
      running: this.startedAt !== null,
    };
  }

  claimCompletion(now) {
    if (!this.complete || this.claimed) return null;
    this.claimed = true;
    const { characters, seconds, accuracy, wpm } = this.snapshot(now);
    return { characters, seconds, accuracy, wpm };
  }
}
