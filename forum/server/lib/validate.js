import { badRequest } from './http.js';

/** 必填字符串 + 长度校验（按字符数算，中文算 1 个字） */
export function text(value, { field = '内容', min = 0, max = 1000, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return '';
    throw badRequest(`${field}不能为空`);
  }
  if (typeof value !== 'string') throw badRequest(`${field}格式不正确`);
  const cleaned = value.replace(/\r\n/g, '\n').trim();
  if (optional && cleaned === '') return '';
  const length = [...cleaned].length;
  if (length < min) throw badRequest(`${field}至少需要 ${min} 个字`);
  if (length > max) throw badRequest(`${field}最多 ${max} 个字`);
  return cleaned;
}

const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-]+$/;

export function username(value) {
  const name = text(value, { field: '用户名', min: 2, max: 20 });
  if (!USERNAME_RE.test(name)) {
    throw badRequest('用户名只能包含中文、字母、数字、下划线和短横线');
  }
  if (/^\d+$/.test(name)) throw badRequest('用户名不能是纯数字');
  return name;
}

export function password(value) {
  if (typeof value !== 'string') throw badRequest('密码格式不正确');
  if (value.length < 6) throw badRequest('密码至少 6 位');
  if (value.length > 72) throw badRequest('密码最多 72 位');
  return value;
}

export function email(value) {
  const cleaned = text(value, { field: '邮箱', max: 120, optional: true });
  if (!cleaned) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) throw badRequest('邮箱格式不正确');
  return cleaned;
}

export function int(value, { field = '参数', min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${field}不能为空`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw badRequest(`${field}必须是整数`);
  if (parsed < min || parsed > max) throw badRequest(`${field}超出范围`);
  return parsed;
}

export function bool(value, { field = '参数', fallback = false } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  throw badRequest(`${field}必须是 true 或 false`);
}
