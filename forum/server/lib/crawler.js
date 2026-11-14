/**
 * 爬虫识别：搜索引擎与社交分享卡片的抓取 UA。
 *
 * 论坛页面对真人有一道滑块人机验证，但这道门禁不该挡住搜索引擎和
 * 链接预览机器人——它们拿不到 Cookie，也（多数）不执行脚本，被挡住
 * 只会看到一个验证页。对这类 UA，直接回服务端渲染的只读页面（ssr.js）。
 *
 * 只认明确的、业界公认的机器人标识，不做模糊匹配：
 * 误放真人会看到简化版页面（没什么害处），误拦爬虫才丢收录。
 */

const CRAWLER_UA =
  /(?:^|[ /])(?:baiduspider|bingbot|bingpreview|msnbot|googlebot|google-inspectiontool|googleother|adsbot-google|duckduckbot|yandexbot|yandeximages|yandexaccessibility|sogou(?: web| inst| news)? spider|haousouspider|360spider|petalbot|applebot|yeti|naverbot|seznambot|mojeekbot|twitterbot|facebookexternalhit|facebookcatalog|discordbot|whatsapp|telegrambot|linkedinbot|slackbot|skypeuripreview|ia_archiver)/i;

/** 这类请求是否来自搜索引擎 / 链接预览机器人 */
export function isCrawlerUA(userAgent = '') {
  return CRAWLER_UA.test(String(userAgent || ''));
}
