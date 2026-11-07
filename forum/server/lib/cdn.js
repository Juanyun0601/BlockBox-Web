import { config } from '../config.js';

/**
 * CDN：论坛的公开资源（/assets/ 下的页面脚本样式、/uploads/ 下的图片）
 * 换成 CDN 域名去加载，论坛进程只管接口和页面本身。
 * 没配 CDN_BASE 时这里的函数都是空操作，行为和原来完全一样。
 *
 * 注意接口和数据库里一律保留站内相对路径，只在发 HTML 时改写，
 * 这样换 CDN 域名、以后把图片挪去对象存储，都不用动老内容。
 */

export const cdnBase = config.cdnBase;

/**
 * 页面 HTML 发出前改写：
 * 1. <link href="/assets/…">、<script src="/assets/…">、图片地址等改走 CDN；
 * 2. 把 CDN 域名注入给前端，core.js 拿它拼正文图片、头像这些地址。
 * 改写发生在内存里，磁盘上的 HTML 不动。
 */
export function rewritePageHtml(html) {
  if (!cdnBase) return html;
  const source = String(html == null ? '' : html);
  const boot = `<script>window.__BBF_CDN__=${JSON.stringify(cdnBase)};</script>`;
  const rewritten = source.replace(/(\s(?:href|src)=["'])\/(assets|uploads)\//g, `$1${cdnBase}/$2/`);
  if (rewritten.includes('</head>')) return rewritten.replace('</head>', `  ${boot}\n</head>`);
  return boot + rewritten;
}
