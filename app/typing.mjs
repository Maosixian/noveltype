/** Compare letters without changing the displayed text, spaces or punctuation. */
export function charactersMatch(actual, expected) {
  return typeof actual === 'string' && typeof expected === 'string'
    && actual.toLowerCase() === expected.toLowerCase();
}

/** Pure typing state. Clock values are monotonic milliseconds supplied by the caller. */
export class TypingSession {
  #expected;
  #characters;
  #correct;

  constructor(target, draft = '') {
    this.target = String(target);
    this.value = String(draft);
    this.#expected = Array.from(this.target);
    this.#characters = Array.from(this.value);
    this.#correct = this.#characters.reduce((count, character, index) => count + Number(charactersMatch(character, this.#expected[index])), 0);
    this.attempts = 0;
    this.errors = 0;
    this.elapsed = 0;
    this.startedAt = null;
    this.hasStarted = false;
    this.complete = this.#expected.length > 0 && this.#characters.length === this.#expected.length && this.#correct === this.#expected.length;
    this.claimed = this.complete;
    this.baseline = this.correctCount();
  }

  correctCount() {
    return this.#correct;
  }

  input(value, now) {
    if (this.complete) return;
    const nextValue = String(value), next = Array.from(nextValue);
    const previous = this.#characters, expected = this.#expected;
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
    // Equal-length edits preserve the common suffix's target positions. An
    // insertion/deletion shifts that suffix, so recount the entire changed tail.
    const shifted = previous.length !== next.length;
    const oldEnd = shifted ? previous.length : previous.length - suffix;
    const newEnd = shifted ? next.length : end;
    for (let i = prefix; i < oldEnd; i++) this.#correct -= Number(charactersMatch(previous[i], expected[i]));
    for (let i = prefix; i < newEnd; i++) this.#correct += Number(charactersMatch(next[i], expected[i]));
    this.#characters = next;
    this.value = nextValue;
    this.complete = expected.length > 0 && next.length === expected.length && this.#correct === expected.length;
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
