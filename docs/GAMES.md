# 小说游戏 · 1.5

用户于 2026-11-01 选择竞速、防御战和闯关地图，并批准沿用 Apple 风格界面预览。此次实现沿用 Electron、原生 DOM/CSS 和本地打字核心，无新增运行依赖。

## 体验

- 阅读、游戏、闯关地图有独立入口；阅读保留连续滚动、中文同步高亮与大小写宽容。
- 竞速使用缓存译文原句，对手明确显示电脑配速或个人最佳的平均配速，支持暂停、重玩、准确率和个人记录。
- 防御战从缓存译文抽取词，输入完整词即可击退；显示原句中文上下文，不将整句冒充单词释义。生命、连击、波次和难度逐步变化。
- 地图分 3 章、12 关，两种玩法交替；完成前一关解锁下一关，可以重玩提高星级。不同书籍有独立游戏记录。
- 没有缓存的书显示空态，可明确选择原创示例。游戏不触发翻译，不推进阅读位置，不使用真实在线对手。
- 失焦、切页、打开弹窗暂停计时。完成后先保存再展示解锁；失败有明确的重试保存，不静默重试。

## 存储与边界

`games.json` 独立保存分数、星级、个人最佳与有限近期记录，不保存小说正文或密钥。结果有 runId 幂等保护，写入成功后才更新内存。阅读书库格式不变。书库导出仍仅包含书库和阅读进度；迁移游戏记录需备份完整数据目录。

主进程从合并后的 Library 内存读取最多 48 条缓存英文节选，每条不超过 260 字符，按当前位置邻近优先；不会调用 getState 克隆整库，也不读原始 library.json。节选仅规整游戏目标的空白，原书译文保留。结果绑定书籍，个人最佳绑定节选摘要。主进程保留最多 512 条已签发目标，保存时按原段验证，不受后台新译文挤动候选列表的影响。

## 社区评估

- TypeDefense：MIT，但全局键盘监听、alert/reload 和单字母游戏模型与 NovelType 不合，未复制代码。https://github.com/treetop-playground/TypeDefense
- Kontra：MIT，可用于未来 Canvas 精灵效果；当前 DOM/CSS 足够，不引入。https://github.com/straker/kontra
- aashutoshrathi/Typeracer：MIT，但旧 Vue/Firebase 云端依赖与本地游戏不合。https://github.com/aashutoshrathi/Typeracer
- 使用原创路线与几何图形，不复制 ZType 或商业游戏素材。无新增第三方运行时及许可素材。

## 实现和验证计划

1. `app/games.mjs` + `test/games.test.mjs`：先用注入时钟验证暂停、大小写、错误纠正、超时、命中和解锁，再实现纯游戏状态。
2. `app/game-content.cjs`、`app/game-store.cjs` + `test/game-store.test.cjs`：缓存来源与独立原子存储，测试空态、内容上限、重复结果、失败写入、重启和非法输入。
3. `app/games-ui.mjs`、`app/games.css`：真实竞速、防御战、地图和结算；`test/games-smoke.cjs` 在临时 Electron profile 验证交互、失败重试和零 API。
4. `app/index.html`、`app/renderer.js`、`app/styles.css`、`app/appearance.css`：导航和主题接入。切页先暂停并保存阅读；保留既有选择器和焦点规则。
5. `app/main.cjs`、`app/preload.cjs`：只增加 getGameData/saveGameResult 两个 IPC，保留来源校验、context isolation、sandbox 和 CSP。
6. 运行 `npm test`、`npm run test:desktop`、`npm run test:performance`，独立审查后更新版本、CHANGELOG、使用说明和打包白名单。
7. 执行 `npm run dist`、`npm run verify:release`、`node test/packaged-smoke.cjs`。通过后 GitHub PR 合并并发布 1.5.0；更新本机前完整备份用户数据，安装和启动单独验证。
