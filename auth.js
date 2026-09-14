'use strict';

/**
 * Đăng nhập & phiên làm việc.
 *
 * - Mật khẩu băm bằng scrypt (có sẵn trong Node, không cần thư viện ngoài),
 *   mỗi mật khẩu một muối riêng.
 * - Token phiên là 32 byte ngẫu nhiên; database chỉ lưu bản băm SHA-256 của nó,
 *   nên kể cả lộ database cũng không mạo danh được ai.
 * - Cookie đặt HttpOnly + SameSite=Lax để JavaScript của trang khác không đọc
 *   hay lợi dụng được.
 */

const crypto = require('node:crypto');

const SESSION_DAYS = 30;
const COOKIE_NAME = 'hotel_session';

/* ------------------------------------------------------------------ */
/* Băm mật khẩu                                                        */
/* ------------------------------------------------------------------ */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, key] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(key, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    // So sánh theo thời gian hằng định để không lộ thông tin qua thời gian phản hồi
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Token phiên                                                         */
/* ------------------------------------------------------------------ */

const newToken = () => crypto.randomBytes(32).toString('hex');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/* ------------------------------------------------------------------ */
/* Cookie                                                              */
/* ------------------------------------------------------------------ */

function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** Trang chạy qua HTTPS (ví dụ sau Cloudflare Tunnel) thì gắn thêm cờ Secure. */
function isHttps(req) {
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

function sessionCookie(req, token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(req) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

/* ------------------------------------------------------------------ */
/* Hạn chế thử mật khẩu liên tục                                       */
/* ------------------------------------------------------------------ */

const attempts = new Map(); // khoá -> { count, until }
const MAX_ATTEMPTS = 8;
const LOCK_MINUTES = 10;

function tooManyAttempts(key) {
  const rec = attempts.get(key);
  if (!rec) return 0;
  if (Date.now() > rec.until) {
    attempts.delete(key);
    return 0;
  }
  return rec.count >= MAX_ATTEMPTS ? Math.ceil((rec.until - Date.now()) / 60000) : 0;
}

function noteFailure(key) {
  const rec = attempts.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  rec.until = Date.now() + LOCK_MINUTES * 60 * 1000;
  attempts.set(key, rec);
}

const clearFailures = (key) => attempts.delete(key);

/** Địa chỉ người gọi, dùng làm khoá đếm số lần thử sai. */
function clientKey(req, username = '') {
  const ip = req.socket.remoteAddress || 'unknown';
  return `${ip}|${String(username).toLowerCase()}`;
}

module.exports = {
  COOKIE_NAME, SESSION_DAYS,
  hashPassword, verifyPassword,
  newToken, hashToken,
  readCookie, sessionCookie, clearCookie,
  tooManyAttempts, noteFailure, clearFailures, clientKey,
};
