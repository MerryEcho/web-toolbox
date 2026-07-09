#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
YouTube 视频下载本地 HTTP 后端

用法:
    python yt_download_server.py                 # 默认监听 localhost:8765，下载完一次后退出
    python yt_download_server.py --port 9000     # 自定义端口
    python yt_download_server.py --persistent    # 持久运行，不随下载完成退出

接口:
    GET  /health    - 健康检查
        返回: {"status":"ok","yt-dlp":true,"ffmpeg":true/false}

    POST /download  - 下载视频
        body(JSON):
        {
            "url": "https://www.youtube.com/watch?v=xxx",
            "format": "video"|"audio"|"blackscreen",
            "quality": "480p"|"720p"|"1080p"|"best"
        }
        - format=video:       下载视频+音频合并的 mp4
        - format=audio:       下载纯音频 mp3
        - format=blackscreen: 下载纯音频，生成黑屏视频+音频的 mp4（需要 ffmpeg）
        - quality 仅对 video 生效，默认 720p

        成功: 流式返回文件内容，header 包含 Content-Type / Content-Disposition / Content-Length
        失败: 返回 JSON {"error": "错误信息"}

依赖:
    - Python 3.12+
    - yt-dlp (pip install yt-dlp)
    - ffmpeg (用于 video 合并、audio 转 mp3、blackscreen 生成；缺失时 blackscreen 不可用)

CORS:
    允许所有来源跨域调用，方便用户脚本(Tampermonkey 等)直接请求。
"""

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# ============================================================
# 全局配置
# ============================================================
HOST = "127.0.0.1"          # 仅监听本地，避免被外部访问
DEFAULT_PORT = 8765         # 默认端口
TIMEOUT = 600               # 子进程超时 10 分钟
CHUNK_SIZE = 64 * 1024      # 流式传输块大小 64KB

# quality 参数到 yt-dlp height 过滤的映射
# best 表示不做高度限制
QUALITY_MAP = {
    "480p": 480,
    "720p": 720,
    "1080p": 1080,
    "best": None,
}

# 文件扩展名到 MIME 类型的映射
MIME_MAP = {
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".webm": "video/webm",
}

# 依赖可用性（main 中初始化）
YT_DLP_AVAILABLE = False
FFMPEG_AVAILABLE = False
PERSISTENT = False
SERVER = None  # HTTPServer 实例，用于优雅关闭


# ============================================================
# 依赖检查
# ============================================================
def check_yt_dlp():
    """检查 yt-dlp 是否可导入"""
    try:
        import yt_dlp  # noqa: F401
        return True
    except ImportError:
        return False


def check_ffmpeg():
    """检查 ffmpeg 命令是否可用"""
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            timeout=10,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


# ============================================================
# 工具函数
# ============================================================
def extract_video_id(url):
    """从 YouTube URL 提取视频 ID，用于生成下载文件名"""
    # 匹配各种 YouTube URL 形式
    m = re.search(
        r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/|youtube\.com/shorts/)([a-zA-Z0-9_-]{11})',
        url,
    )
    if m:
        return m.group(1)
    # 退化方案：从 query 参数 v 取
    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    if "v" in qs and qs["v"]:
        return qs["v"][0]
    return "video"


def make_download_name(video_id, fmt):
    """根据视频 ID 和格式生成下载文件名"""
    if fmt == "audio":
        return f"{video_id}.mp3"
    if fmt == "blackscreen":
        return f"{video_id}_blackscreen.mp4"
    return f"{video_id}.mp4"


def get_mime_type(file_path):
    """根据文件扩展名获取 MIME 类型"""
    ext = os.path.splitext(file_path)[1].lower()
    return MIME_MAP.get(ext, "application/octet-stream")


def run_cmd(cmd):
    """执行命令并打印，返回 CompletedProcess；超时或失败抛异常"""
    print(f"[执行] {' '.join(cmd)}")
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
    )


# ============================================================
# 下载逻辑（对应需求中的 yt-dlp / ffmpeg 命令）
# ============================================================
def download_video(url, quality, temp_dir):
    """
    下载视频+音频并合并为 mp4
    对应命令: yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]"
             --merge-output-format mp4 -o tempfile URL
    """
    height = QUALITY_MAP.get(quality, 720)
    if height is None:
        # best：不做高度限制
        fmt_str = "bestvideo+bestaudio/best"
    else:
        fmt_str = f"bestvideo[height<={height}]+bestaudio/best[height<={height}]"

    output_template = os.path.join(temp_dir, "output.%(ext)s")
    # 用 python -m yt_dlp 确保使用当前 Python 环境的 yt-dlp
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "-f", fmt_str,
        "--merge-output-format", "mp4",
        "-o", output_template,
        "--no-playlist",
        "--no-warnings",
        url,
    ]
    result = run_cmd(cmd)
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp 下载失败: {result.stderr or result.stdout}")

    files = glob.glob(os.path.join(temp_dir, "output.*"))
    if not files:
        raise RuntimeError("yt-dlp 未生成输出文件")
    return files[0]


def download_audio(url, temp_dir):
    """
    下载纯音频并转为 mp3
    对应命令: yt-dlp -f "bestaudio" -x --audio-format mp3 -o tempfile URL
    """
    output_template = os.path.join(temp_dir, "output.%(ext)s")
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "-f", "bestaudio",
        "-x", "--audio-format", "mp3",
        "-o", output_template,
        "--no-playlist",
        "--no-warnings",
        url,
    ]
    result = run_cmd(cmd)
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp 下载音频失败: {result.stderr or result.stdout}")

    files = glob.glob(os.path.join(temp_dir, "output.*"))
    if not files:
        raise RuntimeError("yt-dlp 未生成输出文件")
    return files[0]


def download_blackscreen(url, temp_dir):
    """
    下载纯音频，再用 ffmpeg 生成黑屏视频 + 音频的 mp4
    对应命令:
      yt-dlp -f "bestaudio" -o audio.m4a URL
      ffmpeg -i audio.m4a -f lavfi -i color=black:s=320x240:r=1 -shortest
             -c:v libx264 -c:a aac out.mp4
    """
    if not FFMPEG_AVAILABLE:
        raise RuntimeError("ffmpeg 不可用，无法生成黑屏视频")

    # 1. 下载音频（优先 m4a，兜底 bestaudio）
    audio_template = os.path.join(temp_dir, "audio.%(ext)s")
    cmd1 = [
        sys.executable, "-m", "yt_dlp",
        "-f", "bestaudio[ext=m4a]/bestaudio",
        "-o", audio_template,
        "--no-playlist",
        "--no-warnings",
        url,
    ]
    result = run_cmd(cmd1)
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp 下载音频失败: {result.stderr or result.stdout}")

    audio_files = glob.glob(os.path.join(temp_dir, "audio.*"))
    if not audio_files:
        raise RuntimeError("yt-dlp 未生成音频文件")
    audio_file = audio_files[0]

    # 2. 用 ffmpeg 生成黑屏视频
    output_file = os.path.join(temp_dir, "blackscreen.mp4")
    cmd2 = [
        "ffmpeg", "-y",
        "-i", audio_file,
        "-f", "lavfi", "-i", "color=black:s=320x240:r=1",
        "-shortest",
        "-c:v", "libx264",
        "-c:a", "aac",
        output_file,
    ]
    result = run_cmd(cmd2)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 生成黑屏视频失败: {result.stderr or result.stdout}")

    if not os.path.exists(output_file):
        raise RuntimeError("ffmpeg 未生成输出文件")
    return output_file


# ============================================================
# HTTP 请求处理
# ============================================================
class DownloadHandler(BaseHTTPRequestHandler):
    """处理 /health 和 /download 请求"""

    # ---- 通用响应工具 ----
    def _set_cors_headers(self):
        """设置跨域响应头，允许用户脚本调用"""
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, code, data):
        """发送 JSON 响应"""
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._set_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        """覆盖默认日志，输出到 stdout"""
        print(f"[{self.log_date_time_string()}] {format % args}")

    # ---- OPTIONS 预检 ----
    def do_OPTIONS(self):
        """处理 CORS 预检请求"""
        self.send_response(204)
        self._set_cors_headers()
        self.end_headers()

    # ---- GET ----
    def do_GET(self):
        """处理 GET 请求"""
        if self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "yt-dlp": YT_DLP_AVAILABLE,
                "ffmpeg": FFMPEG_AVAILABLE,
            })
        else:
            self._send_json(404, {"error": "Not Found"})

    # ---- POST ----
    def do_POST(self):
        """处理 POST /download 请求"""
        if self.path != "/download":
            self._send_json(404, {"error": "Not Found"})
            return

        # 1. 读取并解析 JSON body
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length > 0 else b"{}"
            data = json.loads(body.decode("utf-8"))
        except Exception as e:
            self._send_json(400, {"error": f"无效的 JSON body: {e}"})
            return

        url = data.get("url")
        fmt = data.get("format", "video")
        quality = data.get("quality", "720p")

        # 2. 参数校验
        if not url or not isinstance(url, str):
            self._send_json(400, {"error": "缺少 url 参数"})
            return
        if fmt not in ("video", "audio", "blackscreen"):
            self._send_json(400, {"error": "format 必须是 video / audio / blackscreen"})
            return
        if quality not in QUALITY_MAP:
            self._send_json(400, {"error": "quality 必须是 480p / 720p / 1080p / best"})
            return
        if fmt == "blackscreen" and not FFMPEG_AVAILABLE:
            self._send_json(500, {"error": "ffmpeg 不可用，无法生成黑屏视频"})
            return

        print(f"\n[下载请求] url={url} format={fmt} quality={quality}")

        # 3. 创建临时目录，下载完成后清理
        temp_dir = tempfile.mkdtemp(prefix="ytdl_")
        print(f"[临时目录] {temp_dir}")

        headers_sent = False
        error_msg = None
        try:
            # 执行下载
            if fmt == "video":
                file_path = download_video(url, quality, temp_dir)
            elif fmt == "audio":
                file_path = download_audio(url, temp_dir)
            else:  # blackscreen
                file_path = download_blackscreen(url, temp_dir)

            file_size = os.path.getsize(file_path)
            video_id = extract_video_id(url)
            download_name = make_download_name(video_id, fmt)
            mime_type = get_mime_type(file_path)

            print(f"[下载完成] 文件: {file_path} 大小: {file_size} 字节 类型: {mime_type}")

            # 4. 发送成功响应头
            self.send_response(200)
            self.send_header("Content-Type", mime_type)
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{download_name}"',
            )
            self.send_header("Content-Length", str(file_size))
            self._set_cors_headers()
            self.end_headers()
            headers_sent = True

            # 5. 流式发送文件内容
            with open(file_path, "rb") as f:
                while True:
                    chunk = f.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

            print(f"[传输完成] {download_name} ({file_size} 字节)")

        except subprocess.TimeoutExpired:
            error_msg = "下载超时（超过 10 分钟）"
        except Exception as e:
            error_msg = str(e)
        finally:
            # 6. 清理临时目录
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
                print(f"[清理] 已删除临时目录 {temp_dir}")
            except Exception as e:
                print(f"[清理失败] {e}")

        # 7. 错误处理：仅在尚未发送响应头时返回 JSON 错误
        if error_msg:
            print(f"[错误] {error_msg}")
            if not headers_sent:
                try:
                    self._send_json(500, {"error": error_msg})
                except Exception:
                    pass  # 连接已断开，忽略

        # 8. 非持久模式：下载完成后关闭服务器
        if not PERSISTENT and SERVER is not None:
            print("[退出] 非持久模式，即将关闭服务器（使用 --persistent 保持运行）")

            def _shutdown():
                time.sleep(0.5)  # 等待响应发送完成
                SERVER.shutdown()

            threading.Thread(target=_shutdown, daemon=True).start()


# ============================================================
# 主入口
# ============================================================
def main():
    global YT_DLP_AVAILABLE, FFMPEG_AVAILABLE, PERSISTENT, SERVER

    parser = argparse.ArgumentParser(description="YouTube 视频下载本地 HTTP 后端")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口（默认 8765）")
    parser.add_argument("--persistent", action="store_true", help="持久运行模式（默认下载完一次后退出）")
    args = parser.parse_args()

    PERSISTENT = args.persistent

    # 检查依赖
    YT_DLP_AVAILABLE = check_yt_dlp()
    FFMPEG_AVAILABLE = check_ffmpeg()

    print("=" * 60)
    print("YouTube 视频下载服务器")
    print("=" * 60)
    print(f"yt-dlp : {'可用' if YT_DLP_AVAILABLE else '不可用'}")
    print(f"ffmpeg : {'可用' if FFMPEG_AVAILABLE else '不可用'}")
    if not YT_DLP_AVAILABLE:
        print("错误: yt-dlp 未安装，请运行: pip install yt-dlp")
        sys.exit(1)
    if not FFMPEG_AVAILABLE:
        print("警告: ffmpeg 不可用，video 合并 / audio 转 mp3 / blackscreen 可能失败")
    print(f"监听地址: http://{HOST}:{args.port}")
    print(f"运行模式: {'持久运行' if PERSISTENT else '单次下载后退出（加 --persistent 保持运行）'}")
    print("接口:")
    print(f"  GET  /health")
    print(f"  POST /download   body: {{url, format, quality}}")
    print("=" * 60)

    # 启动服务器
    SERVER = ThreadingHTTPServer((HOST, args.port), DownloadHandler)
    try:
        SERVER.serve_forever()
    except KeyboardInterrupt:
        print("\n[服务器关闭] 收到中断信号 (Ctrl+C)")
    finally:
        SERVER.server_close()
        print("[服务器已关闭]")


if __name__ == "__main__":
    main()
