# 版本发布

源码仓库：`Maosixian/noveltype`。主分支为 `main`，发行包放在 GitHub Releases，不提交二进制到 Git。

## 日常修改

1. 从 `main` 新建分支，修改程序与必要测试。
2. 执行 `npm ci`、`npm test`、`npm run test:desktop`。
3. 审查 diff，确认没有 Key、小说、备份、个人路径或本机证据文件。
4. 通过 PR 合并代码。若只是本机验证，不能宣称已发布。

## 发布新版

1. 修改 `package.json` 和锁文件中的版本，更新 `CHANGELOG.md`。
2. Windows 上执行 `npm run dist`、`npm run verify:release` 和 `node test/packaged-smoke.cjs`。安装体验与升级保留数据需要独立验证。
3. 提交后推送 `main`，再创建并推送与 package 版本一致的标签，例如 `v1.2.1`。
4. `.github/workflows/release.yml` 先运行测试，再构建 NSIS 安装器、ZIP 和 SHA-256 校验文件；只有构建检查通过后才上传 Release。
5. 检查 Actions 成功、Release 实际附件完整以及下载链接可访问，才把下载链接发给使用者。

```powershell
git tag v1.2.1
git push origin main
git push origin v1.2.1
```

`workflow_dispatch` 可手动运行测试；只有版本标签触发发行上传。失败时修复代码并发布新版本，不覆盖已经传播的版本文件。

## 密钥与签名

工作流用 GitHub 自动提供的短期 `GITHUB_TOKEN` 上传 Release，不需要提交个人 Token。不要将 API Key 放进 Actions secrets：构建和模拟测试不使用任何模型 Key。

当前包无 Authenticode 商业签名。需要签名分发时，应由维护者配置有效证书或受信任签名服务，并完成独立验证；不要关闭或规避 Windows 安全策略。没有签名不能承诺所有 Windows 设备均允许执行。

`%APPDATA%/NovelType` 是稳定数据路径，程序升级不能改变该路径，也不能删除用户书库。恢复备份与卸载需保留用户数据，未来数据格式升级须先设计迁移与回滚。
