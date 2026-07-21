// ==UserScript==
// @name         网页工具箱 - 视频文字源 & 长截图 & 视频下载
// @namespace    https://chatgpt.com/
// @version      4.2.4
// @description  整合视频文字源提取（YouTube/B站：字幕、简介、评论）、长截图（默认 html2canvas-pro，支持 oklab 等现代 CSS；可选 getDisplayMedia 真实捕获）、视频下载（B站 DASH 流合并 mp4 / 纯音频 / 黑屏音频 mp4；YouTube 需本地 yt-dlp 后端）。悬浮钮可拖拽/贴边收起。一级面板快捷操作，二级面板高级选项。全站可用，美观简约。
// @author       ChatGPT
// @homepageURL  https://github.com/MerryEcho/web-toolbox
// @supportURL   https://github.com/MerryEcho/web-toolbox/issues
// @updateURL    https://raw.githubusercontent.com/MerryEcho/web-toolbox/main/%E7%BD%91%E9%A1%B5%E5%B7%A5%E5%85%B7%E7%AE%B1.user.js
// @downloadURL  https://raw.githubusercontent.com/MerryEcho/web-toolbox/main/%E7%BD%91%E9%A1%B5%E5%B7%A5%E5%85%B7%E7%AE%B1.user.js
// @resource     html2canvas https://cdn.jsdelivr.net/npm/html2canvas-pro@1.5.11/dist/html2canvas-pro.min.js
// @resource     jszip https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        unsafeWindow
// @connect      *
// @connect      cdn.jsdelivr.net
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const APP_ID = 'web-toolbox-userscript-styles';
  const BUTTON_ID = 'web-toolbox-button';
  const PANEL_ID = 'web-toolbox-panel';
  const URL_POLL_MS = 1000;
  const REQUEST_TIMEOUT_MS = 25000;
  const LS_SS_ENGINE = 'wt-ss-engine';
  const LS_FAB_POS = 'wt-fab-pos';
  const LS_FAB_COLLAPSED = 'wt-fab-collapsed';
  const FAB_DRAG_THRESHOLD = 5;

  let lastUrl = location.href;

  function lsGet(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch { return fallback; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  }

  function getScreenshotEngine() {
    const v = lsGet(LS_SS_ENGINE, 'dom');
    return v === 'screen' ? 'screen' : 'dom';
  }

  function setScreenshotEngine(engine) {
    lsSet(LS_SS_ENGINE, engine === 'screen' ? 'screen' : 'dom');
  }

  // ===========================================================================
  // 通用工具
  // ===========================================================================
  function isYouTube() {
    return /(^|\.)youtube\.com$/i.test(location.hostname);
  }

  function isBilibili() {
    return /(^|\.)bilibili\.com$/i.test(location.hostname);
  }

  function hasSubtitleFeature() {
    return isYouTube() || isBilibili();
  }

  function getYouTubeVideoId() {
    const url = new URL(location.href);
    if (url.pathname === '/watch') return url.searchParams.get('v');
    const shorts = url.pathname.match(/^\/shorts\/([^/?#]+)/);
    return shorts ? shorts[1] : null;
  }

  function sanitizeFilename(value) {
    return String(value || 'output')
      .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150) || 'output';
  }

  function getPageTitle() {
    const title = document.title
      .replace(/\s*-\s*YouTube\s*$/i, '')
      .replace(/_哔哩哔哩_bilibili\s*$/i, '')
      .trim();
    return sanitizeFilename(title);
  }

  function normalizeUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) return `${location.protocol}${url}`;
    try { return new URL(url, location.href).href; } catch { return url; }
  }

  function withQueryParam(url, key, value) {
    const parsed = new URL(normalizeUrl(url));
    parsed.searchParams.set(key, value);
    return parsed.href;
  }

  function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value !== undefined && value !== null) {
        node.setAttribute(key, String(value));
      }
    });
    const list = Array.isArray(children) ? children : [children];
    list.filter(Boolean).forEach(child => node.appendChild(
      typeof child === 'string' ? document.createTextNode(child) : child
    ));
    return node;
  }

  function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
    const content = filename.toLowerCase().endsWith('.srt') ? `\uFEFF${text}` : text;
    const blob = new Blob([content], { type: mime });
    downloadBlob(blob, filename);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      if (typeof GM_download === 'function') {
        GM_download({
          url, name: filename, saveAs: true,
          onload: () => URL.revokeObjectURL(url),
          onerror: () => fallbackDownload(url, filename)
        });
      } else {
        fallbackDownload(url, filename);
      }
    } catch {
      fallbackDownload(url, filename);
    }
  }

  function fallbackDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function copyTextToClipboard(text) {
    try {
      await uw.navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 回退：用 textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      return ok;
    }
  }

  async function copyImageToClipboard(blob) {
    if (!uw.ClipboardItem) throw new Error('当前浏览器不支持复制图片到剪贴板');
    await uw.navigator.clipboard.write([new uw.ClipboardItem({ 'image/png': blob })]);
  }

  // ===========================================================================
  // 视频信息模块 - YouTube 简介
  // ===========================================================================
  function getYouTubeVideoInfo() {
    const responses = getYouTubePlayerResponses();
    const currentId = getYouTubeVideoId();
    const matching = responses.find(r => r?.videoDetails?.videoId === currentId)
      || responses.find(r => r?.videoDetails);
    if (!matching) return null;
    const vd = matching.videoDetails;
    return {
      site: 'youtube',
      videoId: vd?.videoId || currentId,
      title: vd?.title || getPageTitle(),
      author: vd?.author || '',
      channelId: vd?.channelId || '',
      description: vd?.shortDescription || '',
      lengthSeconds: vd?.lengthSeconds || '',
      viewCount: vd?.viewCount || '',
      publishDate: vd?.publishDate || '',
      keywords: Array.isArray(vd?.keywords) ? vd.keywords : [],
    };
  }

  // ===========================================================================
  // 视频信息模块 - B站简介
  // ===========================================================================
  function getBilibiliVideoInfo() {
    const state = uw.__INITIAL_STATE__ || {};
    const vd = state.videoData || state.mediaInfo || {};
    return {
      site: 'bilibili',
      bvid: vd.bvid || '',
      aid: vd.aid || 0,
      title: vd.title || getPageTitle(),
      author: vd.owner?.name || '',
      description: vd.desc || '',
      viewCount: vd.stat?.view || '',
      publishDate: vd.pubdate ? new Date(vd.pubdate * 1000).toISOString().slice(0, 10) : '',
      keywords: Array.isArray(vd?.tag) ? vd.tag : [],
    };
  }

  function getVideoInfo() {
    if (isYouTube()) return getYouTubeVideoInfo();
    if (isBilibili()) return getBilibiliVideoInfo();
    return null;
  }

  // ===========================================================================
  // 视频信息模块 - YouTube 评论拦截器
  // YouTube 评论通过 /youtubei/v1/next 接口加载，拦截播放器自身的请求来获取响应
  // ===========================================================================
  const nextResponseCache = [];

  function installNextInterceptor() {
    try {
      const origFetch = uw.fetch;
      if (origFetch && !origFetch.__nextWrapped) {
        const wrapped = function(input, init) {
          const url = typeof input === 'string' ? input : (input?.url || '');
          const p = origFetch.call(this, input, init);
          if (url && /\/youtubei\/v1\/next/.test(url)) {
            p.then(response => {
              try {
                const clone = response.clone();
                clone.json().then(data => {
                  if (data) {
                    nextResponseCache.push({ data, ts: Date.now() });
                    if (nextResponseCache.length > 20) nextResponseCache.shift();
                  }
                }).catch(() => {});
              } catch {}
            }).catch(() => {});
          }
          return p;
        };
        wrapped.__nextWrapped = true;
        uw.fetch = wrapped;
      }
    } catch {}
  }

  // 从 ytInitialData 获取评论的首次 continuation token
  function findCommentsContinuationToken() {
    try {
      const data = uw.ytInitialData;
      if (!data) return null;
      const results = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
      if (!Array.isArray(results)) return null;
      for (const item of results) {
        const isr = item.itemSectionRenderer;
        if (!isr || isr.sectionIdentifier !== 'comment-item-section') continue;
        const cont = (isr.contents || []).find(c => c.continuationItemRenderer);
        if (!cont) continue;
        const ep = cont.continuationItemRenderer.continuationEndpoint;
        return {
          token: ep?.continuationCommand?.token || '',
          clickTrackingParams: ep?.clickTrackingParams || '',
        };
      }
    } catch {}
    return null;
  }

  // 从 ytcfg 获取 InnerTube 配置（通过 unsafeWindow 直接访问，无需注入 script）
  async function getInnerTubeConfig() {
    try {
      const cfg = uw.ytcfg;
      if (cfg && typeof cfg.get === 'function') {
        const ctx = cfg.get('INNERTUBE_CONTEXT') || {};
        return {
          apiKey: cfg.get('INNERTUBE_API_KEY') || '',
          clientVersion: cfg.get('INNERTUBE_CONTEXT_CLIENT_VERSION') || '',
          visitorData: ctx.client?.visitorData || '',
          clientName: ctx.client?.clientName || 'WEB',
          hl: ctx.client?.hl || 'zh-CN',
          gl: ctx.client?.gl || 'HK',
        };
      }
    } catch {}
    // 回退：使用硬编码的公共 API Key
    return {
      apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
      clientVersion: '2.20240101.00.00',
      visitorData: '',
      clientName: 'WEB',
      hl: 'zh-CN',
      gl: 'HK',
    };
  }

  function runsToText(runs) {
    if (!runs) return '';
    if (typeof runs === 'string') return runs;
    return runs.map(r => r?.text || '').join('');
  }

  async function fetchYouTubeComments(token, clickTrackingParams) {
    const config = await getInnerTubeConfig();
    if (!config?.apiKey) throw new Error('无法获取 YouTube InnerTube 配置');
    const body = {
      context: {
        client: {
          hl: config.hl,
          gl: config.gl,
          visitorData: config.visitorData,
          userAgent: navigator.userAgent,
          clientName: config.clientName,
          clientVersion: config.clientVersion,
          originalUrl: location.href,
        }
      },
      continuation: token,
    };
    if (clickTrackingParams) body.clickTracking = { clickTrackingParams };
    const url = `https://www.youtube.com/youtubei/v1/next?key=${config.apiKey}&prettyPrint=false`;
    const response = await uw.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    if (!response.ok) throw new Error(`评论请求失败：HTTP ${response.status}`);
    return await response.json();
  }

  function parseYouTubeComments(data) {
    const comments = [];
    let nextToken = null;
    let nextClickTracking = null;

    // 新版 YouTube API：评论数据在 frameworkUpdates.entityBatchUpdate.mutations 中
    // commentThreadRenderer 通过 commentViewModel.commentKey 关联到 entityMap
    const entityMap = {};
    const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
    for (const m of mutations) {
      const p = m.payload?.commentEntityPayload;
      if (p?.key) {
        entityMap[p.key] = {
          commentId: p.properties?.commentId || '',
          content: p.properties?.content?.content || '',
          publishedTime: p.properties?.publishedTime || '',
          author: p.author?.displayName || '',
          isCreator: p.author?.isCreator || false,
          isPinned: !!(p.properties?.pinnedCommentStatus || p.properties?.pinnedTime),
          likes: p.toolbar?.likeCountLiked || '0',
          replyCount: parseInt(p.toolbar?.replyCount) || 0,
        };
      }
    }

    const actions = data?.onResponseReceivedEndpoints || [];
    for (const act of actions) {
      const container = act.appendContinuationItemsAction
        || act.reloadContinuationItemsAction
        || act.appendContinuationItemsCommand
        || act.reloadContinuationItemsCommand;
      const items = container?.continuationItems || [];
      for (const item of items) {
        if (item.commentThreadRenderer) {
          // 新版 API：commentViewModel → commentKey → entityMap
          const vm = item.commentThreadRenderer.commentViewModel?.commentViewModel;
          if (vm?.commentKey && entityMap[vm.commentKey]) {
            const e = entityMap[vm.commentKey];
            comments.push({
              id: e.commentId || vm.commentId || '',
              author: e.author,
              text: e.content,
              publishedTime: e.publishedTime,
              likes: e.likes,
              isCreator: e.isCreator,
              isPinned: e.isPinned,
              replyCount: e.replyCount,
            });
          } else {
            // 旧版 API：comment.commentRenderer
            const c = item.commentThreadRenderer.comment?.commentRenderer;
            if (c) {
              comments.push({
                id: c.commentId,
                author: c.authorText?.simpleText || runsToText(c.authorText?.runs),
                text: runsToText(c.contentText?.runs),
                publishedTime: c.publishedTimeText?.runs?.[0]?.text || '',
                likes: c.voteCount?.simpleText || '0',
                isCreator: !!c.authorCommentBadge,
                isPinned: !!c.pinnedCommentBadge,
                replyCount: c.replyCount || 0,
              });
            }
          }
        } else if (item.continuationItemRenderer) {
          const ep = item.continuationItemRenderer.continuationEndpoint;
          nextToken = ep?.continuationCommand?.token || null;
          nextClickTracking = ep?.clickTrackingParams || null;
        }
      }
    }
    return { comments, nextToken, nextClickTracking };
  }

  // ===========================================================================
  // 视频信息模块 - B站评论
  // ===========================================================================
  async function fetchBilibiliComments(aid, page = 1) {
    // 优先使用旧版 API（无需 WBI 签名，更稳定）
    const url = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&pn=${page}&ps=20&mode=3`;
    const response = await requestJson(url);
    if (response?.code !== 0) throw new Error(response?.message || `B站评论接口错误：${response?.code}`);
    const replies = response?.data?.replies || [];
    const comments = replies.map(r => ({
      id: String(r.rpid),
      author: r.member?.uname || '',
      text: r.content?.message || '',
      publishedTime: r.ctime ? formatBiliTime(r.ctime) : '',
      likes: String(r.like || 0),
      isCreator: false,
      replyCount: r.count || 0,
    }));
    const totalPages = response?.data?.page?.count ? Math.ceil(response.data.page.count / 20) : 0;
    const nextPage = page < totalPages ? page + 1 : null;
    return { comments, nextPage };
  }

  function formatBiliTime(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}天前`;
    const d = new Date(timestamp * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ===========================================================================
  // 视频信息模块 - 评论获取统一接口
  // ===========================================================================
  async function getCommentsFirstPage() {
    if (isYouTube()) {
      // 1. 尝试从拦截器缓存获取
      for (let i = nextResponseCache.length - 1; i >= 0; i--) {
        const parsed = parseYouTubeComments(nextResponseCache[i].data);
        if (parsed.comments.length > 0) {
          return { comments: parsed.comments, nextToken: parsed.nextToken, nextClickTracking: parsed.nextClickTracking };
        }
      }
      // 2. 从 ytInitialData 获取 token，主动请求
      const tokenInfo = findCommentsContinuationToken();
      if (!tokenInfo?.token) throw new Error('未找到评论区入口。请先滚动到评论区让 YouTube 加载评论。');
      let data = await fetchYouTubeComments(tokenInfo.token, tokenInfo.clickTrackingParams);
      let parsed = parseYouTubeComments(data);
      // 首次调用可能只返回评论头信息（0 条评论 + 下页 token），自动跟进一次
      if (parsed.comments.length === 0 && parsed.nextToken) {
        data = await fetchYouTubeComments(parsed.nextToken, parsed.nextClickTracking);
        parsed = parseYouTubeComments(data);
      }
      return { comments: parsed.comments, nextToken: parsed.nextToken, nextClickTracking: parsed.nextClickTracking };
    }
    if (isBilibili()) {
      const identity = await getBilibiliVideoIdentity();
      if (!identity.aid) throw new Error('无法获取 B站视频 ID');
      const result = await fetchBilibiliComments(identity.aid, 1);
      return { comments: result.comments, nextPage: result.nextPage };
    }
    return { comments: [] };
  }

  async function getCommentsNextPage(state) {
    if (isYouTube()) {
      if (!state.nextToken) return null;
      const data = await fetchYouTubeComments(state.nextToken, state.nextClickTracking);
      const parsed = parseYouTubeComments(data);
      return { comments: parsed.comments, nextToken: parsed.nextToken, nextClickTracking: parsed.nextClickTracking };
    }
    if (isBilibili()) {
      if (!state.nextPage) return null;
      const identity = await getBilibiliVideoIdentity();
      const result = await fetchBilibiliComments(identity.aid, state.nextPage);
      return { comments: result.comments, nextPage: result.nextPage };
    }
    return null;
  }

  // ===========================================================================
  // 视频信息模块 - 评论格式化
  // ===========================================================================
  function commentsToText(comments, videoTitle) {
    const lines = [];
    lines.push(`# ${videoTitle || '视频评论'}`);
    lines.push(`# 共 ${comments.length} 条评论`);
    lines.push('');
    comments.forEach((c, i) => {
      const tags = [];
      if (c.isCreator) tags.push('UP主');
      if (c.isPinned) tags.push('置顶');
      const tagStr = tags.length ? ` [${tags.join('、')}]` : '';
      lines.push(`${i + 1}. ${c.author}${tagStr} | ${c.publishedTime} | 👍 ${c.likes}`);
      lines.push(`   ${c.text.replace(/\n/g, '\n   ')}`);
      if (c.replyCount > 0) lines.push(`   └ ${c.replyCount} 条回复`);
      lines.push('');
    });
    return lines.join('\n');
  }

  // ===========================================================================
  // 视频下载模块 - 动态库加载
  // ===========================================================================
  async function loadScriptBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        url, method: 'GET', timeout: 30000,
        onload: r => {
          if (r.status !== 200) { reject(new Error(`加载库失败：HTTP ${r.status}`)); return; }
          try {
            try {
              new Function(r.responseText).call(globalThis);
              resolve();
              return;
            } catch {}
            const blob = new Blob([r.responseText], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            const s = document.createElement('script');
            s.src = blobUrl;
            s.onload = () => { URL.revokeObjectURL(blobUrl); resolve(); };
            s.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('脚本加载失败')); };
            document.head.appendChild(s);
          } catch (e) { reject(e); }
        },
        onerror: () => reject(new Error('网络错误，无法加载库')),
        ontimeout: () => reject(new Error('加载库超时'))
      });
    });
  }

  const libStatus = { md5: false, mp4box: false, mp4muxer: false };

  async function ensureMd5() {
    if (libStatus.md5 || window.md5 || globalThis.md5) { libStatus.md5 = true; return; }
    await loadScriptBlob('https://cdn.jsdelivr.net/npm/js-md5@0.8.3/src/md5.min.js');
    libStatus.md5 = !!(window.md5 || globalThis.md5);
  }

  async function ensureMp4Libs() {
    if (!libStatus.mp4box) {
      await loadScriptBlob('https://cdn.jsdelivr.net/npm/mp4box@0.5.0/dist/mp4box.min.js');
      libStatus.mp4box = !!(window.MP4Box || globalThis.MP4Box);
    }
    if (!libStatus.mp4muxer) {
      await loadScriptBlob('https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.0/dist/mp4-muxer.min.js');
      libStatus.mp4muxer = !!(window.mp4Muxer || globalThis.mp4Muxer);
    }
  }

  // ===========================================================================
  // 视频下载模块 - B站 WBI 签名
  // ===========================================================================
  const WBI_MIXIN_TABLE = [
    46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,60,56,40,29,
    44,21,6,33,43,30,52,11,59,49,1,7,5,36,9,17,42,4,51,25,
    37,57,20,16,41,48,24,22,12,27,26,55,34,14,28,19,13,38,54,
    0,39
  ];
  let _cachedMixinKey = null;
  let _cachedMixinKeyTime = 0;

  async function getBiliMixinKey() {
    if (_cachedMixinKey && Date.now() - _cachedMixinKeyTime < 3600000) return _cachedMixinKey;
    await ensureMd5();
    const nav = await requestJson('https://api.bilibili.com/x/web-interface/nav');
    const imgUrl = nav?.data?.wbi_img?.img_url || '';
    const subUrl = nav?.data?.wbi_img?.sub_url || '';
    const imgKey = imgUrl.split('/').pop().split('.')[0];
    const subKey = subUrl.split('/').pop().split('.')[0];
    const raw = imgKey + subKey;
    let mixinKey = '';
    for (let i = 0; i < 32; i++) mixinKey += raw[WBI_MIXIN_TABLE[i]] || '';
    _cachedMixinKey = mixinKey;
    _cachedMixinKeyTime = Date.now();
    return mixinKey;
  }

  function signWbi(params, mixinKey) {
    const allParams = { ...params, wts: Math.floor(Date.now() / 1000) };
    const keys = Object.keys(allParams).sort();
    const query = keys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`).join('&');
    allParams.w_rid = md5(query + mixinKey);
    return allParams;
  }

  // ===========================================================================
  // 视频下载模块 - B站 playurl API
  // ===========================================================================
  const BILI_QUALITY_MAP = {
    '480P': { qn: 32, label: '480P' },
    '720P': { qn: 64, label: '720P' },
    '1080P': { qn: 80, label: '1080P' },
    '1080P+': { qn: 112, label: '1080P+ 高码率' },
    '1080P60': { qn: 116, label: '1080P 60帧' },
    '4K': { qn: 120, label: '4K 超清' },
  };

  async function getBiliPlayUrl(bvid, cid, qn = 32) {
    // 优先使用旧版非 WBI playurl API（更稳定，WBI 版可能返回 v_voucher 验证挑战）
    const params = {
      bvid, cid: String(cid), qn: String(qn),
      fnval: '16', fourk: '1', fnver: '0', high_quality: '1',
    };
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

    // 1. 尝试旧版 API（无需 WBI 签名）
    const oldUrl = `https://api.bilibili.com/x/player/playurl?${query}`;
    const oldResp = await requestJson(oldUrl);
    if (oldResp?.code === 0 && oldResp?.data?.dash?.video?.length) {
      return oldResp.data;
    }

    // 2. 回退到 WBI 签名 API
    const mixinKey = await getBiliMixinKey();
    const signed = signWbi(params, mixinKey);
    const wbiUrl = 'https://api.bilibili.com/x/player/wbi/playurl?' +
      Object.entries(signed).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const wbiResp = await requestJson(wbiUrl);
    if (wbiResp?.code !== 0) throw new Error(wbiResp?.message || `playurl 接口错误：${wbiResp?.code}`);
    if (!wbiResp?.data?.dash?.video?.length) {
      throw new Error('无法获取视频流（B站可能需要登录或触发了风控）');
    }
    return wbiResp.data;
  }

  function selectBiliVideoStream(dashData, preferredQn) {
    const videos = dashData?.dash?.video || [];
    if (!videos.length) return null;
    const matchingQn = videos.filter(v => v.id === preferredQn);
    const pool = matchingQn.length ? matchingQn : videos;
    // 优先选 avc1（H.264）编码，因为 mp4-muxer 只支持 AVC
    const avcPool = pool.filter(v => (v.codecs || '').startsWith('avc1'));
    const finalPool = avcPool.length ? avcPool : pool;
    return finalPool.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  }

  function selectBiliAudioStream(dashData) {
    const audios = dashData?.dash?.audio || [];
    if (!audios.length) return null;
    return audios.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  }

  function getBiliAcceptQualities(data) {
    const acceptQn = data?.accept_quality || [];
    const acceptDesc = data?.accept_description || [];
    const result = [];
    for (let i = 0; i < acceptQn.length; i++) {
      const qn = acceptQn[i];
      const desc = acceptDesc[i] || '';
      for (const [key, val] of Object.entries(BILI_QUALITY_MAP)) {
        if (val.qn === qn) { result.push({ key, qn, label: desc || val.label }); break; }
      }
    }
    if (!result.length) result.push({ key: '480P', qn: 32, label: '480P（默认）' });
    return result;
  }

  // ===========================================================================
  // 视频下载模块 - 文件下载
  // ===========================================================================
  function downloadArrayBuffer(url, onProgress) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: normalizeUrl(url),
        responseType: 'arraybuffer',
        timeout: 600000,
        headers: { 'Referer': 'https://www.bilibili.com' },
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.response);
          } else {
            reject(new Error(`下载失败：HTTP ${response.status}`));
          }
        },
        onprogress(e) {
          if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
        },
        ontimeout() { reject(new Error('下载超时（10分钟）')); },
        onerror() { reject(new Error('下载失败，网络错误')); }
      });
    });
  }

  // ===========================================================================
  // 视频下载模块 - MP4 demux + mux（合并音视频）
  // ===========================================================================
  function demuxMp4(arrayBuffer) {
    return new Promise((resolve, reject) => {
      const file = MP4Box.createFile();
      const tracks = {};
      let videoTrackId = null, audioTrackId = null;
      let videoSamples = [], audioSamples = [];

      file.onError = (e) => reject(new Error('MP4 解析错误：' + e));
      file.onReady = (info) => {
        for (const track of info.tracks) {
          tracks[track.id] = track;
          if (track.type === 'video') videoTrackId = track.id;
          if (track.type === 'audio') audioTrackId = track.id;
        }
        if (videoTrackId !== null) file.setExtractionOptions(videoTrackId);
        if (audioTrackId !== null) file.setExtractionOptions(audioTrackId);
        file.start();
      };
      file.onSamples = (trackId, user, samples) => {
        if (trackId === videoTrackId) videoSamples = videoSamples.concat(samples);
        if (trackId === audioTrackId) audioSamples = audioSamples.concat(samples);
      };

      try {
        const buf = arrayBuffer.buffer ? arrayBuffer.buffer.slice(0) : arrayBuffer.slice(0);
        buf.fileStart = 0;
        const stop = file.appendBuffer(buf);
        if (stop) file.flush();

        const result = () => ({
          videoTrack: videoTrackId !== null ? tracks[videoTrackId] : null,
          audioTrack: audioTrackId !== null ? tracks[audioTrackId] : null,
          videoSamples,
          audioSamples,
        });

        // onSamples 通常在 appendBuffer/flush 期间同步触发
        // 若已收到 samples 则立即 resolve，否则短暂等待异步回调
        if (videoSamples.length > 0 || audioSamples.length > 0) {
          resolve(result());
        } else {
          setTimeout(() => resolve(result()), 500);
        }
      } catch (e) { reject(e); }
    });
  }

  function samplesToVideoChunks(samples, track) {
    const timescale = track.timescale || 90000;
    return samples.map(s => new EncodedVideoChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: Math.round(s.cts * 1e6 / timescale),
      duration: Math.round(s.duration * 1e6 / timescale),
      data: s.data || new Uint8Array(0),
    }));
  }

  function samplesToAudioChunks(samples, track) {
    const timescale = track.timescale || 48000;
    return samples.map(s => new EncodedAudioChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: Math.round(s.cts * 1e6 / timescale),
      duration: Math.round(s.duration * 1e6 / timescale),
      data: s.data || new Uint8Array(0),
    }));
  }

  function parseAvcConfig(track) {
    return { codec: 'avc', width: track?.video?.width || 1920, height: track?.video?.height || 1080 };
  }

  function parseAacConfig(track) {
    return { codec: 'aac', sampleRate: track?.audio?.sample_rate || 44100, numberOfChannels: track?.audio?.channel_count || 2 };
  }

  async function mergeVideoAudio(videoBuffer, audioBuffer) {
    await ensureMp4Libs();
    const vDemux = await demuxMp4(videoBuffer);
    const aDemux = await demuxMp4(audioBuffer);
    const vConfig = parseAvcConfig(vDemux.videoTrack);
    const aConfig = parseAacConfig(aDemux.audioTrack);

    const muxer = new mp4Muxer.Muxer({
      target: new mp4Muxer.ArrayBufferTarget(),
      video: vConfig,
      audio: aConfig,
      fastStart: 'in-memory',
    });

    if (vDemux.videoSamples.length > 0) {
      for (const chunk of samplesToVideoChunks(vDemux.videoSamples, vDemux.videoTrack)) {
        muxer.addVideoChunk(chunk, {});
      }
    }
    if (aDemux.audioSamples.length > 0) {
      for (const chunk of samplesToAudioChunks(aDemux.audioSamples, aDemux.audioTrack)) {
        muxer.addAudioChunk(chunk, {});
      }
    }
    muxer.finalize();
    return muxer.target.buffer;
  }

  // ===========================================================================
  // 视频下载模块 - 黑屏音频 mp4
  // ===========================================================================
  async function createBlackScreenVideoMp4(audioBuffer, durationSec) {
    await ensureMp4Libs();
    const aDemux = await demuxMp4(audioBuffer);
    if (!aDemux.audioTrack) throw new Error('无法解析音频轨');
    const aConfig = parseAacConfig(aDemux.audioTrack);

    // 用 WebCodecs 生成单帧黑屏 H.264 关键帧
    const width = 320, height = 240;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    let videoChunk = null;
    const encoder = new VideoEncoder({
      output: (chunk) => { videoChunk = chunk; },
      error: () => {},
    });
    encoder.configure({ codec: 'avc1.42c01e', width, height, bitrate: 100000, framerate: 1 });
    const frame = new VideoFrame(canvas, { timestamp: 0, duration: Math.round(durationSec * 1e6) });
    encoder.encode(frame, { keyFrame: true });
    await encoder.flush();
    frame.close();
    encoder.close();

    if (!videoChunk) throw new Error('黑屏视频编码失败');

    // 合并黑屏视频 + 音频
    const muxer = new mp4Muxer.Muxer({
      target: new mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width, height },
      audio: aConfig,
      fastStart: 'in-memory',
    });

    muxer.addVideoChunk(videoChunk, {});
    if (aDemux.audioSamples.length > 0) {
      for (const chunk of samplesToAudioChunks(aDemux.audioSamples, aDemux.audioTrack)) {
        muxer.addAudioChunk(chunk, {});
      }
    }
    muxer.finalize();
    return muxer.target.buffer;
  }

  // ===========================================================================
  // 视频下载模块 - YouTube 本地后端
  // ===========================================================================
  const YT_SERVER = 'http://127.0.0.1:8765';

  async function checkYtServer() {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET', url: YT_SERVER + '/health', timeout: 3000,
        onload: r => {
          if (r.status === 200) {
            try { resolve(JSON.parse(r.responseText)); } catch { resolve(null); }
          } else { resolve(null); }
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  // 自定义协议 URL：浏览器访问此 URL 会触发系统调用 start_yt_server.bat
  const YT_PROTOCOL_URL = 'yt-dlp-server://start';

  // 确保后端运行：先检查，未运行则触发协议启动，然后轮询等待就绪
  async function ensureYtServer(status, onProgress) {
    // 1. 先检查后端是否已在运行
    let health = await checkYtServer();
    if (health && health['yt-dlp']) return health;

    // 2. 后端未运行，触发自定义协议启动
    if (status) status.textContent = '正在启动本地后端（浏览器可能弹出确认框，请允许）…';
    const launcher = document.createElement('a');
    launcher.href = YT_PROTOCOL_URL;
    launcher.style.display = 'none';
    document.body.appendChild(launcher);
    launcher.click();
    launcher.remove();

    // 3. 轮询等待后端就绪（最多 20 秒，每 500ms 检查一次）
    if (onProgress) onProgress('等待后端启动…');
    for (let i = 0; i < 40; i++) {
      await wait(500);
      health = await checkYtServer();
      if (health && health['yt-dlp']) return health;
      if (onProgress) onProgress(`等待后端启动… ${Math.round((i + 1) * 0.5)}s`);
    }
    return null;
  }

  function downloadFromYtServer(url, format, quality, onProgress) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: YT_SERVER + '/download',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ url, format, quality }),
        responseType: 'arraybuffer',
        timeout: 600000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.response);
          } else {
            let msg = `HTTP ${response.status}`;
            try { msg = new TextDecoder().decode(response.response); } catch {}
            reject(new Error(msg));
          }
        },
        onprogress(e) {
          if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
        },
        ontimeout() { reject(new Error('下载超时（10分钟）')); },
        onerror() { reject(new Error('无法连接本地后端，请确认已运行 yt_download_server.py')); }
      });
    });
  }

  // ===========================================================================
  // 视频下载模块 - 统一下载接口
  // ===========================================================================
  async function downloadBiliVideo(status, qualityKey) {
    const identity = await getBilibiliVideoIdentity();
    if (!identity.aid || !identity.cid) throw new Error('无法获取 B站视频信息（aid/cid）');
    const qn = BILI_QUALITY_MAP[qualityKey]?.qn || 32;
    status.textContent = '正在获取视频流地址…';
    const data = await getBiliPlayUrl(identity.bvid || `BV${identity.aid}`, identity.cid, qn);
    const videoStream = selectBiliVideoStream(data, qn);
    const audioStream = selectBiliAudioStream(data);
    if (!videoStream) throw new Error('未找到可用的视频流');
    if (!audioStream) throw new Error('未找到可用的音频流');

    status.textContent = '正在下载视频流…';
    const videoBuffer = await downloadArrayBuffer(videoStream.base_url, (loaded, total) => {
      status.textContent = `下载视频流… ${Math.round(loaded / total * 100)}%`;
    });
    status.textContent = '正在下载音频流…';
    const audioBuffer = await downloadArrayBuffer(audioStream.base_url, (loaded, total) => {
      status.textContent = `下载音频流… ${Math.round(loaded / total * 100)}%`;
    });

    status.textContent = '正在合并音视频（首次需加载库，约 1MB）…';
    const merged = await mergeVideoAudio(videoBuffer, audioBuffer);
    const blob = new Blob([merged], { type: 'video/mp4' });
    const filename = `${sanitizeFilename(identity.title || 'video')}.mp4`;
    downloadBlob(blob, filename);
    return filename;
  }

  async function downloadBiliAudio(status) {
    const identity = await getBilibiliVideoIdentity();
    if (!identity.aid || !identity.cid) throw new Error('无法获取 B站视频信息（aid/cid）');
    status.textContent = '正在获取音频流地址…';
    const data = await getBiliPlayUrl(identity.bvid || `BV${identity.aid}`, identity.cid, 32);
    const audioStream = selectBiliAudioStream(data);
    if (!audioStream) throw new Error('未找到可用的音频流');

    status.textContent = '正在下载音频…';
    const audioBuffer = await downloadArrayBuffer(audioStream.base_url, (loaded, total) => {
      status.textContent = `下载音频… ${Math.round(loaded / total * 100)}%`;
    });
    const blob = new Blob([audioBuffer], { type: 'audio/mp4' });
    const filename = `${sanitizeFilename(identity.title || 'audio')}.m4a`;
    downloadBlob(blob, filename);
    return filename;
  }

  async function downloadBiliBlackScreen(status) {
    const identity = await getBilibiliVideoIdentity();
    if (!identity.aid || !identity.cid) throw new Error('无法获取 B站视频信息（aid/cid）');
    status.textContent = '正在获取音频流地址…';
    const data = await getBiliPlayUrl(identity.bvid || `BV${identity.aid}`, identity.cid, 32);
    const audioStream = selectBiliAudioStream(data);
    if (!audioStream) throw new Error('未找到可用的音频流');

    status.textContent = '正在下载音频…';
    const audioBuffer = await downloadArrayBuffer(audioStream.base_url, (loaded, total) => {
      status.textContent = `下载音频… ${Math.round(loaded / total * 100)}%`;
    });

    status.textContent = '正在生成黑屏视频（需 WebCodecs 支持）…';
    const duration = parseFloat(data?.dash?.duration) || 300;
    const mp4Buffer = await createBlackScreenVideoMp4(audioBuffer, duration);
    const blob = new Blob([mp4Buffer], { type: 'video/mp4' });
    const filename = `${sanitizeFilename(identity.title || 'audio')}.黑屏.mp4`;
    downloadBlob(blob, filename);
    return filename;
  }

  async function downloadYtVideo(status, quality) {
    const health = await ensureYtServer(status, msg => status.textContent = msg);
    if (!health) throw new Error('无法启动本地后端，请手动运行 yt_download_server.py');
    if (!health.ffmpeg) status.textContent = '警告：ffmpeg 不可用，视频合并可能失败';
    status.textContent = '正在通过本地后端下载…';
    const buffer = await downloadFromYtServer(location.href, 'video', quality, (loaded, total) => {
      if (total) status.textContent = `下载中… ${Math.round(loaded / total * 100)}%`;
    });
    const blob = new Blob([buffer], { type: 'video/mp4' });
    const filename = `${sanitizeFilename(getPageTitle())}.mp4`;
    downloadBlob(blob, filename);
    return filename;
  }

  async function downloadYtAudio(status) {
    const health = await ensureYtServer(status, msg => status.textContent = msg);
    if (!health) throw new Error('无法启动本地后端，请手动运行 yt_download_server.py');
    status.textContent = '正在通过本地后端下载音频…';
    const buffer = await downloadFromYtServer(location.href, 'audio', 'best', (loaded, total) => {
      if (total) status.textContent = `下载音频… ${Math.round(loaded / total * 100)}%`;
    });
    const blob = new Blob([buffer], { type: 'audio/mpeg' });
    const filename = `${sanitizeFilename(getPageTitle())}.mp3`;
    downloadBlob(blob, filename);
    return filename;
  }

  async function downloadYtBlackScreen(status) {
    const health = await ensureYtServer(status, msg => status.textContent = msg);
    if (!health) throw new Error('无法启动本地后端，请手动运行 yt_download_server.py');
    if (!health.ffmpeg) throw new Error('ffmpeg 不可用，无法生成黑屏视频');
    status.textContent = '正在通过本地后端生成黑屏音频 mp4…';
    const buffer = await downloadFromYtServer(location.href, 'blackscreen', 'best', (loaded, total) => {
      if (total) status.textContent = `生成中… ${Math.round(loaded / total * 100)}%`;
    });
    const blob = new Blob([buffer], { type: 'video/mp4' });
    const filename = `${sanitizeFilename(getPageTitle())}.黑屏.mp4`;
    downloadBlob(blob, filename);
    return filename;
  }
  // ===========================================================================
  const timedTextCache = [];

  function parseTimedTextUrl(rawUrl) {
    try {
      const u = new URL(normalizeUrl(rawUrl));
      if (!/timedtext/i.test(u.pathname)) return null;
      return {
        videoId: u.searchParams.get('v') || '',
        lang: u.searchParams.get('lang') || '',
        tlang: u.searchParams.get('tlang') || '',
        kind: u.searchParams.get('kind') || '',
        fmt: u.searchParams.get('fmt') || '',
      };
    } catch { return null; }
  }

  function cacheTimedText(rawUrl, body) {
    if (!body || !String(body).trim()) return;
    const info = parseTimedTextUrl(rawUrl);
    if (!info) return;
    timedTextCache.push({ ...info, body: String(body), url: normalizeUrl(rawUrl), ts: Date.now() });
    if (timedTextCache.length > 80) timedTextCache.shift();
  }

  function findCachedTimedText(videoId, lang, kind) {
    kind = kind || '';
    for (let i = timedTextCache.length - 1; i >= 0; i--) {
      const e = timedTextCache[i];
      if (e.videoId === videoId && e.lang === lang && e.kind === kind && e.fmt === 'json3') return e;
    }
    for (let i = timedTextCache.length - 1; i >= 0; i--) {
      const e = timedTextCache[i];
      if (e.videoId === videoId && e.lang === lang && e.fmt === 'json3') return e;
    }
    for (let i = timedTextCache.length - 1; i >= 0; i--) {
      const e = timedTextCache[i];
      if (e.videoId === videoId && (e.lang === lang || e.tlang === lang)) return e;
    }
    return null;
  }

  function installTimedTextInterceptor() {
    try {
      const xhrProto = uw.XMLHttpRequest.prototype;
      const origOpen = xhrProto.open;
      const origSend = xhrProto.send;
      xhrProto.open = function(method, url, ...rest) {
        this.__seUrl = url;
        return origOpen.call(this, method, url, ...rest);
      };
      xhrProto.send = function(body) {
        const url = this.__seUrl;
        if (url && typeof url === 'string' && /timedtext/i.test(url)) {
          this.addEventListener('load', () => {
            try { if (this.readyState === 4 && this.responseText) cacheTimedText(url, this.responseText); } catch {}
          });
        }
        return origSend.call(this, body);
      };
    } catch {}
    try {
      const origFetch = uw.fetch;
      if (origFetch && !origFetch.__seWrapped) {
        const wrapped = function(input, init) {
          const url = typeof input === 'string' ? input : (input?.url || '');
          const p = origFetch.call(this, input, init);
          if (url && /timedtext/i.test(url)) {
            p.then(response => {
              try {
                const clone = response.clone();
                clone.text().then(body => { if (body) cacheTimedText(url, body); }).catch(() => {});
              } catch {}
            }).catch(() => {});
          }
          return p;
        };
        wrapped.__seWrapped = true;
        uw.fetch = wrapped;
      }
    } catch {}
  }

  // ===========================================================================
  // 字幕提取模块 - 网络请求
  // ===========================================================================
  function gmRequestText(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: normalizeUrl(url), anonymous: false, timeout: REQUEST_TIMEOUT_MS,
        headers: options.headers || {},
        onload(response) {
          if (response.status >= 200 && response.status < 300) resolve(response.responseText);
          else reject(new Error(`请求失败：HTTP ${response.status}`));
        },
        ontimeout() { reject(new Error('请求字幕超时')); },
        onerror() { reject(new Error('请求字幕失败，可能是登录状态、地区限制或接口变更')); }
      });
    });
  }

  async function requestJson(url) {
    const normalized = normalizeUrl(url);
    try {
      const response = await uw.fetch(normalized, { method: 'GET', credentials: 'include', cache: 'no-store' });
      if (response.ok) return await response.json();
    } catch {}
    const text = await gmRequestText(normalized);
    try { return JSON.parse(text); }
    catch { throw new Error('字幕接口返回的内容不是有效 JSON'); }
  }

  // ===========================================================================
  // 字幕提取模块 - 格式转换
  // ===========================================================================
  function formatTimestamp(milliseconds, separator = ',') {
    const safe = Math.max(0, Math.round(Number(milliseconds) || 0));
    const h = Math.floor(safe / 3600000);
    const m = Math.floor((safe % 3600000) / 60000);
    const s = Math.floor((safe % 60000) / 1000);
    const ms = safe % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`;
  }

  function normalizeCueText(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .trim();
  }

  function cuesToSrt(cues) {
    return cues.map((cue, index) => [
      index + 1,
      `${formatTimestamp(cue.start, ',')} --> ${formatTimestamp(cue.end, ',')}`,
      normalizeCueText(cue.text), ''
    ].join('\n')).join('\n');
  }

  function cuesToVtt(cues) {
    const body = cues.map(cue => [
      `${formatTimestamp(cue.start, '.')} --> ${formatTimestamp(cue.end, '.')}`,
      normalizeCueText(cue.text), ''
    ].join('\n')).join('\n');
    return `WEBVTT\n\n${body}`;
  }

  function cuesToTxt(cues) {
    return cues.map(cue => normalizeCueText(cue.text)).filter(Boolean).join('\n');
  }

  function youtubeJson3ToCues(data) {
    const rawEvents = Array.isArray(data?.events) ? data.events : [];
    const prepared = rawEvents
      .map(event => ({
        text: normalizeCueText(Array.isArray(event.segs) ? event.segs.map(s => s?.utf8 || '').join('') : ''),
        start: Number(event.tStartMs) || 0,
        duration: Number(event.dDurationMs) || 0,
      }))
      .filter(e => e.text);
    return prepared.map((event, index) => {
      const nextStart = prepared[index + 1]?.start;
      let end = event.duration > 0 ? event.start + event.duration : nextStart;
      if (!Number.isFinite(end) || end <= event.start) end = event.start + 2000;
      return { start: event.start, end, text: event.text };
    });
  }

  function bilibiliJsonToCues(data) {
    const body = Array.isArray(data?.body) ? data.body : [];
    return body.map(item => {
      const start = Math.max(0, Math.round((Number(item.from) || 0) * 1000));
      let end = Math.max(0, Math.round((Number(item.to) || 0) * 1000));
      if (end <= start) end = start + 2000;
      return { start, end, text: normalizeCueText(item.content) };
    }).filter(cue => cue.text);
  }

  // ===========================================================================
  // 字幕提取模块 - 轨道获取
  // ===========================================================================
  let cachedTracks = null;
  let cachedKey = '';

  function currentVideoKey() {
    if (isYouTube()) return `yt:${getYouTubeVideoId() || location.pathname}`;
    if (isBilibili()) return `bili:${location.pathname}${location.search}`;
    return location.href;
  }

  function getYouTubePlayerResponses() {
    const responses = [];
    const add = candidate => {
      if (!candidate) return;
      if (typeof candidate === 'string') { try { candidate = JSON.parse(candidate); } catch { return; } }
      if (typeof candidate === 'object') responses.push(candidate);
    };
    try { add(uw.document?.getElementById('movie_player')?.getPlayerResponse?.()); } catch {}
    try { add(document.getElementById('movie_player')?.getPlayerResponse?.()); } catch {}
    try { add(uw.ytInitialPlayerResponse); } catch {}
    try { add(uw.ytplayer?.config?.args?.player_response); } catch {}
    try {
      const ytdPlayer = document.querySelector('ytd-player');
      add(ytdPlayer?.getPlayerResponse?.());
      add(ytdPlayer?.playerResponse);
    } catch {}
    return responses;
  }

  function getYouTubeTracks() {
    const currentId = getYouTubeVideoId();
    const responses = getYouTubePlayerResponses();
    const matching = responses.find(r => r?.videoDetails?.videoId === currentId)
      || responses.find(r => r?.captions);
    const renderer = matching?.captions?.playerCaptionsTracklistRenderer;
    const tracks = Array.isArray(renderer?.captionTracks) ? renderer.captionTracks : [];
    return tracks.map((track, index) => ({
      site: 'youtube',
      id: `${track.vssId || track.languageCode || index}`,
      label: track?.name?.simpleText || track?.name?.runs?.map(r => r.text).join('') || track.languageCode || `字幕 ${index + 1}`,
      language: track.languageCode || 'und',
      auto: track.kind === 'asr',
      url: normalizeUrl(track.baseUrl),
      videoId: matching?.videoDetails?.videoId || currentId,
      title: matching?.videoDetails?.title || getPageTitle()
    }));
  }

  async function getBilibiliVideoIdentity() {
    const url = new URL(location.href);
    const state = uw.__INITIAL_STATE__ || {};
    const epInfo = state.epInfo || state?.mediaInfo?.episodes?.find?.(ep => String(ep.id) === url.pathname.split('/').pop());
    if (epInfo?.aid && epInfo?.cid) {
      return { aid: epInfo.aid, cid: epInfo.cid, bvid: epInfo.bvid || '', title: epInfo.longTitle || epInfo.title || state?.mediaInfo?.title || getPageTitle() };
    }
    const bvMatch = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
    const avMatch = url.pathname.match(/\/video\/av(\d+)/i);
    const bvid = bvMatch?.[1] || state?.videoData?.bvid || '';
    const aid = Number(avMatch?.[1] || state?.videoData?.aid || 0) || 0;
    if (bvid || aid) {
      const viewUrl = new URL('https://api.bilibili.com/x/web-interface/view');
      if (bvid) viewUrl.searchParams.set('bvid', bvid);
      else viewUrl.searchParams.set('aid', String(aid));
      const view = await requestJson(viewUrl.href);
      if (view?.code !== 0 || !view?.data) throw new Error(view?.message || '无法读取 B 站视频信息');
      const pageNumber = Math.max(1, Number(url.searchParams.get('p') || 1));
      const page = view.data.pages?.[pageNumber - 1] || view.data.pages?.[0];
      if (!page?.cid) throw new Error('无法确定当前分P的 CID');
      return { aid: view.data.aid, cid: page.cid, bvid: view.data.bvid || bvid, title: pageNumber > 1 && page?.part ? `${view.data.title} - P${pageNumber} ${page.part}` : view.data.title || getPageTitle() };
    }
    const videoData = state.videoData;
    if (videoData?.aid && videoData?.cid) {
      return { aid: videoData.aid, cid: videoData.cid, bvid: videoData.bvid || '', title: videoData.title || getPageTitle() };
    }
    throw new Error('无法识别当前 B 站视频。请确认页面已完成加载。');
  }

  async function getBilibiliTracks() {
    const identity = await getBilibiliVideoIdentity();
    const api = new URL('https://api.bilibili.com/x/player/wbi/v2');
    api.searchParams.set('aid', String(identity.aid));
    api.searchParams.set('cid', String(identity.cid));
    const response = await requestJson(api.href);
    if (response?.code !== 0) throw new Error(response?.message || `B 站字幕接口错误：${response?.code ?? '未知'}`);
    const subtitles = response?.data?.subtitle?.subtitles;
    if ((!Array.isArray(subtitles) || subtitles.length === 0) && response?.data?.need_login_subtitle) {
      throw new Error('该视频字幕仅对已登录账号开放。请先登录 B 站，然后重新读取。');
    }
    if (!Array.isArray(subtitles)) return [];
    return subtitles.map((track, index) => ({
      site: 'bilibili',
      id: String(track.id ?? index),
      label: track.lan_doc || track.lan || `字幕 ${index + 1}`,
      language: track.lan || 'und',
      auto: Boolean(track.ai_status) || /^ai[-_]/i.test(track.lan || ''),
      url: normalizeUrl(track.subtitle_url),
      aid: identity.aid, cid: identity.cid, bvid: identity.bvid, title: identity.title
    }));
  }

  async function loadTracks(force = false) {
    const key = currentVideoKey();
    if (!force && cachedTracks && cachedKey === key) return cachedTracks;
    let tracks;
    if (isYouTube()) tracks = getYouTubeTracks();
    else if (isBilibili()) tracks = await getBilibiliTracks();
    else tracks = [];
    cachedTracks = tracks;
    cachedKey = key;
    return tracks;
  }

  // ===========================================================================
  // 字幕提取模块 - 下载
  // ===========================================================================
  function triggerCaptionLoad(track) {
    try {
      const player = uw.document?.getElementById?.('movie_player') || document.getElementById('movie_player');
      if (!player) return false;
      if (typeof player.loadModule === 'function') { try { player.loadModule('captions'); } catch {} }
      if (typeof player.setOption === 'function') {
        player.setOption('captions', 'track', { languageCode: track.language, kind: track.auto ? 'asr' : '', vssId: track.id, name: track.label });
        return true;
      }
      if (typeof player.toggleSubtitles === 'function') { player.toggleSubtitles(); return true; }
    } catch {}
    return false;
  }

  async function waitForCachedTimedText(videoId, lang, kind, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entry = findCachedTimedText(videoId, lang, kind);
      if (entry) return entry;
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }

  async function downloadYouTubeTrack(track) {
    const kind = track.auto ? 'asr' : '';
    const cached = findCachedTimedText(track.videoId, track.language, kind);
    if (cached) { try { return JSON.parse(cached.body); } catch {} }
    if (triggerCaptionLoad(track)) {
      const entry = await waitForCachedTimedText(track.videoId, track.language, kind, 6000);
      if (entry) { try { return JSON.parse(entry.body); } catch {} }
    }
    const jsonUrl = withQueryParam(track.url, 'fmt', 'json3');
    try { return await requestJson(jsonUrl); }
    catch (err) {
      throw new Error(
        'YouTube 字幕获取失败。YouTube 已对字幕接口启用 PoToken 验证。\n' +
        '请尝试：在视频播放器上手动开启字幕（CC 按钮），选择目标语言，然后重新点击下载。\n' +
        `原始错误：${err?.message || err}`
      );
    }
  }

  function extensionFor(format) { return format.toLowerCase(); }

  function buildFilename(track, format) {
    const title = sanitizeFilename(track.title || getPageTitle());
    const language = sanitizeFilename(track.language || 'und');
    const auto = track.auto ? '.自动字幕' : '';
    const videoId = sanitizeFilename(track.videoId || track.bvid || track.aid || 'video');
    return `${title} [${videoId}].${language}${auto}.${extensionFor(format)}`;
  }

  async function fetchTrackContent(track) {
    if (!track.url) throw new Error('该字幕轨道没有可用下载地址');
    let raw, cues;
    if (track.site === 'youtube') {
      raw = await downloadYouTubeTrack(track);
      cues = youtubeJson3ToCues(raw);
    } else {
      raw = await requestJson(track.url);
      cues = bilibiliJsonToCues(raw);
    }
    if (cues.length === 0 && !raw) throw new Error('字幕文件已取得，但没有解析到有效字幕条目');
    return { raw, cues };
  }

  function formatTrackText(raw, cues, format) {
    if (format === 'json') return JSON.stringify(raw, null, 2);
    if (format === 'srt') return cuesToSrt(cues);
    if (format === 'vtt') return cuesToVtt(cues);
    if (format === 'txt') return cuesToTxt(cues);
    throw new Error(`不支持的格式：${format}`);
  }

  async function downloadTrack(track, format) {
    const { raw, cues } = await fetchTrackContent(track);
    if (format !== 'json' && cues.length === 0) throw new Error('字幕文件已取得，但没有解析到有效字幕条目');
    const text = formatTrackText(raw, cues, format);
    const filename = buildFilename(track, format);
    const mime = format === 'json' ? 'application/json;charset=utf-8'
      : format === 'srt' ? 'application/x-subrip;charset=utf-8'
      : format === 'vtt' ? 'text/vtt;charset=utf-8'
      : 'text/plain;charset=utf-8';
    downloadText(filename, text, mime);
  }

  async function copyTrack(track, format) {
    const { raw, cues } = await fetchTrackContent(track);
    if (format !== 'json' && cues.length === 0) throw new Error('字幕文件已取得，但没有解析到有效字幕条目');
    const text = formatTrackText(raw, cues, format);
    const ok = await copyTextToClipboard(text);
    if (!ok) throw new Error('复制失败，可能是浏览器权限不足');
  }

  // ===========================================================================
  // 长截图模块 - 动态加载库
  // ===========================================================================
  function resolveLoadedLibrary(globalName) {
    return globalThis[globalName] || window[globalName] || uw[globalName] || null;
  }

  function execLibraryCode(code, globalName) {
    // Tampermonkey 沙箱常带有 module/exports，UMD 会走 CommonJS 分支而不挂 window。
    // 自备 module 容器接住导出，同时清掉 AMD define，避免“下载成功却找不到全局变量”。
    try {
      const runner = new Function(`
        var module = { exports: {} };
        var exports = module.exports;
        var define = undefined;
        ${code}
        ;var __lib = (typeof ${globalName} !== 'undefined' && ${globalName})
          || (this && this.${globalName})
          || module.exports;
        if (__lib && typeof __lib === 'object' && __lib.default) __lib = __lib.default;
        return __lib;
      `);
      const fromSandbox = runner.call(globalThis);
      if (fromSandbox) {
        try { globalThis[globalName] = fromSandbox; } catch {}
        try { window[globalName] = fromSandbox; } catch {}
        try { uw[globalName] = fromSandbox; } catch {}
        return fromSandbox;
      }
    } catch (err) {
      console.warn('[工具箱] 沙箱加载库失败，尝试页面注入:', globalName, err);
    }

    // 回退：注入页面（无严格 CSP 的站点）
    try {
      const script = document.createElement('script');
      script.textContent = code;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch (err) {
      console.warn('[工具箱] 页面注入失败:', globalName, err);
    }
    return resolveLoadedLibrary(globalName);
  }

  async function loadLibrary(url, globalName, resourceName) {
    const existing = resolveLoadedLibrary(globalName);
    if (existing) return existing;

    // 优先用 @resource（安装/更新时由 Tampermonkey 缓存），避免运行时被页面 CSP/网络干扰
    if (resourceName && typeof GM_getResourceText === 'function') {
      try {
        const localCode = GM_getResourceText(resourceName);
        if (localCode && localCode.length > 100) {
          const lib = execLibraryCode(localCode, globalName);
          if (lib) return lib;
        }
      } catch (err) {
        console.warn('[工具箱] 读取 @resource 失败:', resourceName, err);
      }
    }

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 30000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            try {
              const lib = execLibraryCode(response.responseText, globalName);
              if (lib) resolve(lib);
              else reject(new Error(`${globalName} 加载失败：库已下载但无法在沙箱/页面中初始化`));
            } catch (e) { reject(e); }
          } else {
            reject(new Error(`加载 ${globalName} 失败：HTTP ${response.status}`));
          }
        },
        onerror: () => reject(new Error('网络错误，无法加载截图库')),
        ontimeout: () => reject(new Error('加载截图库超时'))
      });
    });
  }

  // ===========================================================================
  // 长截图模块 - 滚动容器识别
  // ===========================================================================
  let selectedScrollElement = null;
  let isCapturing = false;

  function isElementScrollable(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 200) return false;
    if (el.scrollHeight <= el.clientHeight + 100) return false;
    const style = getComputedStyle(el);
    const canScroll = ['auto', 'scroll', 'overlay'].includes(style.overflowY);
    return canScroll || el.scrollHeight > el.clientHeight * 1.2;
  }

  function findBestScrollableElement() {
    const all = Array.from(document.querySelectorAll('body *'));
    let best = null, bestScore = 0;
    for (const el of all) {
      if (!isElementScrollable(el)) continue;
      const rect = el.getBoundingClientRect();
      const visibleRatio = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) *
        Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      if (visibleRatio <= 0) continue;
      const score = el.scrollHeight * Math.min(rect.width, innerWidth) + visibleRatio * 2;
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best;
  }

  function findScrollableAncestor(el) {
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (isElementScrollable(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function isWindowScrollable() {
    return document.documentElement.scrollHeight > innerHeight + 100;
  }

  function getScrollTarget() {
    if (selectedScrollElement && document.contains(selectedScrollElement)) return { type: 'element', el: selectedScrollElement };
    const auto = findBestScrollableElement();
    if (auto) return { type: 'element', el: auto };
    if (isWindowScrollable()) return { type: 'window', el: null };
    return { type: 'viewport', el: null };
  }

  function describeTarget(target) {
    if (target.type === 'window') return '页面窗口';
    if (target.type === 'viewport') return '当前可视区域';
    const el = target.el;
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `<${el.tagName.toLowerCase()}${cls}>`;
  }

  // ===========================================================================
  // 长截图模块 - 滚动控制
  // ===========================================================================
  function saveScrollState(target) {
    if (target.type === 'element') return { scrollTop: target.el.scrollTop, scrollLeft: target.el.scrollLeft };
    return { scrollX: scrollX, scrollY: scrollY };
  }

  function restoreScrollState(target, state) {
    if (!state) return;
    if (target.type === 'element') { target.el.scrollTop = state.scrollTop; target.el.scrollLeft = state.scrollLeft; }
    else scrollTo(state.scrollX || 0, state.scrollY || 0);
  }

  function getMetrics(target) {
    if (target.type === 'element') return { totalHeight: target.el.scrollHeight, viewportHeight: target.el.clientHeight, viewportWidth: target.el.clientWidth };
    if (target.type === 'window') return { totalHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), viewportHeight: innerHeight, viewportWidth: innerWidth };
    return { totalHeight: innerHeight, viewportHeight: innerHeight, viewportWidth: innerWidth };
  }

  function buildScrollPositions(totalHeight, viewportHeight, overlap) {
    if (totalHeight <= viewportHeight) return [0];
    const step = Math.max(1, viewportHeight - overlap);
    const positions = [];
    for (let y = 0; y < totalHeight - viewportHeight; y += step) positions.push(y);
    const last = Math.max(0, totalHeight - viewportHeight);
    if (positions[positions.length - 1] !== last) positions.push(last);
    return positions;
  }

  function scrollToPosition(target, y) {
    if (target.type === 'element') target.el.scrollTop = y;
    else if (target.type === 'window') scrollTo(0, y);
  }

  function getCaptureRect(target) {
    if (target.type === 'element') {
      const rect = target.el.getBoundingClientRect();
      return {
        left: Math.max(0, rect.left), top: Math.max(0, rect.top),
        width: Math.max(1, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)),
        height: Math.max(1, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top))
      };
    }
    return { left: 0, top: 0, width: innerWidth, height: innerHeight };
  }

  async function preloadByScrolling(target, positions, delay) {
    const roughStep = Math.max(1, Math.floor(positions.length / 10));
    for (let i = 0; i < positions.length; i += roughStep) {
      scrollToPosition(target, positions[i]);
      await wait(Math.min(delay, 400));
    }
    scrollToPosition(target, 0);
    await wait(delay);
  }

  // ===========================================================================
  // 长截图模块 - getDisplayMedia 真实截图
  // ===========================================================================
  async function captureWithDisplayMedia(target, options, metrics, onProgress) {
    if (!uw.navigator?.mediaDevices?.getDisplayMedia) return null;

    let stream;
    try {
      // Chromium 友好约束：优先当前标签页，减少选错窗口；不支持的字段会被忽略
      const constraints = {
        video: {
          cursor: 'never',
          displaySurface: 'browser'
        },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        systemAudio: 'exclude'
      };
      const getStream = uw.navigator.mediaDevices.getDisplayMedia(constraints);
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('用户未响应屏幕共享请求')), 120000));
      stream = await Promise.race([getStream, timeout]);
    } catch { return null; }

    const video = el('video', { muted: true, playsinline: '' });
    video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;pointer-events:none;z-index:-1;';
    video.srcObject = stream;
    document.body.appendChild(video);

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('屏幕共享流加载超时')), 10000);
        video.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
      });
      await video.play();
      await wait(150);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      const positions = buildScrollPositions(metrics.totalHeight, metrics.viewportHeight, options.overlap);
      const streamW = video.videoWidth;
      const streamH = video.videoHeight;
      const cssToStreamX = streamW / innerWidth;
      const cssToStreamY = streamH / innerHeight;
      const chunks = [];

      for (let i = 0; i < positions.length; i++) {
        scrollToPosition(target, positions[i]);
        await wait(options.delay);

        const rect = getCaptureRect(target);
        const sx = Math.round(rect.left * cssToStreamX);
        const sy = Math.round(rect.top * cssToStreamY);
        const sw = Math.round(rect.width * cssToStreamX);
        const sh = Math.round(rect.height * cssToStreamY);

        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = sh;
        canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

        chunks.push({ canvas, pos: positions[i], cropTopCss: 0 });
        onProgress(`真实截图中：${i + 1}/${positions.length}`);
      }

      return chunks;
    } finally {
      stream.getTracks().forEach(t => t.stop());
      video.remove();
    }
  }

  // ===========================================================================
  // 长截图模块 - html2canvas 回退
  // ===========================================================================
  async function captureWithHtml2Canvas(target, options, metrics, onProgress) {
    const h2c = await loadLibrary('https://cdn.jsdelivr.net/npm/html2canvas-pro@1.5.11/dist/html2canvas-pro.min.js', 'html2canvas', 'html2canvas')
      || resolveLoadedLibrary('html2canvas');
    if (!h2c) throw new Error('html2canvas 加载失败');

    const positions = buildScrollPositions(metrics.totalHeight, metrics.viewportHeight, options.overlap);
    const chunks = [];

    for (let i = 0; i < positions.length; i++) {
      scrollToPosition(target, positions[i]);
      await wait(options.delay);
      const rect = getCaptureRect(target);
      const canvas = await h2c(document.documentElement, {
        x: rect.left + scrollX, y: rect.top + scrollY,
        width: rect.width, height: rect.height,
        windowWidth: innerWidth, windowHeight: innerHeight,
        scrollX: scrollX, scrollY: scrollY,
        backgroundColor: '#ffffff', useCORS: true, allowTaint: false,
        imageTimeout: 12000, scale: options.scale
      });
      chunks.push({ canvas, pos: positions[i], cropTopCss: 0 });
      onProgress(`截图中：${i + 1}/${positions.length}`);
    }
    return chunks;
  }

  // ===========================================================================
  // 长截图模块 - 智能吸顶栏检测
  // ===========================================================================
  function detectStickyHeaderHeight(chunks, scale) {
    if (chunks.length < 2) return 0;
    const c1 = chunks[0].canvas;
    const c2 = chunks[1].canvas;
    const sampleHeight = Math.min(Math.round(200 * scale), Math.floor(c1.height / 4));
    if (sampleHeight < 20) return 0;
    try {
      const ctx1 = c1.getContext('2d');
      const ctx2 = c2.getContext('2d');
      let matchStart = -1, matchEnd = -1;
      const sampleStep = Math.max(1, Math.floor(c1.width / 200));
      for (let y = 0; y < sampleHeight; y++) {
        const row1 = ctx1.getImageData(0, y, c1.width, 1).data;
        const row2 = ctx2.getImageData(0, y, c2.width, 1).data;
        let same = 0, total = 0;
        for (let x = 0; x < row1.length; x += 4 * sampleStep) {
          total++;
          if (Math.abs(row1[x] - row2[x]) < 15 && Math.abs(row1[x + 1] - row2[x + 1]) < 15 && Math.abs(row1[x + 2] - row2[x + 2]) < 15) same++;
        }
        if (total > 0 && same / total > 0.85) {
          if (matchStart < 0) matchStart = y;
          matchEnd = y;
        } else if (matchStart >= 0) break;
      }
      if (matchStart === 0 && matchEnd > 15) return Math.round((matchEnd + 1) / scale);
    } catch {}
    return 0;
  }

  // ===========================================================================
  // 长截图模块 - 拼接与导出
  // ===========================================================================
  async function stitchAndExport(chunks, metrics, options, onProgress, copyMode) {
    if (!chunks.length) throw new Error('没有可拼接的截图分段');
    const firstCanvas = chunks[0].canvas;
    const scale = firstCanvas.width / metrics.viewportWidth;
    const stickyHeight = detectStickyHeaderHeight(chunks, scale);

    const finalWidthPx = firstCanvas.width;
    const finalHeightPx = Math.round(metrics.totalHeight * scale);
    const maxCanvasHeight = 28000;
    const maxCanvasPixels = 120000000;
    const maxPartHeightPx = Math.floor(Math.min(maxCanvasHeight, maxCanvasPixels / finalWidthPx));

    if (finalHeightPx <= maxPartHeightPx) {
      const canvas = document.createElement('canvas');
      canvas.width = finalWidthPx;
      canvas.height = finalHeightPx;
      drawChunksToCanvas(canvas.getContext('2d'), chunks, 0, metrics.totalHeight, scale, stickyHeight);
      const blob = await canvasToBlob(canvas);
      if (copyMode) {
        try {
          await copyImageToClipboard(blob);
          return { stickyHeight, copied: true };
        } catch (err) {
          throw new Error(`复制到剪贴板失败：${err.message}。请改用下载模式。`);
        }
      } else {
        downloadBlob(blob, makeScreenshotFilename('png'));
        return { stickyHeight };
      }
    }

    // 超长页面：分卷 zip
    await loadLibrary('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', 'JSZip', 'jszip');
    const JSZipLib = resolveLoadedLibrary('JSZip');
    if (!JSZipLib) throw new Error('JSZip 加载失败');

    const zip = new JSZipLib();
    const partHeightCss = Math.floor(maxPartHeightPx / scale);
    const partCount = Math.ceil(metrics.totalHeight / partHeightCss);

    for (let i = 0; i < partCount; i++) {
      const partStart = i * partHeightCss;
      const partEnd = Math.min(metrics.totalHeight, partStart + partHeightCss);
      const canvas = document.createElement('canvas');
      canvas.width = finalWidthPx;
      canvas.height = Math.round((partEnd - partStart) * scale);
      drawChunksToCanvas(canvas.getContext('2d'), chunks, partStart, partEnd, scale, stickyHeight);
      const blob = await canvasToBlob(canvas);
      zip.file(`screenshot-part-${String(i + 1).padStart(2, '0')}.png`, blob);
      onProgress(`拼接分卷：${i + 1}/${partCount}`);
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    if (copyMode) {
      throw new Error('页面过长需分卷，无法复制到剪贴板。请取消"复制到剪贴板"选项改用下载。');
    }
    downloadBlob(zipBlob, makeScreenshotFilename('zip'));
    return { stickyHeight };
  }

  function drawChunksToCanvas(ctx, chunks, partStartCss, partEndCss, scale, stickyHeight) {
    for (const chunk of chunks) {
      const sourceCanvas = chunk.canvas;
      const cropTopCss = chunk.cropTopCss || 0;
      const chunkStartCss = chunk.pos + cropTopCss;
      const chunkEndCss = chunk.pos + sourceCanvas.height / scale;
      const drawStartCss = Math.max(chunkStartCss, partStartCss);
      const drawEndCss = Math.min(chunkEndCss, partEndCss);
      if (drawEndCss <= drawStartCss) continue;

      let sy = Math.round((drawStartCss - chunk.pos) * scale);
      let sh = Math.round((drawEndCss - drawStartCss) * scale);

      // 跳过吸顶栏（仅非首段）
      if (stickyHeight > 0 && chunk.pos > 0 && drawStartCss < chunk.pos + stickyHeight) {
        const skipPx = Math.round(stickyHeight * scale);
        if (sy < skipPx) {
          const diff = skipPx - sy;
          sy = skipPx;
          sh -= diff;
          if (sh <= 0) continue;
        }
      }

      const dy = Math.round((drawStartCss - partStartCss) * scale);
      ctx.drawImage(sourceCanvas, 0, sy, sourceCanvas.width, sh, 0, dy, sourceCanvas.width, sh);
    }
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('canvas 导出失败，可能是跨域图片污染或尺寸过大'));
      }, 'image/png');
    });
  }

  function makeScreenshotFilename(ext) {
    const time = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const title = sanitizeFilename(document.title || 'page');
    return `${title}-${time}.${ext}`;
  }

  // ===========================================================================
  // 长截图模块 - 主流程
  // ===========================================================================
  function setFabVisible(visible) {
    const btn = document.getElementById(BUTTON_ID);
    if (btn) btn.style.visibility = visible ? '' : 'hidden';
  }

  async function captureLongScreenshot(onProgress, onStatus, copyMode) {
    if (isCapturing) return;
    isCapturing = true;
    const options = getScreenshotOptions();
    const target = getScrollTarget();
    const originalState = saveScrollState(target);
    setFabVisible(false);

    try {
      onStatus('准备截图...');
      await wait(300);

      const metrics = getMetrics(target);
      const positions = buildScrollPositions(metrics.totalHeight, metrics.viewportHeight, options.overlap);
      if (positions.length === 0) throw new Error('没有可截图内容');

      onStatus(`目标：${describeTarget(target)}，共 ${positions.length} 段（${options.engine === 'screen' ? '真实捕获' : 'DOM 渲染'}）`);
      if (options.preload) {
        onStatus('预加载懒加载内容...');
        await preloadByScrolling(target, positions, options.delay);
      }

      let chunks = null;
      if (options.engine === 'screen') {
        onStatus('请求屏幕共享（请选择「此标签页」）...');
        chunks = await captureWithDisplayMedia(target, options, metrics, onProgress);
        if (!chunks) {
          onStatus('真实截图不可用，回退到 DOM 渲染...');
          chunks = await captureWithHtml2Canvas(target, options, metrics, onProgress);
        }
      } else {
        try {
          chunks = await captureWithHtml2Canvas(target, options, metrics, onProgress);
        } catch (domErr) {
          console.warn('[工具箱] DOM 截图失败，尝试真实捕获:', domErr);
          onStatus(`DOM 渲染失败（${domErr?.message || domErr}），改用真实捕获…`);
          chunks = await captureWithDisplayMedia(target, options, metrics, onProgress);
          if (!chunks) throw domErr;
        }
      }

      restoreScrollState(target, originalState);
      onStatus('正在拼接图片...');
      const result = await stitchAndExport(chunks, metrics, options, onProgress, copyMode);
      if (result.copied) {
        onStatus(result.stickyHeight > 0
          ? `已复制到剪贴板。自动检测到 ${result.stickyHeight}px 吸顶栏并已裁剪。`
          : '已复制到剪贴板。');
      } else {
        onStatus(result.stickyHeight > 0
          ? `完成。自动检测到 ${result.stickyHeight}px 吸顶栏并已裁剪。`
          : '完成。');
      }
    } catch (err) {
      console.error(err);
      restoreScrollState(target, originalState);
      onStatus(`截图失败：${err?.message || err}`);
    } finally {
      setFabVisible(true);
      isCapturing = false;
    }
  }

  function getScreenshotOptions() {
    const get = id => {
      const node = document.getElementById(id);
      return node ? Number(node.value) : NaN;
    };
    const clamp = (v, min, max, fb) => Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fb;
    const engineRadio = document.querySelector('input[name="wt-engine"]:checked');
    const engine = engineRadio ? engineRadio.value : getScreenshotEngine();
    if (engineRadio) setScreenshotEngine(engine);
    const preloadEl = document.getElementById('wt-preload');
    const preload = preloadEl ? !!preloadEl.checked : false;
    return {
      delay: clamp(get('wt-delay'), 100, 5000, 350),
      overlap: clamp(get('wt-overlap'), 0, 1000, 80),
      scale: clamp(get('wt-scale'), 0.5, 3, 1),
      engine: engine === 'screen' ? 'screen' : 'dom',
      preload
    };
  }

  // ===========================================================================
  // 长截图模块 - 区域选择
  // ===========================================================================
  let isPicking = false;
  let pickOverlay = null;

  function ensurePickOverlay() {
    if (pickOverlay) return;
    pickOverlay = el('div', { id: 'wt-pick-overlay' });
    document.body.appendChild(pickOverlay);
  }

  function startPicking(onStatus) {
    ensurePickOverlay();
    isPicking = true;
    pickOverlay.style.display = 'block';
    onStatus('选择模式：点击文档滚动区域。按 Esc 取消。');

    const moveHandler = (e) => {
      if (!isPicking) return;
      e.preventDefault(); e.stopPropagation();
      const candidate = findScrollableAncestor(e.target) || e.target;
      const rect = candidate.getBoundingClientRect();
      pickOverlay.style.left = `${rect.left}px`;
      pickOverlay.style.top = `${rect.top}px`;
      pickOverlay.style.width = `${rect.width}px`;
      pickOverlay.style.height = `${rect.height}px`;
    };
    const clickHandler = (e) => {
      if (!isPicking) return;
      e.preventDefault(); e.stopPropagation();
      const scrollable = findScrollableAncestor(e.target);
      if (scrollable) {
        selectedScrollElement = scrollable;
        onStatus(`已选择：${describeTarget({ type: 'element', el: scrollable })}`);
      } else {
        selectedScrollElement = null;
        onStatus('未找到可滚动容器，将使用自动识别');
      }
      stopPicking(moveHandler, clickHandler);
    };
    const keyHandler = (e) => {
      if (e.key === 'Escape' && isPicking) {
        stopPicking(moveHandler, clickHandler);
        onStatus('已取消选择');
      }
    };
    document.addEventListener('mousemove', moveHandler, true);
    document.addEventListener('click', clickHandler, true);
    document.addEventListener('keydown', keyHandler, true);
  }

  function stopPicking(moveHandler, clickHandler) {
    isPicking = false;
    pickOverlay.style.display = 'none';
    document.removeEventListener('mousemove', moveHandler, true);
    document.removeEventListener('click', clickHandler, true);
  }

  // ===========================================================================
  // UI 模块 - 样式
  // ===========================================================================
  function ensureStyles() {
    if (document.getElementById(APP_ID)) return;
    const style = document.createElement('style');
    style.id = APP_ID;
    style.textContent = `
      #${BUTTON_ID} {
        position: fixed; left: auto; top: auto; right: 18px; bottom: 86px;
        z-index: 2147483000;
        width: 48px; height: 48px; border: 0; border-radius: 50%;
        background: #111827; color: #fff; font-size: 22px; line-height: 48px;
        text-align: center; cursor: grab; user-select: none;
        box-shadow: 0 4px 16px rgba(0,0,0,.3);
        transition: filter .15s, width .15s, height .15s, border-radius .15s, opacity .15s;
        font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        padding: 0; touch-action: none;
      }
      #${BUTTON_ID}:hover { filter: brightness(1.2); }
      #${BUTTON_ID}.wt-dragging { cursor: grabbing; transition: none; }
      #${BUTTON_ID}.wt-collapsed {
        width: 12px; height: 48px; border-radius: 8px 0 0 8px;
        font-size: 0; line-height: 0; opacity: .55;
        box-shadow: 0 2px 8px rgba(0,0,0,.25);
      }
      #${BUTTON_ID}.wt-collapsed.wt-edge-left {
        border-radius: 0 8px 8px 0; opacity: .55;
      }
      #${BUTTON_ID}.wt-collapsed:hover { opacity: .9; }
      #${PANEL_ID} {
        position: fixed; inset: 0; z-index: 2147483647; display: flex;
        align-items: center; justify-content: center; padding: 24px;
        background: rgba(0,0,0,.5);
        font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      }
      #${PANEL_ID} .wt-card {
        width: min(680px, 96vw); max-height: min(760px, 90vh); overflow: auto;
        box-sizing: border-box; border-radius: 14px; padding: 20px;
        background: #fff; color: #111827;
        box-shadow: 0 18px 60px rgba(0,0,0,.35);
      }
      #${PANEL_ID} .wt-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
      #${PANEL_ID} .wt-title { margin:0; font-size:18px; font-weight:700; }
      #${PANEL_ID} .wt-close { border:0; background:transparent; font-size:24px; cursor:pointer; color:#4b5563; padding:0 4px; }
      #${PANEL_ID} .wt-section { margin-top:16px; }
      #${PANEL_ID} .wt-section-title { font-size:14px; font-weight:600; margin:0 0 8px; color:#374151; }
      #${PANEL_ID} .wt-menu { display:grid; gap:8px; }
      #${PANEL_ID} .wt-menu-btn {
        display:flex; align-items:center; gap:10px; padding:12px 14px;
        border:1px solid #e5e7eb; border-radius:10px; background:#fff;
        cursor:pointer; font:inherit; text-align:left; transition: border-color .15s,background .15s;
      }
      #${PANEL_ID} .wt-menu-btn:hover { border-color:#2563eb; background:#f9fafb; }
      #${PANEL_ID} .wt-menu-btn .wt-icon { font-size:20px; flex:0 0 auto; }
      #${PANEL_ID} .wt-menu-btn .wt-info { flex:1; min-width:0; }
      #${PANEL_ID} .wt-menu-btn .wt-name { font-weight:600; }
      #${PANEL_ID} .wt-menu-btn .wt-desc { font-size:12px; color:#6b7280; margin-top:2px; }
      #${PANEL_ID} .wt-menu-btn:disabled { opacity:.5; cursor:not-allowed; }
      #${PANEL_ID} .wt-group { margin-top:14px; padding:12px; border:1px solid #e5e7eb; border-radius:12px; }
      #${PANEL_ID} .wt-group-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; }
      #${PANEL_ID} .wt-group-title { font-weight:600; font-size:14px; display:flex; align-items:center; gap:6px; }
      #${PANEL_ID} .wt-group-extra { display:flex; align-items:center; gap:6px; font-size:13px; }
      #${PANEL_ID} .wt-quick-row { display:flex; flex-wrap:wrap; gap:6px; }
      #${PANEL_ID} .wt-quick-btn { flex:1 1 auto; min-width:70px; padding:8px 10px; border:1px solid #d1d5db; border-radius:8px; background:#fff; cursor:pointer; font:inherit; font-size:13px; text-align:center; transition: border-color .15s,background .15s; }
      #${PANEL_ID} .wt-quick-btn:hover { border-color:#2563eb; background:#f0f5ff; }
      #${PANEL_ID} .wt-quick-btn:disabled { opacity:.5; cursor:wait; }
      #${PANEL_ID} .wt-quick-btn.primary { border-color:#2563eb; background:#2563eb; color:#fff; }
      #${PANEL_ID} .wt-quick-btn.primary:hover { background:#1d4ed8; }
      #${PANEL_ID} .wt-more-btn { margin-top:8px; padding:4px 10px; border:0; background:transparent; color:#6b7280; cursor:pointer; font:inherit; font-size:12px; text-decoration:underline; }
      #${PANEL_ID} .wt-more-btn:hover { color:#2563eb; }
      #${PANEL_ID} .wt-back { padding:6px 12px; border:1px solid #d1d5db; border-radius:8px; background:#f9fafb; cursor:pointer; font:inherit; }
      #${PANEL_ID} .wt-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:14px 0; }
      #${PANEL_ID} select { padding:7px 9px; border:1px solid #d1d5db; border-radius:8px; font:inherit; }
      #${PANEL_ID} .wt-opts { display:flex; flex-wrap:wrap; gap:12px; margin:10px 0; }
      #${PANEL_ID} .wt-opt { display:flex; align-items:center; gap:6px; font-size:13px; }
      #${PANEL_ID} .wt-opt input { width:60px; padding:4px 6px; border:1px solid #d1d5db; border-radius:6px; font:inherit; }
      #${PANEL_ID} .wt-status { margin:10px 0; color:#4b5563; font-size:13px; white-space:pre-wrap; }
      #${PANEL_ID} .wt-status.error { color:#b91c1c; }
      #${PANEL_ID} .wt-status.success { color:#15803d; }
      #${PANEL_ID} .wt-list { display:grid; gap:9px; }
      #${PANEL_ID} .wt-track { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:11px 12px; border:1px solid #e5e7eb; border-radius:10px; }
      #${PANEL_ID} .wt-track-name { font-weight:600; overflow-wrap:anywhere; }
      #${PANEL_ID} .wt-track-meta { margin-top:3px; color:#6b7280; font-size:12px; }
      #${PANEL_ID} .wt-download { flex:0 0 auto; padding:8px 14px; border:0; border-radius:8px; background:#2563eb; color:white; cursor:pointer; font:inherit; }
      #${PANEL_ID} .wt-download:disabled { opacity:.55; cursor:wait; }
      #${PANEL_ID} .wt-copy { flex:0 0 auto; padding:8px 14px; border:1px solid #2563eb; border-radius:8px; background:#fff; color:#2563eb; cursor:pointer; font:inherit; }
      #${PANEL_ID} .wt-copy:disabled { opacity:.55; cursor:wait; }
      #${PANEL_ID} .wt-note { margin-top:14px; color:#6b7280; font-size:12px; line-height:1.55; }
      #${PANEL_ID} .wt-collapse { margin-top:14px; border:1px solid #e5e7eb; border-radius:10px; overflow:hidden; }
      #${PANEL_ID} .wt-collapse-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:11px 14px; cursor:pointer; background:#f9fafb; font:inherit; font-weight:600; border:0; width:100%; text-align:left; }
      #${PANEL_ID} .wt-collapse-head:hover { background:#f3f4f6; }
      #${PANEL_ID} .wt-collapse-body { padding:12px 14px; display:none; }
      #${PANEL_ID} .wt-collapse.open .wt-collapse-body { display:block; }
      #${PANEL_ID} .wt-collapse-arrow { font-size:12px; transition:transform .2s; }
      #${PANEL_ID} .wt-collapse.open .wt-collapse-arrow { transform:rotate(90deg); }
      #${PANEL_ID} .wt-desc-text { white-space:pre-wrap; word-break:break-word; font-size:13px; line-height:1.6; max-height:300px; overflow:auto; padding:10px; background:#f9fafb; border-radius:8px; }
      #${PANEL_ID} .wt-comment { padding:10px 0; border-bottom:1px solid #f3f4f6; }
      #${PANEL_ID} .wt-comment:last-child { border-bottom:0; }
      #${PANEL_ID} .wt-comment-head { display:flex; align-items:center; gap:8px; font-size:13px; }
      #${PANEL_ID} .wt-comment-author { font-weight:600; }
      #${PANEL_ID} .wt-comment-badge { font-size:11px; padding:1px 6px; border-radius:4px; background:#fbbf24; color:#fff; }
      #${PANEL_ID} .wt-comment-time { color:#9ca3af; font-size:12px; }
      #${PANEL_ID} .wt-comment-likes { color:#6b7280; font-size:12px; }
      #${PANEL_ID} .wt-comment-text { margin-top:4px; font-size:13px; line-height:1.55; white-space:pre-wrap; word-break:break-word; }
      #${PANEL_ID} .wt-comment-replies { margin-top:4px; color:#9ca3af; font-size:12px; }
      #${PANEL_ID} .wt-load-more { width:100%; padding:10px; border:1px dashed #d1d5db; border-radius:8px; background:transparent; cursor:pointer; font:inherit; color:#6b7280; margin-top:10px; }
      #${PANEL_ID} .wt-load-more:hover { border-color:#2563eb; color:#2563eb; }
      #wt-pick-overlay {
        position: fixed; z-index: 2147483646; pointer-events: none;
        border: 2px solid #00e0ff; background: rgba(0,224,255,.1);
        display: none; box-sizing: border-box;
      }
      @media (prefers-color-scheme: dark) {
        #${PANEL_ID} .wt-card { background:#18181b; color:#f4f4f5; }
        #${PANEL_ID} .wt-close, #${PANEL_ID} .wt-status, #${PANEL_ID} .wt-track-meta, #${PANEL_ID} .wt-note, #${PANEL_ID} .wt-section-title { color:#a1a1aa; }
        #${PANEL_ID} .wt-track { border-color:#3f3f46; }
        #${PANEL_ID} select, #${PANEL_ID} .wt-opt input, #${PANEL_ID} .wt-back { color:#f4f4f5; background:#27272a; border-color:#52525b; }
        #${PANEL_ID} .wt-menu-btn { background:#27272a; border-color:#3f3f46; color:#f4f4f5; }
        #${PANEL_ID} .wt-menu-btn:hover { background:#33333a; border-color:#2563eb; }
        #${PANEL_ID} .wt-copy { background:#27272a; color:#60a5fa; border-color:#2563eb; }
        #${PANEL_ID} .wt-collapse { border-color:#3f3f46; }
        #${PANEL_ID} .wt-collapse-head { background:#27272a; color:#f4f4f5; }
        #${PANEL_ID} .wt-collapse-head:hover { background:#33333a; }
        #${PANEL_ID} .wt-desc-text { background:#27272a; color:#e5e7eb; }
        #${PANEL_ID} .wt-comment { border-bottom-color:#3f3f46; }
        #${PANEL_ID} .wt-comment-time, #${PANEL_ID} .wt-comment-likes, #${PANEL_ID} .wt-comment-replies { color:#a1a1aa; }
        #${PANEL_ID} .wt-load-more { border-color:#52525b; color:#a1a1aa; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ===========================================================================
  // UI 模块 - 主按钮（可拖拽 / 贴边收起）
  // ===========================================================================
  function readFabPos() {
    try {
      const raw = lsGet(LS_FAB_POS);
      if (!raw) return null;
      const pos = JSON.parse(raw);
      if (typeof pos?.left === 'number' && typeof pos?.top === 'number') return pos;
    } catch {}
    return null;
  }

  function clampFabPos(left, top, size) {
    const w = size || 48;
    const h = size || 48;
    const maxL = Math.max(0, innerWidth - w);
    const maxT = Math.max(0, innerHeight - h);
    return {
      left: Math.max(0, Math.min(maxL, left)),
      top: Math.max(0, Math.min(maxT, top))
    };
  }

  function applyFabPosition(button, left, top) {
    const collapsed = button.classList.contains('wt-collapsed');
    const sizeW = collapsed ? 12 : 48;
    const sizeH = collapsed ? 48 : 48;
    const pos = clampFabPos(left, top, Math.max(sizeW, sizeH));
    button.style.right = 'auto';
    button.style.bottom = 'auto';
    button.style.left = `${pos.left}px`;
    button.style.top = `${pos.top}px`;
    return pos;
  }

  function snapFabToNearestEdge(button) {
    const rect = button.getBoundingClientRect();
    const collapsed = button.classList.contains('wt-collapsed');
    const w = collapsed ? 12 : 48;
    const h = 48;
    const cx = rect.left + rect.width / 2;
    const distLeft = cx;
    const distRight = innerWidth - cx;
    const distTop = rect.top;
    const distBottom = innerHeight - rect.bottom;
    const min = Math.min(distLeft, distRight, distTop, distBottom);
    let left = rect.left;
    let top = rect.top;
    button.classList.remove('wt-edge-left');
    if (min === distLeft) {
      left = 0;
      button.classList.add('wt-edge-left');
    } else if (min === distRight) {
      left = innerWidth - w;
    } else if (min === distTop) {
      top = 0;
      left = distLeft <= distRight ? 0 : innerWidth - w;
      if (left === 0) button.classList.add('wt-edge-left');
    } else {
      top = innerHeight - h;
      left = distLeft <= distRight ? 0 : innerWidth - w;
      if (left === 0) button.classList.add('wt-edge-left');
    }
    const pos = applyFabPosition(button, left, top);
    lsSet(LS_FAB_POS, JSON.stringify(pos));
  }

  function setFabCollapsed(button, collapsed) {
    if (collapsed) {
      button.classList.add('wt-collapsed');
      button.title = '网页工具箱（点击展开，拖动可移动）';
      button.textContent = '';
      snapFabToNearestEdge(button);
      lsSet(LS_FAB_COLLAPSED, '1');
    } else {
      button.classList.remove('wt-collapsed', 'wt-edge-left');
      button.title = '网页工具箱（拖动移动，双击收起）';
      button.textContent = '🛠';
      const pos = readFabPos();
      if (pos) applyFabPosition(button, pos.left, pos.top);
      else {
        button.style.left = 'auto';
        button.style.top = 'auto';
        button.style.right = '18px';
        button.style.bottom = '86px';
      }
      lsSet(LS_FAB_COLLAPSED, '0');
    }
  }

  function bindFabInteractions(button) {
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, origLeft = 0, origTop = 0;
    let suppressClick = false;

    const onPointerDown = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const rect = button.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      button.classList.add('wt-dragging');
      button.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < FAB_DRAG_THRESHOLD) return;
      moved = true;
      suppressClick = true;
      applyFabPosition(button, origLeft + dx, origTop + dy);
    };

    const onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      button.classList.remove('wt-dragging');
      try { button.releasePointerCapture?.(e.pointerId); } catch {}
      if (moved) {
        const rect = button.getBoundingClientRect();
        const pos = applyFabPosition(button, rect.left, rect.top);
        lsSet(LS_FAB_POS, JSON.stringify(pos));
        if (button.classList.contains('wt-collapsed')) snapFabToNearestEdge(button);
        setTimeout(() => { suppressClick = false; }, 0);
      } else {
        suppressClick = false;
      }
    };

    button.addEventListener('pointerdown', onPointerDown);
    button.addEventListener('pointermove', onPointerMove);
    button.addEventListener('pointerup', onPointerUp);
    button.addEventListener('pointercancel', onPointerUp);

    let clickTimer = null;
    button.addEventListener('click', (e) => {
      if (suppressClick || moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
        return;
      }
      if (button.classList.contains('wt-collapsed')) {
        e.preventDefault();
        e.stopPropagation();
        setFabCollapsed(button, false);
        return;
      }
      // 延迟打开，避免双击收起时第一次 click 误开面板
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => openToolbox(), 220);
    });

    button.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(clickTimer);
      if (!button.classList.contains('wt-collapsed')) setFabCollapsed(button, true);
    });

    window.addEventListener('resize', () => {
      if (!document.getElementById(BUTTON_ID)) return;
      const pos = readFabPos();
      if (pos) applyFabPosition(button, pos.left, pos.top);
      if (button.classList.contains('wt-collapsed')) snapFabToNearestEdge(button);
    });
  }

  function ensureButton() {
    if (!document.body || document.getElementById(BUTTON_ID)) return;
    ensureStyles();
    const button = el('button', {
      id: BUTTON_ID, type: 'button', text: '🛠',
      title: '网页工具箱（拖动移动，双击收起）'
    });
    document.body.appendChild(button);

    const pos = readFabPos();
    if (pos) applyFabPosition(button, pos.left, pos.top);

    bindFabInteractions(button);

    if (lsGet(LS_FAB_COLLAPSED) === '1') setFabCollapsed(button, true);
  }

  // ===========================================================================
  // UI 模块 - 工具箱主面板
  // ===========================================================================
  // 快捷操作辅助函数
  // ===========================================================================
  function quickBtn(label, onclick, opts = {}) {
    return el('button', {
      class: 'wt-quick-btn' + (opts.primary ? ' primary' : ''),
      type: 'button', text: label,
      onclick: async event => {
        const btn = event.currentTarget;
        const oldText = btn.textContent;
        btn.disabled = true; btn.textContent = '…';
        try { await onclick(btn); }
        catch (err) { console.error('[工具箱]', err); }
        finally { btn.disabled = false; btn.textContent = oldText; }
      }
    });
  }

  function moreBtn(label, onclick) {
    return el('button', { class: 'wt-more-btn', type: 'button', text: label, onclick });
  }

  function setStatus(status, text, type = '') {
    status.className = 'wt-status' + (type ? ' ' + type : '');
    status.textContent = text;
  }

  // 快捷：下载第一条字幕（SRT）
  async function quickDownloadSubtitle(status) {
    try {
      setStatus(status, '正在读取字幕轨道…');
      const tracks = await loadTracks(true);
      if (!tracks.length) throw new Error('未发现字幕轨道。可能是该视频没有字幕，或页面尚未加载完成。');
      const track = tracks.find(t => !t.auto) || tracks[0];
      setStatus(status, `正在下载字幕：${track.label}`);
      await downloadTrack(track, 'srt');
      setStatus(status, `已下载：${buildFilename(track, 'srt')}`, 'success');
    } catch (err) { setStatus(status, err?.message || String(err), 'error'); throw err; }
  }

  // 快捷：复制视频简介
  async function quickCopyDescription(status) {
    try {
      const info = getVideoInfo();
      if (!info) throw new Error('无法获取视频信息，请确认页面已完成加载。');
      const text = formatVideoInfoText(info);
      const ok = await copyTextToClipboard(text);
      if (!ok) throw new Error('复制失败，可能是浏览器权限不足');
      setStatus(status, `已复制视频简介到剪贴板（${text.length} 字符）`, 'success');
    } catch (err) { setStatus(status, err?.message || String(err), 'error'); throw err; }
  }

  // 快捷：加载并复制评论
  async function quickCopyComments(status) {
    try {
      setStatus(status, '正在加载评论…');
      const result = await getCommentsFirstPage();
      if (!result.comments.length) throw new Error('未获取到评论');
      const info = getVideoInfo();
      const text = commentsToText(result.comments, info?.title);
      const ok = await copyTextToClipboard(text);
      if (!ok) throw new Error('复制失败，可能是浏览器权限不足');
      setStatus(status, `已复制 ${result.comments.length} 条评论到剪贴板`, 'success');
    } catch (err) { setStatus(status, err?.message || String(err), 'error'); throw err; }
  }

  // 快捷：一键复制全部（简介 + 字幕 + 评论）
  async function quickCopyAll(status) {
    try {
      const parts = [];
      const info = getVideoInfo();

      // 1. 视频简介
      setStatus(status, '正在获取视频简介…');
      if (info) {
        parts.push('========== 视频简介 ==========');
        parts.push(formatVideoInfoText(info));
        parts.push('');
      }

      // 2. 字幕（SRT 格式，选第一条非自动生成的，否则第一条）
      setStatus(status, '正在获取字幕…');
      try {
        const tracks = await loadTracks(true);
        if (tracks.length) {
          const track = tracks.find(t => !t.auto) || tracks[0];
          const { raw, cues } = await fetchTrackContent(track);
          const srtText = formatTrackText(raw, cues, 'srt');
          parts.push('========== 字幕（SRT）==========');
          parts.push(`# 语言：${track.label}`);
          parts.push(srtText);
          parts.push('');
        } else {
          parts.push('========== 字幕 ==========');
          parts.push('(未发现字幕轨道)');
          parts.push('');
        }
      } catch (err) {
        parts.push('========== 字幕 ==========');
        parts.push(`(字幕获取失败：${err?.message || err})`);
        parts.push('');
      }

      // 3. 评论（首页）
      setStatus(status, '正在获取评论…');
      try {
        const result = await getCommentsFirstPage();
        if (result.comments.length) {
          parts.push('========== 评论 ==========');
          parts.push(commentsToText(result.comments, info?.title));
        } else {
          parts.push('========== 评论 ==========');
          parts.push('(未获取到评论)');
        }
      } catch (err) {
        parts.push('========== 评论 ==========');
        parts.push(`(评论获取失败：${err?.message || err})`);
      }

      // 合并并复制
      setStatus(status, '正在复制到剪贴板…');
      const fullText = parts.join('\n');
      const ok = await copyTextToClipboard(fullText);
      if (!ok) throw new Error('复制失败，可能是浏览器权限不足');
      const charCount = fullText.length;
      setStatus(status, `已复制全部内容到剪贴板（${charCount} 字符，含简介+字幕+评论）`, 'success');
    } catch (err) { setStatus(status, err?.message || String(err), 'error'); throw err; }
  }

  // 快捷：长截图（默认参数）
  async function quickScreenshot(status, copyMode) {
    closeToolbox();
    let lastStatus = '';
    await captureLongScreenshot(
      progress => {},
      s => { lastStatus = s; },
      copyMode
    );
    openToolbox();
    const ns = document.querySelector(`#${PANEL_ID} .wt-status`);
    if (ns) { ns.className = 'wt-status' + (lastStatus.includes('失败') ? ' error' : ' success'); ns.textContent = lastStatus || '完成。'; }
  }

  function openToolbox() {
    closeToolbox();
    ensureStyles();

    const status = el('div', { class: 'wt-status' });
    const groups = [];

    // === 视频文字源 ===
    if (hasSubtitleFeature()) {
      const btns = [
        quickBtn('一键复制全部', () => quickCopyAll(status), { primary: true }),
        quickBtn('下载字幕', () => quickDownloadSubtitle(status)),
        quickBtn('复制简介', () => quickCopyDescription(status)),
        quickBtn('复制评论', () => quickCopyComments(status)),
      ];
      groups.push(el('div', { class: 'wt-group' }, [
        el('div', { class: 'wt-group-head' }, [
          el('span', { class: 'wt-group-title', text: '📺 视频文字源' })
        ]),
        el('div', { class: 'wt-quick-row' }, btns),
        moreBtn('更多选项（字幕格式选择/简介详情/评论翻页）→', () => openVideoTextPanel(status)),
      ]));
    }

    // === 视频下载 ===
    if (isYouTube() || isBilibili()) {
      const qualitySelect = el('select', { 'aria-label': '画质' }, isBilibili()
        ? [el('option', { value: '480P', text: '480P' }), el('option', { value: '720P', text: '720P' }), el('option', { value: '1080P', text: '1080P' })]
        : [el('option', { value: '480p', text: '480P' }), el('option', { value: '720p', text: '720P' }), el('option', { value: '1080p', text: '1080P' }), el('option', { value: 'best', text: '最高画质' })]
      );

      const dlBtns = isBilibili()
        ? [
            quickBtn('下载视频', async () => {
              try { await downloadBiliVideo(status, qualitySelect.value); }
              catch (err) { setStatus(status, err?.message || String(err), 'error'); throw err; }
            }, { primary: true }),
            quickBtn('下载音频', async () => {
              try { await downloadBiliAudio(status); }
              catch (err) { setStatus(status, err?.message || String(err), 'error'); throw err; }
            }),
            quickBtn('黑屏mp4', async () => {
              try { await downloadBiliBlackScreen(status); }
              catch (err) { setStatus(status, err?.message || String(err), 'error'); throw err; }
            }),
          ]
        : [
            quickBtn('下载视频', async () => {
              try { await downloadYtVideo(status, qualitySelect.value); }
              catch (err) { setStatus(status, err?.message || String(err), 'error'); throw err; }
            }, { primary: true }),
            quickBtn('下载音频', async () => {
              try { await downloadYtAudio(status); }
              catch (err) { setStatus(status, err?.message || String(err), 'error'); throw err; }
            }),
            quickBtn('黑屏mp4', async () => {
              try { await downloadYtBlackScreen(status); }
              catch (err) { setStatus(status, err?.message || String(err), 'error'); throw err; }
            }),
          ];

      groups.push(el('div', { class: 'wt-group' }, [
        el('div', { class: 'wt-group-head' }, [
          el('span', { class: 'wt-group-title', text: '⬇ 视频下载' }),
          el('div', { class: 'wt-group-extra' }, [el('span', { text: '画质' }), qualitySelect]),
        ]),
        el('div', { class: 'wt-quick-row' }, dlBtns),
        moreBtn(isYouTube() ? '更多选项（后端状态/详情）→' : '更多选项（详情）→', () => openDownloadPanel(status)),
      ]));
    }

    // === 长截图 ===
    groups.push(el('div', { class: 'wt-group' }, [
      el('div', { class: 'wt-group-head' }, [
        el('span', { class: 'wt-group-title', text: '📸 长截图' })
      ]),
      el('div', { class: 'wt-quick-row' }, [
        quickBtn('开始截图', () => quickScreenshot(status, false), { primary: true }),
        quickBtn('复制截图', () => quickScreenshot(status, true)),
      ]),
      moreBtn('更多选项（手动选区/参数调整）→', () => openScreenshotPanel(status)),
    ]));

    const panel = el('div', {
      id: PANEL_ID,
      onclick: e => { if (e.target === panel) closeToolbox(); }
    }, [
      el('div', { class: 'wt-card' }, [
        el('div', { class: 'wt-head' }, [
          el('h2', { class: 'wt-title', text: '网页工具箱' }),
          el('button', { class: 'wt-close', type: 'button', text: '×', onclick: closeToolbox })
        ]),
        ...groups,
        status,
        el('div', { class: 'wt-note', text: `当前页面：${location.hostname}` })
      ])
    ]);
    document.body.appendChild(panel);
  }

  function closeToolbox() {
    document.getElementById(PANEL_ID)?.remove();
  }

  // ===========================================================================
  // UI 模块 - 视频文字源子面板（简介 + 字幕 + 评论）
  // ===========================================================================
  function makeCollapsible(title, icon, defaultOpen, bodyContent) {
    const body = el('div', { class: 'wt-collapse-body' }, bodyContent);
    const head = el('button', {
      class: 'wt-collapse-head', type: 'button',
      onclick: () => collapse.classList.toggle('open')
    }, [
      el('span', {}, [el('span', { text: icon + ' ' }), el('span', { text: title })]),
      el('span', { class: 'wt-collapse-arrow', text: '▶' })
    ]);
    const collapse = el('div', { class: 'wt-collapse' + (defaultOpen ? ' open' : '') }, [head, body]);
    return { collapse, head, body };
  }

  function openVideoTextPanel(status) {
    const card = document.querySelector(`#${PANEL_ID} .wt-card`);
    if (!card) return;
    card.textContent = '';

    const videoInfo = getVideoInfo();

    card.appendChild(el('div', { class: 'wt-head' }, [
      el('button', { class: 'wt-back', type: 'button', text: '← 返回', onclick: openToolbox }),
      el('h2', { class: 'wt-title', text: '视频文字源' }),
      el('button', { class: 'wt-close', type: 'button', text: '×', onclick: closeToolbox })
    ]));
    card.appendChild(status);

    // === 区块1：视频简介 ===
    const descBody = [];
    if (videoInfo) {
      const descText = videoInfo.description || '(无简介)';
      const descEl = el('div', { class: 'wt-desc-text', text: descText });
      descBody.push(descEl);
      const metaParts = [];
      if (videoInfo.author) metaParts.push(`作者：${videoInfo.author}`);
      if (videoInfo.publishDate) metaParts.push(`发布：${videoInfo.publishDate}`);
      if (videoInfo.viewCount) metaParts.push(`播放：${videoInfo.viewCount}`);
      if (metaParts.length) descBody.push(el('div', { class: 'wt-track-meta', style: 'margin-top:8px;' }, [document.createTextNode(metaParts.join(' · '))]));
      descBody.push(el('div', { style: 'display:flex;gap:6px;margin-top:10px;' }, [
        el('button', {
          class: 'wt-copy', type: 'button', text: '复制简介',
          onclick: async event => {
            const btn = event.currentTarget;
            const oldText = btn.textContent;
            btn.disabled = true; btn.textContent = '处理中…';
            try {
              const infoText = formatVideoInfoText(videoInfo);
              const ok = await copyTextToClipboard(infoText);
              if (ok) { status.className = 'wt-status success'; status.textContent = '已复制视频简介到剪贴板'; }
              else throw new Error('复制失败');
            } catch (err) {
              status.className = 'wt-status error';
              status.textContent = err?.message || String(err);
            } finally {
              btn.disabled = false; btn.textContent = oldText;
            }
          }
        }),
        el('button', {
          class: 'wt-download', type: 'button', text: '下载简介',
          onclick: () => {
            const infoText = formatVideoInfoText(videoInfo);
            const filename = `${sanitizeFilename(videoInfo.title)}.简介.txt`;
            downloadText(filename, infoText);
            status.className = 'wt-status success';
            status.textContent = `已下载：${filename}`;
          }
        })
      ]));
    } else {
      descBody.push(el('div', { class: 'wt-note', text: '无法获取视频信息。请确认页面已完成加载。' }));
    }
    const descSection = makeCollapsible('视频简介', '📄', true, descBody);
    card.appendChild(descSection.collapse);

    // === 区块2：字幕轨道 ===
    const formatSelect = el('select', { 'aria-label': '字幕格式' }, [
      el('option', { value: 'srt', text: 'SRT' }),
      el('option', { value: 'vtt', text: 'WebVTT' }),
      el('option', { value: 'txt', text: 'TXT' }),
      el('option', { value: 'json', text: 'JSON' })
    ]);
    const trackList = el('div', { class: 'wt-list' });
    const subBody = [
      el('div', { class: 'wt-toolbar' }, [
        el('span', { text: '格式：' }), formatSelect,
        el('button', {
          class: 'wt-back', type: 'button', text: '重新读取',
          onclick: () => renderTrackList(trackList, status, formatSelect, true)
        })
      ]),
      trackList,
      el('div', {
        class: 'wt-note',
        text: isYouTube()
          ? 'YouTube 已启用 PoToken 验证，脚本会自动拦截播放器自身的字幕请求。如果失败，请先手动开启字幕（CC 按钮）再重试。'
          : 'B站字幕需要登录账号才能获取部分视频的字幕。'
      })
    ];
    const subSection = makeCollapsible('字幕轨道', '📝', true, subBody);
    card.appendChild(subSection.collapse);
    renderTrackList(trackList, status, formatSelect, false);

    // === 区块3：评论区 ===
    const commentList = el('div', {}, []);
    let commentState = { comments: [], nextToken: null, nextClickTracking: null, nextPage: null };
    const loadMoreBtn = el('button', {
      class: 'wt-load-more', type: 'button', text: '加载评论',
      onclick: async () => {
        loadMoreBtn.disabled = true;
        loadMoreBtn.textContent = '加载中…';
        status.className = 'wt-status';
        try {
          if (commentState.comments.length === 0) {
            const result = await getCommentsFirstPage();
            commentState.comments = result.comments;
            commentState.nextToken = result.nextToken;
            commentState.nextClickTracking = result.nextClickTracking;
            commentState.nextPage = result.nextPage;
          } else {
            const result = await getCommentsNextPage(commentState);
            if (!result) { loadMoreBtn.textContent = '没有更多评论了'; loadMoreBtn.disabled = true; return; }
            commentState.comments = commentState.comments.concat(result.comments);
            commentState.nextToken = result.nextToken;
            commentState.nextClickTracking = result.nextClickTracking;
            commentState.nextPage = result.nextPage;
          }
          renderCommentList(commentList, commentState.comments);
          status.className = 'wt-status success';
          status.textContent = `已加载 ${commentState.comments.length} 条评论`;
          if (isYouTube() ? commentState.nextToken : commentState.nextPage) {
            loadMoreBtn.textContent = '加载更多';
            loadMoreBtn.disabled = false;
          } else {
            loadMoreBtn.textContent = '没有更多评论了';
            loadMoreBtn.disabled = true;
          }
        } catch (err) {
          status.className = 'wt-status error';
          status.textContent = err?.message || String(err);
          loadMoreBtn.textContent = '重试';
          loadMoreBtn.disabled = false;
        }
      }
    });
    const commentToolbar = el('div', { style: 'display:flex;gap:6px;margin-top:10px;' }, [
      el('button', {
        class: 'wt-copy', type: 'button', text: '复制评论',
        onclick: async () => {
          if (commentState.comments.length === 0) { status.className = 'wt-status error'; status.textContent = '请先加载评论'; return; }
          const text = commentsToText(commentState.comments, videoInfo?.title);
          const ok = await copyTextToClipboard(text);
          if (ok) { status.className = 'wt-status success'; status.textContent = `已复制 ${commentState.comments.length} 条评论到剪贴板`; }
          else { status.className = 'wt-status error'; status.textContent = '复制失败'; }
        }
      }),
      el('button', {
        class: 'wt-download', type: 'button', text: '下载评论',
        onclick: () => {
          if (commentState.comments.length === 0) { status.className = 'wt-status error'; status.textContent = '请先加载评论'; return; }
          const text = commentsToText(commentState.comments, videoInfo?.title);
          const filename = `${sanitizeFilename(videoInfo?.title || 'video')}.评论.txt`;
          downloadText(filename, text);
          status.className = 'wt-status success';
          status.textContent = `已下载 ${commentState.comments.length} 条评论`;
        }
      })
    ]);
    const commentBody = [
      commentToolbar,
      commentList,
      loadMoreBtn,
      el('div', {
        class: 'wt-note',
        text: isYouTube()
          ? 'YouTube 评论通过 InnerTube API 获取。首次加载如失败，请先滚动到评论区让页面加载评论。'
          : 'B站评论通过 WBI 签名 API 获取，需登录状态。'
      })
    ];
    const commentSection = makeCollapsible('评论区', '💬', false, commentBody);
    card.appendChild(commentSection.collapse);
  }

  function formatVideoInfoText(info) {
    const lines = [];
    lines.push(`# ${info.title || '视频'}`);
    if (info.author) lines.push(`# 作者：${info.author}`);
    if (info.publishDate) lines.push(`# 发布日期：${info.publishDate}`);
    if (info.viewCount) lines.push(`# 播放量：${info.viewCount}`);
    if (info.site === 'youtube' && info.videoId) lines.push(`# YouTube ID：${info.videoId}`);
    if (info.site === 'bilibili' && info.bvid) lines.push(`# BVID：${info.bvid}`);
    lines.push('');
    lines.push(info.description || '(无简介)');
    return lines.join('\n');
  }

  function renderCommentList(container, comments) {
    container.textContent = '';
    if (!comments.length) {
      container.appendChild(el('div', { class: 'wt-note', text: '暂无评论。' }));
      return;
    }
    comments.forEach(c => {
      const headChildren = [
        el('span', { class: 'wt-comment-author', text: c.author || '匿名' })
      ];
      if (c.isCreator) headChildren.push(el('span', { class: 'wt-comment-badge', text: 'UP主' }));
      if (c.isPinned) headChildren.push(el('span', { class: 'wt-comment-badge', text: '置顶', style: 'background:#3b82f6;' }));
      if (c.publishedTime) headChildren.push(el('span', { class: 'wt-comment-time', text: c.publishedTime }));
      if (c.likes && c.likes !== '0') headChildren.push(el('span', { class: 'wt-comment-likes', text: `👍 ${c.likes}` }));
      const commentEl = el('div', { class: 'wt-comment' }, [
        el('div', { class: 'wt-comment-head' }, headChildren),
        el('div', { class: 'wt-comment-text', text: c.text })
      ]);
      if (c.replyCount > 0) {
        commentEl.appendChild(el('div', { class: 'wt-comment-replies', text: `└ ${c.replyCount} 条回复` }));
      }
      container.appendChild(commentEl);
    });
  }

  async function renderTrackList(container, status, formatSelect, force) {
    container.textContent = '';
    status.className = 'wt-status';
    status.textContent = '正在读取字幕轨道…';
    try {
      const tracks = await loadTracks(force);
      if (!tracks.length) {
        status.textContent = '未发现字幕轨道。可能是该视频没有内置字幕、页面尚未加载完成，或 B 站字幕需要登录。';
        return;
      }
      status.textContent = `发现 ${tracks.length} 条字幕轨道。`;
      tracks.forEach(track => {
        const metaParts = [track.language || 'und'];
        if (track.auto) metaParts.push('自动生成');
        metaParts.push(track.site === 'youtube' ? 'YouTube' : '哔哩哔哩');
        const downloadBtn = el('button', {
          class: 'wt-download', type: 'button', text: '下载',
          onclick: async event => {
            const btn = event.currentTarget;
            const oldText = btn.textContent;
            btn.disabled = true; btn.textContent = '处理中…';
            status.className = 'wt-status';
            status.textContent = `正在下载：${track.label}`;
            try {
              await downloadTrack(track, formatSelect.value);
              status.className = 'wt-status success';
              status.textContent = `已生成：${buildFilename(track, formatSelect.value)}`;
            } catch (error) {
              status.className = 'wt-status error';
              status.textContent = error?.message || String(error);
            } finally {
              btn.disabled = false; btn.textContent = oldText;
            }
          }
        });
        const copyBtn = el('button', {
          class: 'wt-copy', type: 'button', text: '复制',
          onclick: async event => {
            const btn = event.currentTarget;
            const oldText = btn.textContent;
            btn.disabled = true; btn.textContent = '处理中…';
            status.className = 'wt-status';
            status.textContent = `正在获取：${track.label}`;
            try {
              await copyTrack(track, formatSelect.value);
              status.className = 'wt-status success';
              status.textContent = `已复制到剪贴板：${track.label}（${formatSelect.value.toUpperCase()}）`;
            } catch (error) {
              status.className = 'wt-status error';
              status.textContent = error?.message || String(error);
            } finally {
              btn.disabled = false; btn.textContent = oldText;
            }
          }
        });
        container.appendChild(el('div', { class: 'wt-track' }, [
          el('div', {}, [
            el('div', { class: 'wt-track-name', text: track.label }),
            el('div', { class: 'wt-track-meta', text: metaParts.join(' · ') })
          ]),
          el('div', { style: 'display:flex;gap:6px;' }, [copyBtn, downloadBtn])
        ]));
      });
    } catch (error) {
      status.className = 'wt-status error';
      status.textContent = error?.message || String(error);
    }
  }

  // ===========================================================================
  // UI 模块 - 截图子面板
  // ===========================================================================
  // ===========================================================================
  // UI 模块 - 视频下载子面板
  // ===========================================================================
  function openDownloadPanel(status) {
    const card = document.querySelector(`#${PANEL_ID} .wt-card`);
    if (!card) return;
    card.textContent = '';

    card.appendChild(el('div', { class: 'wt-head' }, [
      el('button', { class: 'wt-back', type: 'button', text: '← 返回', onclick: openToolbox }),
      el('h2', { class: 'wt-title', text: '视频下载' }),
      el('button', { class: 'wt-close', type: 'button', text: '×', onclick: closeToolbox })
    ]));
    card.appendChild(status);

    if (isBilibili()) {
      // B站：画质选择 + 三个下载按钮
      const qualitySelect = el('select', { 'aria-label': '画质' }, [
        el('option', { value: '480P', text: '480P（默认）' }),
        el('option', { value: '720P', text: '720P' }),
        el('option', { value: '1080P', text: '1080P' }),
      ]);

      const makeDownloadBtn = (label, fn) => el('button', {
        class: 'wt-menu-btn', type: 'button',
        onclick: async event => {
          const btn = event.currentTarget;
          const oldText = btn.textContent;
          btn.disabled = true;
          status.className = 'wt-status';
          status.textContent = '准备中…';
          try {
            const filename = await fn(status, qualitySelect.value);
            status.className = 'wt-status success';
            status.textContent = `下载完成：${filename}`;
          } catch (err) {
            status.className = 'wt-status error';
            status.textContent = err?.message || String(err);
          } finally {
            btn.disabled = false;
            btn.textContent = oldText;
          }
        }
      }, [el('span', { text: label })]);

      card.appendChild(el('div', { class: 'wt-section' }, [
        el('p', { class: 'wt-section-title', text: '画质选择' }),
        qualitySelect,
      ]));
      card.appendChild(el('div', { class: 'wt-section' }, [
        el('p', { class: 'wt-section-title', text: '下载选项' }),
        makeDownloadBtn('下载视频（mp4）', downloadBiliVideo),
        makeDownloadBtn('下载音频（m4a）', downloadBiliAudio),
        makeDownloadBtn('黑屏音频 mp4', downloadBiliBlackScreen),
      ]));
      card.appendChild(el('div', {
        class: 'wt-note',
        text: 'B站视频通过 DASH 流下载并合并。首次合并需加载 mp4box.js（~1MB）。黑屏 mp4 需要 WebCodecs 支持（Chrome 94+）。'
      }));
    } else if (isYouTube()) {
      // YouTube：点下载时自动启动本地后端
      status.className = 'wt-status';
      status.textContent = '正在检测本地后端…';

      const qualitySelect = el('select', { 'aria-label': '画质' }, [
        el('option', { value: '480p', text: '480P' }),
        el('option', { value: '720p', text: '720P' }),
        el('option', { value: '1080p', text: '1080P' }),
        el('option', { value: 'best', text: '最高画质' }),
      ]);

      const btnContainer = el('div', { class: 'wt-section' }, [
        el('p', { class: 'wt-section-title', text: '下载选项（首次点击会自动启动后端）' }),
      ]);
      const noteEl = el('div', { class: 'wt-note' });

      card.appendChild(el('div', { class: 'wt-section' }, [
        el('p', { class: 'wt-section-title', text: '画质选择' }),
        qualitySelect,
      ]));
      card.appendChild(btnContainer);
      card.appendChild(noteEl);

      // 异步检测后端当前状态（仅显示，不阻塞按钮）
      checkYtServer().then(health => {
        if (health && health['yt-dlp']) {
          status.className = 'wt-status';
          status.textContent = `本地后端已运行（yt-dlp: ✓, ffmpeg: ${health.ffmpeg ? '✓' : '✗'}）`;
          noteEl.textContent = '后端运行中。下载完成后后端将自动关闭。';
        } else {
          status.className = 'wt-status';
          status.textContent = '本地后端未运行（点击下载时会自动启动）';
          noteEl.textContent = '首次点击下载时，浏览器会弹出"是否允许打开 yt-dlp-server?"确认框，请点击"允许"。后端将以最小化窗口运行，下载完成后自动关闭。';
        }
      });

      const makeBtn = (label, fn) => el('button', {
        class: 'wt-menu-btn', type: 'button',
        onclick: async event => {
          const btn = event.currentTarget;
          const oldText = btn.textContent;
          btn.disabled = true;
          status.className = 'wt-status';
          status.textContent = '准备中…';
          try {
            const filename = await fn(status, qualitySelect.value);
            status.className = 'wt-status success';
            status.textContent = `下载完成：${filename}`;
          } catch (err) {
            status.className = 'wt-status error';
            status.textContent = err?.message || String(err);
          } finally {
            btn.disabled = false;
            btn.textContent = oldText;
          }
        }
      }, [el('span', { text: label })]);

      btnContainer.appendChild(makeBtn('下载视频（mp4）', downloadYtVideo));
      btnContainer.appendChild(makeBtn('下载音频（mp3）', downloadYtAudio));
      btnContainer.appendChild(makeBtn('黑屏音频 mp4', downloadYtBlackScreen));
    }
  }

  function openScreenshotPanel(status) {
    const card = document.querySelector(`#${PANEL_ID} .wt-card`);
    if (!card) return;
    card.textContent = '';

    const target = getScrollTarget();
    const targetDesc = describeTarget(target);
    const savedEngine = getScreenshotEngine();

    const updateHint = () => {
      const eng = document.querySelector('input[name="wt-engine"]:checked')?.value || 'dom';
      setScreenshotEngine(eng);
      status.className = 'wt-status';
      status.textContent = eng === 'screen'
        ? '真实捕获需浏览器授权：请选择「共享此标签页」。拒绝或失败时会自动回退到 DOM 渲染。'
        : 'DOM 渲染模式无需屏幕共享授权，速度更快。复杂页面或跨域图片可改用真实捕获。';
    };

    const engineDom = el('input', {
      type: 'radio', name: 'wt-engine', value: 'dom', style: 'width:auto;',
      onchange: updateHint
    });
    const engineScreen = el('input', {
      type: 'radio', name: 'wt-engine', value: 'screen', style: 'width:auto;',
      onchange: updateHint
    });
    engineDom.checked = savedEngine !== 'screen';
    engineScreen.checked = savedEngine === 'screen';

    card.appendChild(el('div', { class: 'wt-head' }, [
      el('button', { class: 'wt-back', type: 'button', text: '← 返回', onclick: openToolbox }),
      el('h2', { class: 'wt-title', text: '长截图' }),
      el('button', { class: 'wt-close', type: 'button', text: '×', onclick: closeToolbox })
    ]));
    card.appendChild(el('div', { class: 'wt-section' }, [
      el('p', { class: 'wt-section-title', text: '截图目标' }),
      el('div', { text: `自动识别：${targetDesc}` }),
      el('button', {
        class: 'wt-back', type: 'button', text: '手动选择区域',
        style: 'margin-top:6px;',
        onclick: () => startPicking(s => { status.textContent = s; })
      })
    ]));
    card.appendChild(el('div', { class: 'wt-section' }, [
      el('p', { class: 'wt-section-title', text: '截图引擎' }),
      el('div', { class: 'wt-opts' }, [
        el('label', { class: 'wt-opt' }, [engineDom, ' DOM 渲染（默认，无需授权）']),
        el('label', { class: 'wt-opt' }, [engineScreen, ' 真实捕获（屏幕共享）'])
      ])
    ]));
    card.appendChild(el('div', { class: 'wt-section' }, [
      el('p', { class: 'wt-section-title', text: '参数' }),
      el('div', { class: 'wt-opts' }, [
        el('label', { class: 'wt-opt' }, ['等待 ms ', el('input', { id: 'wt-delay', type: 'number', value: '350', min: '100', step: '50' })]),
        el('label', { class: 'wt-opt' }, ['重叠 px ', el('input', { id: 'wt-overlap', type: 'number', value: '80', min: '0', step: '10' })]),
        el('label', { class: 'wt-opt' }, ['倍率 ', el('input', { id: 'wt-scale', type: 'number', value: '1', min: '0.5', max: '3', step: '0.5' })])
      ]),
      el('label', { class: 'wt-opt', style: 'margin-top:8px;' }, [
        el('input', { id: 'wt-preload', type: 'checkbox', style: 'width:auto;' }),
        ' 预加载懒加载图（更慢，适合图片懒加载页面）'
      ]),
      el('label', { class: 'wt-opt', style: 'margin-top:8px;' }, [
        el('input', { id: 'wt-copymode', type: 'checkbox', style: 'width:auto;' }),
        ' 复制到剪贴板（而非下载）'
      ])
    ]));
    card.appendChild(el('button', {
      class: 'wt-download', type: 'button', text: '开始截图',
      style: 'width:100%;margin-top:10px;',
      onclick: async () => {
        const copyMode = document.getElementById('wt-copymode')?.checked || false;
        closeToolbox();
        let lastStatus = '';
        await captureLongScreenshot(
          progress => { console.log('[截图]', progress); },
          s => { lastStatus = s; console.log('[截图]', s); },
          copyMode
        );
        openToolbox();
        const newStatus = document.querySelector(`#${PANEL_ID} .wt-status`);
        if (newStatus) newStatus.textContent = lastStatus || '完成。';
      }
    }));
    card.appendChild(status);
    updateHint();
    card.appendChild(el('div', {
      class: 'wt-note',
      text: '默认使用 DOM 渲染（html2canvas-pro，支持 ChatGPT 的 oklab 颜色），无需屏幕共享。需要像素级真实画面时再选真实捕获。超长页面自动分卷打包为 ZIP。自动检测并裁剪吸顶栏。悬浮钮可拖动，双击可贴边收起。'
    }));
  }

  // ===========================================================================
  // 启动
  // ===========================================================================
  function onNavigation() {
    const key = currentVideoKey();
    if (key !== cachedKey) { cachedTracks = null; cachedKey = ''; }
    closeToolbox();
    ensureButton();
  }

  function bootstrap() {
    const observer = new MutationObserver(() => ensureButton());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('popstate', onNavigation, true);
    window.addEventListener('yt-navigate-finish', onNavigation, true);
    document.addEventListener('yt-navigate-finish', onNavigation, true);

    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        cachedTracks = null;
        cachedKey = '';
        onNavigation();
      }
      ensureButton();
    }, URL_POLL_MS);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensureButton, { once: true });
    } else {
      ensureButton();
    }
  }

  installTimedTextInterceptor();
  installNextInterceptor();
  bootstrap();
})();
