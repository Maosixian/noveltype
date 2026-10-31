'use strict';
const {parseAlignedResponse}=require('./alignment.cjs');
// Authored alongside the original bilingual sample. Match the full pair, so an
// edited demo translation can never inherit a stale mapping.
const samples=[
  ['清晨，林舟推开旧书店的门。窗边放着一封没有邮票的信，信封上只写着两个字：灯塔。',[
    ['At dawn,','清晨'],['Lin','林舟'],['pushed open','推开'],['the door','门'],['of the old bookshop.','旧书店'],
    ['A letter','一封没有邮票的信'],['without a stamp','没有邮票'],['lay by the window.','窗边放着'],
    ['Only two words','只写着两个字'],['were written on the envelope:','信封上只写着'],['The Lighthouse.','灯塔']]],
  ['他沿着河边的小路走去。昨夜的雨已经停了，树叶上的水珠映着微光。远处，一艘蓝色的小船正缓缓靠岸。',[
    ['He','他'],['followed the path beside the river.','沿着河边的小路走去'],['The rain had stopped,','昨夜的雨已经停了'],
    ['and drops of water','水珠'],['caught the light','映着微光'],['on the leaves.','树叶上'],['In the distance,','远处'],
    ['a small blue boat','一艘蓝色的小船'],['was coming ashore.','正缓缓靠岸']]],
  ['船上的老人递给他一把铜钥匙。“有些门，”老人说，“只为愿意停下来听的人打开。”林舟把钥匙握在手心，听见了海浪。',[
    ['An old man on the boat','船上的老人'],['handed him a brass key.','递给他一把铜钥匙'],['"Some doors,"','有些门'],
    ['the man said,','老人说'],['"open only for those who stop to listen."','只为愿意停下来听的人打开'],
    ['Lin held the key in his palm','林舟把钥匙握在手心'],['and listened to the waves.','听见了海浪']]],
  ['灯塔里没有宝箱，只有一本摊开的日记。第一页写着：如果你找到这里，请为下一位旅人留下一句话。林舟坐下来，想了很久。',[
    ['There was no treasure chest in the lighthouse,','灯塔里没有宝箱'],['only an open journal.','只有一本摊开的日记'],
    ['The first page read:','第一页写着'],['If you find this place,','如果你找到这里'],['leave a sentence for the next traveler.','请为下一位旅人留下一句话'],
    ['Lin sat down','林舟坐下来'],['and thought for a while.','想了很久']]],
  ['最后，他写道：“你不必知道整条路，才能迈出第一步。”傍晚回到书店时，他把门口的灯调亮了一点。',[
    ['At last,','最后'],['he wrote,','他写道'],['"You do not need to know the whole road','你不必知道整条路'],
    ['to take the first step."','才能迈出第一步'],['When he returned to the bookshop that evening,','傍晚回到书店时'],
    ['he turned the light by the door a little brighter.','他把门口的灯调亮了一点']]]
];
const entries=samples.map(([source,pairs])=>{
  const translation=pairs.map(pair=>pair[0]).join(' ');
  const groups=pairs.map(([english,chinese])=>({english,chinese,occurrence:0}));
  return {source,...parseAlignedResponse(source,JSON.stringify({translation,groups}))};
});
function getDemoAlignment(source,translation){const entry=entries.find(item=>item.source===source&&item.translation===translation);return entry?structuredClone(entry.alignment):null;}
module.exports={getDemoAlignment};
