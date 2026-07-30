# RemiPet 🦇

用 Spine 骨骼动画做的桌宠,**实时监控 Claude Code 的工作状态**——她会跟着 Claude 一起思考、动笔、等你批准权限、完工庆祝、出错慌乱。

> ⚠️ **随缘更新**。这是个自用的小玩意儿,想到什么就加点什么,没有路线图、没有版本承诺、不保证向后兼容,issue 和 PR 看到了会看但不保证响应速度。你 fork 走自己改可能更快。

> ⚠️ **本仓库不含美术素材。** 只有代码。角色形象和 Spine 素材的权利都不属于本项目,你需要**自备素材**,见下方「准备素材」。

## 它能做什么

| Claude Code 在干嘛 | 桌宠的反应 |
|---|---|
| 收到你的提示词 | 执笔沉思「唔姆…怎么写比较好」 |
| 敲命令 / 改代码 | 挥笔狂写冒汗 + 具体动作气泡 |
| 翻文件 / 搜索 | 低头边看边记 |
| **等你批准权限** | 弹出卡片 + **批准 / 拒绝按钮**,点一下直接回答,不用切回终端 |
| 等你回话 | 安静看书 + **「去回复」按钮**,精确跳回会话所在的终端标签页 |
| 完成 | 陶醉欣赏成品 + 附上回复摘要 |
| 出错 | 手忙脚乱 + 红色气泡(含错误类型) |
| 上下文吃紧 | 气泡追加「上下文已用 xx%」黄色预警 |
| 夸她 / 谢她 / 凶她 | 有专属表情和台词 |
| 会话结束 / 空闲 10 分钟 | 静静看书 |

托盘菜单还有:**今日 token 用量与费用**、尺寸调节、开机自启、完整演示(一次过完所有状态)。

多个 Claude 会话同时跑时按优先级(出错 > 等授权 > 干活)展示,气泡带 `[项目名]` 前缀。全程本地,不联网。

## 准备素材

本仓库不含素材,首次使用需要自备一套 **Spine 4.2** 导出的骨骼动画:

```bash
# 1. 把素材放进 assets/spine/(骨架 .json + .atlas + 贴图 .png)
#    默认文件名 remi.json / leimi.atlas / leimi.png,不一致可用环境变量覆盖:
#    REMI_SKEL=xx.json REMI_ATLAS=xx.atlas REMI_PNG=xx.png
npm run gen-assets     # 打包成 data URI → renderer/spine-data.js

# 2. 确认动画名与状态映射对得上
npx electron scripts/frames-main.js   # 逐动画拆 8 帧成动作条 → /tmp/remi_frames/
#    看清每个动画在干什么后,改 shared/states.js 里的 STATE_ANIM

# 3. 生成图标(可选,打包用)
npm run gen-icon
```

状态映射、气泡台词、工具名中文映射全都集中在 `shared/states.js`,换素材后主要改那一个文件。

## 运行

```bash
npm install
npm run install-hook   # 注册 Claude Code hook(merge-safe,首次自动备份 settings.json)
npm start              # 启动桌宠
npm run uninstall-hook # 移除 hook
```

打包成 macOS .app:

```bash
npm run build:mac                                   # → dist/mac-arm64/RemiPet.app
cp -R dist/mac-arm64/RemiPet.app ~/Applications/
```

- **拖拽**宠物本体移动位置(自动记忆);菜单栏图标里可调尺寸、勾选开机自启、完整演示、退出。
- hook 对**新开的** `claude` 会话生效;已开着的会话需重启。
- 桌宠没在跑时 hook 会在 ~150ms 内静默放弃,权限请求连接失败即回落终端提示,**不会拖慢或卡住 Claude Code**。

平台支持:目前只在 **macOS(arm64)** 上实测过。Windows / Linux 的托盘图标和 hook 安装代码已铺好,「去回复」的窗口聚焦需要各平台适配(niri 有 IPC,Windows 待做)。

## 架构

```
Claude Code hooks(11 个生命周期事件 + PermissionRequest 阻塞式 HTTP hook)
  └─ hook/remi-hook.js      stdin JSON → 状态,POST /state(<600ms 必退出)
       └─ backend/server.js  127.0.0.1:41560-41564,响应头 x-remi-pet 识别自家服务
            ├─ backend/core.js        按 session 聚合 + 优先级 + TTL 回落
            ├─ backend/permission.js  挂起 CC 连接等你点按钮,超时/断开自动放行终端
            ├─ backend/transcript.js  读 transcript 尾部:回复摘要 / 上下文占用 / API 错误
            └─ backend/metering.js    增量扫 ~/.claude/projects 算 token 与费用
                 └─ renderer/pet.js   spine-player 切动画 + 气泡 + 按钮
```

关键设计:

- `shared/states.js` 是状态词汇、优先级、动画映射、台词的**唯一事实源**。
- 权限 hook 走**阻塞式 HTTP**:CC 挂起等决定。安全兜底有三层——桌宠没跑则连接失败、8 分钟无人点自动放行、你在终端先答了则 CC 断开连接使卡片自动撤销。同一请求的重发会合并,一次点击答复所有副本。
- 打包后 hook 脚本**必须在 asar 之外**(CC 用系统 node 直接执行它),靠 `build.extraResources` 复制到 `Contents/Resources/pet-hook/`;app 启动时会自愈 hook 路径。
- hook 安装是 merge-safe 的:只增改 command 含 `remi-hook.js` 或 url 指向本机 `/permission` 的条目,你其他的 hook 一个字节都不碰,写入走 tmp+rename 原子替换,首次改动前备份。

## 数据文件

| 路径 | 内容 |
|---|---|
| `~/.remi-pet/config.json` | 窗口位置、尺寸 |
| `~/.remi-pet/runtime.json` | 运行时端口(退出时清除) |
| `~/.remi-pet/usage.json` | token 用量聚合(按天,保留 60 天) |
| `~/.remi-pet/pricing.json` | 可选,覆盖内置模型价格表 |
| `~/.claude/settings.json.remi-backup` | 首次安装 hook 前的备份 |

## 许可与素材权利 ⚠️

**代码**:MIT(见 `LICENSE`)。

**不提供预构建安装包**,只开源代码——原因见下面两条。自己 clone、自备素材、本地构建自用不受影响。

**素材**:不在本仓库内。使用者自备,并自行确保拥有相应授权。几种常见情形:

- 角色形象属于某商业 IP → 遵守该 IP 方的二次创作规约(通常限非商业使用)。
- Spine 骨骼工程由他人制作 → 再分发需该作者授权;很多同人素材明确禁止二次分发。
- **素材是从游戏客户端/官方资源里提取的** → 权利属于游戏公司。二创规约一般允许**自己创作**的同人,但基本都禁止直接使用与分发**游戏内美术资产**。转载者声明的「仅供学习使用」并不构成授权(他们通常不是权利人)。

自己本地跑一个桌宠自娱,和把素材打包分发出去,是完全不同的两件事。

**Spine Runtimes**:本项目用它渲染骨骼动画,其许可**不是** MIT。Spine Runtimes License Agreement 要求**每一位使用者自行持有有效的 Spine Editor 许可证**,且任何形式的再分发须附带该许可与版权声明。这是本项目不提供安装包的直接原因。详见 `THIRD-PARTY-NOTICES.md`。

灵感来自 [LLMPET](https://github.com/myunwang/LLMPET)(研究了它的 hook 接入机制);本仓库代码为独立实现。
