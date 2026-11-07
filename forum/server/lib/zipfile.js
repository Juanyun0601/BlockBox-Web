/**
 * 极简 zip 读取器：只够从 .BlockBox 插件包里取出 plugin.json 和图标。
 *
 * 论坛服务端刻意保持零依赖，所以这里直接按 PKWARE APPNOTE 手解：
 * 1. 从文件尾部扫中央目录结束记录（EOCD），拿到中央目录的位置和条目数；
 * 2. 遍历中央目录记录，拿到文件名、压缩方式、真实大小和数据起始位置；
 * 3. 取条目时按本地文件头里的文件名/扩展字段长度定位数据段再解压。
 *
 * 只读不解包：数据始终留在内存里，条目名再怎么写 ../ 也碰不到磁盘。
 * 20MB 以内的包不会有 ZIP64，超大的中央目录条目数也被文件大小本身封顶。
 */
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** EOCD 固定 22 字节 + 注释区最长 64KB，往后扫一段就够了 */
const EOCD_SCAN = 22 + 65536;

/**
 * 按小端读取（EOCD / 中央目录记录都是小端布局）。
 * buffer 足够长是调用方保证的，这里不再重复校验。
 */
function readU16(buf, offset) {
  return buf.readUInt16LE(offset);
}
function readU32(buf, offset) {
  return buf.readUInt32LE(offset);
}

/**
 * 解析整个中央目录，返回条目数组：
 * { name, method, flags, compressedSize, uncompressedSize, localOffset }
 * 解析不出 EOCD（不是 zip、被截断、超过 64KB 注释）时返回 null。
 */
export function readCentralEntries(buffer) {
  if (!buffer || buffer.length < 22) return null;

  // 从尾部往前找 EOCD 签名：正常 22 字节收尾，带注释时往前挪
  const scanStart = Math.max(0, buffer.length - EOCD_SCAN);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= scanStart; i -= 1) {
    if (readU32(buffer, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  // 全部在同一个盘（当前/中央目录）才认；分卷的包不是合法插件包
  // EOCD 布局:0 签名 / 4 当前盘号 / 6 中央目录起始盘 / 8 本盘条目数 / 10 总条目数 / 12 目录大小 / 16 目录偏移 / 20 注释长
  const diskNo = readU16(buffer, eocd + 4);
  const cdDisk = readU16(buffer, eocd + 6);
  if (diskNo !== 0 || cdDisk !== 0) return null;

  const entriesOnDisk = readU16(buffer, eocd + 8);
  const totalEntries = readU16(buffer, eocd + 10);
  // 同一盘上「本盘条目数」必须等于「总条目数」（ZIP64 的多盘/超 65535 条不在此列）
  if (entriesOnDisk !== totalEntries) return null;

  const cdOffset = readU32(buffer, eocd + 16);
  const cdSize = readU32(buffer, eocd + 12);
  if (cdOffset + cdSize > buffer.length) return null;

  const entries = [];
  let offset = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (offset + 46 > cdOffset + cdSize || readU32(buffer, offset) !== CENTRAL_SIG) return null;

    const flags = readU16(buffer, offset + 8);
    const method = readU16(buffer, offset + 10);
    const compressedSize = readU32(buffer, offset + 20);
    const uncompressedSize = readU32(buffer, offset + 24);
    const nameLen = readU16(buffer, offset + 28);
    const extraLen = readU16(buffer, offset + 30);
    const commentLen = readU16(buffer, offset + 32);
    const localOffset = readU32(buffer, offset + 42);

    const nameStart = offset + 46;
    if (nameStart + nameLen > buffer.length) return null;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLen);

    // 本地头校验放提取时做；这里只要名字能读出来
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localOffset });

    offset = nameStart + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 从 zip 里解出一条指定条目：
 * 返回 Buffer；条目加密（flags bit 0）、压缩方式不支持、
 * 数据越界或解压后与声明大小不符都返回 null。
 * maxOutputLength 给 inflate 兜底，防压缩炸弹。
 */
export function extractEntryToMemory(buffer, entry, maxOutputLength = 10 * 1024 * 1024) {
  if (!buffer || !entry || entry.localOffset + 30 > buffer.length) return null;
  if (readU32(buffer, entry.localOffset) !== LOCAL_SIG) return null;

  const flags = entry.flags;
  if (flags & 0x0001) return null; // 加密包直接放弃

  const nameLen = readU16(buffer, entry.localOffset + 26);
  const extraLen = readU16(buffer, entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  if (dataStart + entry.compressedSize > buffer.length) return null;

  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  try {
    if (entry.method === 0) {
      if (raw.length !== entry.uncompressedSize) return null;
      return Buffer.from(raw);
    }
    if (entry.method !== 8) return null; // 只支持存储与 deflate
    const out = zlib.inflateRawSync(raw, {
      maxOutputLength: Math.min(maxOutputLength, entry.uncompressedSize || maxOutputLength),
    });
    if (out.length !== entry.uncompressedSize) return null;
    return out;
  } catch {
    return null;
  }
}

/** 按文件名找条目（先精确匹配，再大小写不敏感地试根目录下的同名文件） */
export function findEntry(entries, wanted) {
  const name = String(wanted || '');
  for (const entry of entries) {
    if (entry.name === name) return entry;
  }
  const lower = `/${name.toLowerCase()}`;
  for (const entry of entries) {
    if (`/${entry.name.toLowerCase()}`.endsWith(lower) && !entry.name.toLowerCase().includes('/', 1)) {
      return entry;
    }
  }
  return null;
}
