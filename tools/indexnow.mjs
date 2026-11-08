#!/usr/bin/env node
/**
 * 把 sitemap.xml 里的所有页面推送给 IndexNow（必应 / Yandex / Seznam / Naver 等共用）。
 *
 *   node tools/indexnow.mjs            推送 sitemap.xml 里的全部地址
 *   node tools/indexnow.mjs --dry-run  只打印，不发请求
 *
 * 前提：站点根目录有一个「密钥文件」，文件名和内容都是 IndexNow 密钥
 *      （当前为 <key>.txt，密钥写在下面的 INDEXNOW_KEY 里）。
 * 密钥文件被删掉的话推送会返回 403 —— 重新生成一个密钥文件、改这里的常量即可。
 *
 * 不需要任何账号或 API Key；返回 200/202 表示已接收。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const INDEXNOW_KEY = "8cbafa2bea15f7cada371dd5708ef915";
const HOST = "mcblockbox.top";
const ENDPOINT = "https://api.indexnow.org/indexnow";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sitemap = readFileSync(join(root, "sitemap.xml"), "utf8");
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());

if (!urls.length) {
  console.error("sitemap.xml 里没有找到 <loc> 地址");
  process.exit(1);
}

console.log(`准备推送 ${urls.length} 个地址：`);
urls.forEach((u) => console.log("  " + u));

if (process.argv.includes("--dry-run")) process.exit(0);

const body = {
  host: HOST,
  key: INDEXNOW_KEY,
  keyLocation: `https://${HOST}/${INDEXNOW_KEY}.txt`,
  urlList: urls,
};

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});

console.log(`\nIndexNow 返回 ${res.status} ${res.statusText}`);
if (res.status !== 200 && res.status !== 202) {
  console.error(await res.text().catch(() => ""));
  console.error("常见原因：密钥文件没上传 / 站点根路径不是 sitemap 里写的域名 / 同一批地址 10 分钟内重复推送");
  process.exit(1);
}
console.log("已接收，搜索引擎会在数小时到数天内抓取这些页面。");
