'use strict';
const {validateAlignment} = require('./alignment.cjs');
const {translateAlignedText, alignExistingText} = require('./translation.cjs');

async function preparePassage({library, cache, bookId, index, getCredentials, fetchImpl, translate = translateAlignedText, align = alignExistingText}) {
  const before = library.getSegment(bookId, index);
  const cached = before.translation && cache.get(before.source, before.translation);
  if (cached) return {translation:before.translation, alignment:cached, cached:true};
  const credentials = getCredentials();
  const options = {source:before.source, ...credentials, fetchImpl};
  const result = before.translation
    ? await align({...options, translation:before.translation})
    : await translate(options);
  if (before.translation && result.translation !== before.translation) throw new Error('已有译文的对照结果不一致，已停止。');
  const alignment = validateAlignment(before.source, result.translation, result.alignment);
  const current = library.getSegment(bookId, index);
  if (current.source !== before.source || current.translation !== before.translation) throw new Error('段落内容已更改，已停止保存旧的对应关系。');
  if (!before.translation) library.setTranslation({bookId, index, translation:result.translation});
  cache.set(before.source, result.translation, alignment);
  return {translation:result.translation, alignment, cached:false};
}
module.exports = {preparePassage};
