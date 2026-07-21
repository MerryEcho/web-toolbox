# 网页工具箱 Userscript

整合三大功能的浏览器用户脚本，支持 YouTube 和 Bilibili，全站可用。

## 功能概览

| 功能 | YouTube | B站 | 说明 |
|------|---------|-----|------|
| 字幕提取 | ✅ | ✅ | SRT/VTT/TXT/JSON 格式，可复制可下载 |
| 视频简介 | ✅ | ✅ | 标题/作者/发布日期/观看数/简介文本 |
| 评论获取 | ✅ | ✅ | 评论内容/作者/点赞/UP主标记，可复制 |
| 长截图 | ✅ 全站 | ✅ 全站 | 默认 html2canvas-pro（支持 oklab，无需授权）；可选 getDisplayMedia |
| 视频下载 | ✅ 需本地后端 | ✅ 纯前端 | DASH 流合并 mp4 / 纯音频 / 黑屏音频 mp4 |

## 安装

### 1. 安装用户脚本管理器

在浏览器中安装以下之一：
- [Tampermonkey](https://www.tampermonkey.net/)（推荐，支持 Chrome/Edge/Firefox）
- [Violentmonkey](https://violentmonkey.github.io/)

### 2. 安装网页工具箱脚本

**方式 A：从 GitHub 安装**

点击仓库中的 [`网页工具箱.user.js`](./网页工具箱.user.js)，点击 `Raw` 按钮，Tampermonkey 会自动弹出安装确认。

**方式 B：手动复制**

1. 打开仓库中的 [`网页工具箱.user.js`](./网页工具箱.user.js) 文件
2. 复制全部内容
3. 在 Tampermonkey 中新建脚本，粘贴内容并保存

### 自动更新

脚本头已包含 `@updateURL` / `@downloadURL`，指向 GitHub **Raw** 地址。合并到 `main` 后，Tampermonkey 可自动检查更新。

**不要填仓库主页**（如 `https://github.com/MerryEcho/web-toolbox`），必须填 raw 文件地址：

```text
https://raw.githubusercontent.com/MerryEcho/web-toolbox/main/%E7%BD%91%E9%A1%B5%E5%B7%A5%E5%85%B7%E7%AE%B1.user.js
```

在篡改猴 → 该脚本 → **设置** → **更新 URL** 粘贴上面这一行 → **保存** → **检查用户脚本的更新**。勾选「检查更新」即可之后自动更新。

> 若你是本地粘贴安装的旧版（无 `@updateURL`），填好上述 URL 并检查更新后，会升到仓库最新版（含自动更新元数据）。

### 3. YouTube 视频下载后端配置（仅 YouTube 需要）

YouTube 因 PoToken/nsig/SABR 三重反爬，纯前端无法下载，需本地后端。配置后可"网页点下载 → 自动启动后端 → 下载完成自动关闭"。

**依赖安装：**
```powershell
pip install yt-dlp
# ffmpeg 需单独安装（用于视频合并/音频转换/黑屏生成）
# Windows: 下载 https://www.gyan.dev/ffmpeg/builds/ 并添加到 PATH
```

**一次性注册自定义协议：**
1. 双击运行 [`register_yt_protocol.reg`](./register_yt_protocol.reg)
2. 确认注册表导入
3. 之后浏览器访问 `yt-dlp-server://start` 会自动启动后端

> 注册后，用户脚本在点下载时会自动触发协议启动后端（最小化窗口），下载完成后后端自动关闭。

**协议原理：**
- `register_yt_protocol.reg` 注册 `yt-dlp-server://` 协议，指向 `start_yt_server.bat`
- `start_yt_server.bat` 检查后端是否已运行，未运行则最小化窗口启动 `yt_download_server.py`
- 用户脚本点下载时调用 `ensureYtServer()`，触发协议并轮询等待后端就绪

## 使用方式

### 字幕 / 简介 / 评论提取

1. 打开 YouTube 或 B站视频页面
2. 点击页面右下角的工具箱按钮（🛠；可拖动，双击可贴边收起）
3. 选择对应功能：
   - **字幕轨道**：选择字幕语言和格式，点击复制或下载
   - **视频简介**：展开查看简介文本，可复制可下载
   - **评论获取**：加载评论（首次需 1-2 秒），可复制全部评论

> **YouTube 字幕**：需先播放视频并开启 CC 字幕，脚本通过拦截播放器请求获取 PoToken 签名的字幕 URL。
>
> **YouTube 评论**：适配 YouTube 2025 新版 API（commentViewModel + frameworkUpdates.entityBatchUpdate）。
>
> **B站评论**：使用旧版 `/x/v2/reply/main` API，无需 WBI 签名，更稳定。

### 长截图

1. 在任意页面点击工具箱 → 长截图（或快捷「开始截图」）
2. 选择截图目标（自动识别或手动选择区域）
3. 选择引擎：
   - **DOM 渲染（默认）**：html2canvas-pro，无需屏幕共享授权；支持 ChatGPT 等站点的 oklab/oklch 颜色
   - **真实捕获**：getDisplayMedia，需授权一次；失败自动回退 DOM
4. 设置参数（等待时间默认 350ms / 重叠像素 / 倍率）；可选「预加载懒加载图」
5. 可选勾选「复制到剪贴板（而非下载）」
6. 点击开始截图

> 悬浮钮可拖动到任意位置；双击可贴边收起成细条，点击展开。位置与收起状态会记住。

> 默认不弹屏幕共享。需要像素级真实画面时再选真实捕获（建议共享「此标签页」）。超长页面自动分卷 ZIP，并自动裁剪吸顶栏。

### 视频下载

#### B站（纯前端，无需后端）

1. 打开 B站视频页面
2. 工具箱 → 视频下载
3. 选择画质（480P 默认 / 720P / 1080P）
4. 点击三个按钮之一：
   - **下载视频（mp4）**：DASH 流下载并合并音视频（首次需加载 mp4box.js ~1MB）
   - **下载音频（m4a）**：直接下载 DASH 音频流
   - **黑屏音频 mp4**：WebCodecs 生成单帧黑屏 H.264 + 音频合并（需 Chrome 94+）

> **技术原理**：通过 playurl API 获取 DASH 流地址 → 下载 video.m4s + audio.m4s → mp4box.js demux 提取 samples → mp4-muxer mux 合并为单个 mp4。
>
> **编码选择**：优先选择 `avc1`（H.264）视频流，因为 mp4-muxer 只支持 AVC 编码。
>
> **API 策略**：优先使用旧版非 WBI playurl API（更稳定），回退到 WBI 签名 API。

#### YouTube（需本地后端）

1. 确保已完成上述"后端配置"
2. 打开 YouTube 视频页面
3. 工具箱 → 视频下载
4. 选择画质（480P / 720P / 1080P / 最高画质）
5. 点击下载按钮：
   - 首次点击时，浏览器弹出"是否允许打开 yt-dlp-server?"→ 点击**允许**
   - 后端以最小化窗口自动启动
   - 下载完成后后端自动关闭

> 如果未注册协议或不想用自动启动，也可手动运行 `python yt_download_server.py`（单次模式）或 `python yt_download_server.py --persistent`（持久模式）。

## 文件说明

| 文件 | 说明 |
|------|------|
| `网页工具箱.user.js` | 主用户脚本（Tampermonkey/Violentmonkey 安装） |
| `yt_download_server.py` | YouTube 下载本地 HTTP 后端（yt-dlp + ffmpeg） |
| `start_yt_server.bat` | 后端启动器（被自定义协议调用，最小化窗口启动） |
| `register_yt_protocol.reg` | 注册 `yt-dlp-server://` 自定义协议（一次性运行） |

## 技术栈

- **用户脚本**：JavaScript（IIFE），GM_xmlhttpRequest，WebCodecs API，动态库加载（mp4box.js / mp4-muxer）
- **YouTube 后端**：Python 3，http.server，yt-dlp，ffmpeg
- **协议启动**：Windows 自定义 URL 协议（.reg + .bat）

## 后端 API

`yt_download_server.py` 监听 `127.0.0.1:8765`，提供以下接口：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查，返回 yt-dlp / ffmpeg 可用性 |
| `/download` | POST | 下载视频，body: `{url, format, quality}` |

**format 取值：**
- `video`：下载视频+音频合并的 mp4
- `audio`：下载纯音频 mp3
- `blackscreen`：生成黑屏视频+音频的 mp4（需 ffmpeg）

**quality 取值：** `480p` / `720p` / `1080p` / `best`

## 故障排查

### YouTube 下载

- **"无法启动本地后端"**：确认已运行 `register_yt_protocol.reg` 注册协议，且 `start_yt_server.bat` 和 `yt_download_server.py` 在同一目录
- **浏览器未弹出确认框**：检查浏览器是否阻止了自定义协议，尝试在地址栏手动输入 `yt-dlp-server://start` 测试
- **yt-dlp 版本过旧**：运行 `pip install -U yt-dlp` 更新
- **ffmpeg 不可用**：确认 ffmpeg 在 PATH 中，运行 `ffmpeg -version` 验证

### B站 下载

- **"无法获取视频流"**：B站可能需要登录，尝试在浏览器登录 B站后重试
- **合并失败**：确认网络能加载 mp4box.js（jsdelivr CDN），首次合并需下载 ~1MB 库
- **黑屏视频生成失败**：确认浏览器支持 WebCodecs（Chrome 94+ / Edge 94+，Firefox 不支持）
- **视频流选择到 HEVC**：脚本已优先选择 avc1 流，若仍选到 hev1 请检查视频是否只有 HEVC 编码

### 字幕提取

- **YouTube 字幕为空**：需先播放视频并开启 CC 字幕，脚本通过拦截播放器请求获取字幕 URL
- **B站字幕需登录**：部分视频字幕仅对登录用户开放，请先登录 B站

## 许可

私有仓库，仅供作者使用。
