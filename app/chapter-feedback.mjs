/** Build feedback from acknowledged progress, never the optimistic reading state. */
export function chapterMessage(transition, completed, total) {
  if (!transition) return null;
  const done = new Set(completed);
  const covers = (start, end) => {
    for (let index = start; index <= end; index++) if (!done.has(index)) return false;
    return true;
  };
  const chapterDone = covers(transition.completed.start, transition.completed.end);
  const bookDone = transition.bookEnd && covers(0, total - 1);
  return {
    title: transition.bookEnd ? bookDone ? '全书已完成' : '本书已到结尾' : chapterDone ? '本章已完成' : '已到本章末尾',
    chapter: transition.completed.label,
    next: transition.next ? `下一章：${transition.next.label}` : '',
    complete: transition.bookEnd ? bookDone : chapterDone,
  };
}

/** A completion belongs to one input context and may be acknowledged only once. */
export function createChapterFeedback() {
  let currentBookId = null, context = 0;
  const seen = new Set();
  return {
    reset(bookId) { currentBookId = bookId; context++; seen.clear(); },
    capture({bookId, transition, total, token}) {
      if (!token || !transition || bookId !== currentBookId) return null;
      return {bookId, transition, total, token, context};
    },
    confirm(receipt, completed) {
      if (!receipt || receipt.bookId !== currentBookId || receipt.context !== context || seen.has(receipt.token)) return null;
      const message = chapterMessage(receipt.transition, completed, receipt.total);
      seen.add(receipt.token);
      // Only live UI receipts are deduplicated; book progress remains in Library.
      if (seen.size > 64) seen.delete(seen.values().next().value);
      return message;
    },
  };
}
