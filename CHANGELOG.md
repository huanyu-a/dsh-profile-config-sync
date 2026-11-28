# Changelog

## [0.7.0](https://github.com/huanyu-a/dsh-profile-config-sync/compare/v0.6.47...v0.7.0) (2026-11-28)


### Features

* **conversations:** session.lock 不进仓库，推送时清云端历史锁 ([38793c6](https://github.com/huanyu-a/dsh-profile-config-sync/commit/38793c6a181923cad4889abd49212d9a6b5b5778))
* **conversations:** 会话记录搬进 Node 引擎（macOS/Linux 也能同步会话） ([fbf9689](https://github.com/huanyu-a/dsh-profile-config-sync/commit/fbf96898d6933278fe3f4f7595583926c6f438e9))
* **extra:** 插件数据与额外路径进 Node 引擎（规则收进 runtime/extra-rules.mjs） ([637c1c8](https://github.com/huanyu-a/dsh-profile-config-sync/commit/637c1c8924d7e0e740e52cf343b5bf126e20aa0f))
* **fix:** 0.6.48 —— 修 issue [#7](https://github.com/huanyu-a/dsh-profile-config-sync/issues/7)/[#8](https://github.com/huanyu-a/dsh-profile-config-sync/issues/8)（第三方 WebDAV 连不上）与 [#9](https://github.com/huanyu-a/dsh-profile-config-sync/issues/9)（反馈带不了截图） ([4adcb74](https://github.com/huanyu-a/dsh-profile-config-sync/commit/4adcb7462f98df622e0dca3f63734894735aecd4))
* **fix:** 0.6.49 —— macOS 全面可用（+ WebDAV 自检与私钥拦截） ([e14069f](https://github.com/huanyu-a/dsh-profile-config-sync/commit/e14069fb9469e89218f64fb5f7a3bc1711da5865))
* **lanes:** 一份仓库三端共用 —— 机器相关文件按平台分目录 ([6778f84](https://github.com/huanyu-a/dsh-profile-config-sync/commit/6778f84acf23ee1b933069c3013329f23af31735))
* **local-plugins,mnemon,storages-record:** 再补三组 + 最小 zip 读写 ([8b86421](https://github.com/huanyu-a/dsh-profile-config-sync/commit/8b864212f04795db9ff46b676a1489ed0e4c37fe))
* **porting:** 跨平台拉取不做「只暂存」，改成真移植 ([02d0da5](https://github.com/huanyu-a/dsh-profile-config-sync/commit/02d0da5a995713b11046c597c7ebd209974bc77b))
* **prompt:** 全局提示按平台分开（B 方案） ([b57e5a9](https://github.com/huanyu-a/dsh-profile-config-sync/commit/b57e5a93b4de9f88eb53dee06afa61635bb48b38))
* **settings:** 插件设置与工作流进 Node 引擎 + 凭据嗅探收到共用模块 ([9f1c1ee](https://github.com/huanyu-a/dsh-profile-config-sync/commit/9f1c1ee73969a2ee0a57a1a54148a1eccea43b77))
* **shared:** 共享配置真正互相覆盖 —— 提示回到共享，技能/预设按云端镜像 ([aa338cb](https://github.com/huanyu-a/dsh-profile-config-sync/commit/aa338cbf48a300a23b89b8b2349452d3b7f9dbf5))
* **workspace:** 最后一组进 Node 引擎，只同步登记表（registry-only） ([65b2d6e](https://github.com/huanyu-a/dsh-profile-config-sync/commit/65b2d6ecfe1cd0a83e68913b6ff253ca274d3dec))


### Bug Fixes

* **apply:** 覆盖前留底一直是空操作（自己跟自己比） ([4a190f3](https://github.com/huanyu-a/dsh-profile-config-sync/commit/4a190f3eaa5dd12241694a928568b66831538dba))
* **capture:** 变更标签写真实落点（settings/&lt;平台&gt;/x.json） ([3c1324b](https://github.com/huanyu-a/dsh-profile-config-sync/commit/3c1324b04f6b7a3c3ca5d6b5f34a56ebf0f77d8d))
* **contract:** 契约按平台读，别在 macOS 上读到 Windows 那份 ([d0bef9a](https://github.com/huanyu-a/dsh-profile-config-sync/commit/d0bef9a19f1942b2cc419a5d671d5dd794a0d3c7))
* **macOS:** 后台自动拉取不再弹原生框（改由面板一键接手） ([25fd74f](https://github.com/huanyu-a/dsh-profile-config-sync/commit/25fd74fa9ac44dd864266a867bc1da5fb17ebd0a))
* **macOS:** 符号链接路径下的仓库不再被判成「不是仓库根」 ([25e2939](https://github.com/huanyu-a/dsh-profile-config-sync/commit/25e293901e83c299ab473caddeac1ead93d1f2cb))
* **panel:** 同步范围卡按平台标注不支持的组（不再能勾上却不生效） ([d50236f](https://github.com/huanyu-a/dsh-profile-config-sync/commit/d50236f4d6fbe935e2b2a992071291a630d31274))
* **panel:** 引擎覆盖全部 12 组后，不再提示「要 Windows 版才会同步」 ([c59ec14](https://github.com/huanyu-a/dsh-profile-config-sync/commit/c59ec1459052b2c850532582ee7889654a0605cb))
* **profile:** 抓 cordis.yml 与 pnpm-workspace.yaml（Windows 版一直抓，Node 引擎漏了） ([4cfe40a](https://github.com/huanyu-a/dsh-profile-config-sync/commit/4cfe40a3386c04573cc37434d4687e68b4754b68))
* **pull:** 跨平台拉取护栏 —— 另一套系统的 profile / 全局提示不覆盖本机 ([67340d7](https://github.com/huanyu-a/dsh-profile-config-sync/commit/67340d70482d38fe03d160e710d28bcb4c1373f6))
* **pull:** 跨平台时也不铺 settings 里那份整份工作区登记表 ([ef720fa](https://github.com/huanyu-a/dsh-profile-config-sync/commit/ef720fa02dcdebb61c841edba56054eca0f2e1ba))
* **repo:** 仓库自带执行体补齐（新机器没有插件副本也能跑 apply） ([d258c08](https://github.com/huanyu-a/dsh-profile-config-sync/commit/d258c0873790eabd63d2af7a33b4ce21b5af2e19))

## [0.5.0](https://github.com/huanyu-a/dsh-profile-config-sync/compare/v0.4.1...v0.5.0) (2026-11-25)


### Features

* 支持不关闭 DSH 在线推送、待办锚文本直达与脱离 Job Object 修复 ([158914d](https://github.com/huanyu-a/dsh-profile-config-sync/commit/158914d14d4989fd794edfaf3ab47efef96edb4c))

## [0.4.1](https://github.com/huanyu-a/dsh-profile-config-sync/compare/v0.4.0...v0.4.1) (2026-11-25)


### Bug Fixes

* 修复含空格路径传参崩溃、WebDAV 接入拉取/推送流水线与提示文案 ([8665735](https://github.com/huanyu-a/dsh-profile-config-sync/commit/86657350aeacf489a03407b90cb8b303d2acf7f9))

## [0.4.0](https://github.com/huanyu-a/dsh-profile-config-sync/compare/v0.3.99...v0.4.0) (2026-11-25)


### Features

* 0.4.0 多端通用（Windows/macOS/Linux）+ WebDAV 同步通道 ([e1f5e0e](https://github.com/huanyu-a/dsh-profile-config-sync/commit/e1f5e0e2cb140a652bb192dfb7651a0bb062ead4))


### Bug Fixes

* 深度审核发现的 6 个缺陷（含 1 个静默数据丢失、1 个隐私泄露） ([d243241](https://github.com/huanyu-a/dsh-profile-config-sync/commit/d243241dabd0cf08902a568b319f8ca5a8efe4be))
