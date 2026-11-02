'use strict';
// Blur/close flushes may carry the exact already-durable draft. They are not
// edits and must not become stale CAS writes when another device moves forward.
function saveReadingProgress({library,cloud,input}){
 if(!cloud?.connected())return library.saveProgress(input);
 const book=input&&library.state.books.find(item=>item.id===input.bookId);
 const unchanged=book&&book.position===input.position&&book.draft===input.draft&&(input.completed===undefined||book.completed.includes(input.completed));
 if(!unchanged)return cloud.changed('progress',input.bookId,()=>library.saveProgress(input));
 const ack=library.saveProgress(input); // Preserve all validation, including session bounds.
 cloud.recoverDirty(); // A prior write may be durable while its outbox write failed.
 return ack;
}
module.exports={saveReadingProgress};
