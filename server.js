'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('./db');
const auth = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const APP_ROUTES = new Set(['/login', '/booking', '/reception', '/settings']);
const ROLES = new Set(['admin', 'receptionist', 'viewer']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) throw new HttpError(403, 'Bạn không có quyền thực hiện thao tác này');
}

/* ------------------------------------------------------------------ */
/* Tiện ích                                                            */
/* ------------------------------------------------------------------ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'Dữ liệu gửi lên quá lớn'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'JSON không hợp lệ'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Kiểm tra dữ liệu đặt phòng                                          */
/* ------------------------------------------------------------------ */

async function validateBooking(input) {
  const roomId = str(input.roomId, 40);
  if (!(await db.roomExists(roomId))) throw new HttpError(400, 'Phòng không tồn tại');

  const fromDate = str(input.fromDate, 10);
  const toDate = str(input.toDate, 10);
  if (!isValidDate(fromDate) || !isValidDate(toDate)) throw new HttpError(400, 'Ngày không hợp lệ');
  if (toDate <= fromDate) throw new HttpError(400, 'Ngày trả phòng phải sau ngày nhận phòng');
  const paidUntil = str(input.paidUntil, 10);
  if (paidUntil && !isValidDate(paidUntil)) throw new HttpError(400, 'Ngày thanh toán không hợp lệ');

  return {
    roomId, fromDate, toDate,
    checkinTime: str(input.checkinTime, 5),
    checkoutTime: str(input.checkoutTime, 5),
    price: num(input.price),
    deposit: num(input.deposit),
    paid: Boolean(paidUntil),
    paidUntil,
    guestName: str(input.guestName, 100),
    guestPhone: str(input.guestPhone, 30),
    note: str(input.note, 500),
  };
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Đăng nhập                                                           */
/* ------------------------------------------------------------------ */

/** Người dùng của phiên hiện tại, hoặc null nếu chưa đăng nhập. */
async function currentUser(req) {
  const token = auth.readCookie(req);
  if (!token) return null;
  return db.userForSession(auth.hashToken(token));
}

async function handleAuthRoutes(req, res, resource, method) {
  // GET /api/me — app dùng để biết đã đăng nhập chưa
  if (resource === 'me' && method === 'GET') {
    const user = await currentUser(req);
    if (!user) throw new HttpError(401, 'Chưa đăng nhập');
    return sendJson(res, 200, { user });
  }

  // POST /api/login
  if (resource === 'login' && method === 'POST') {
    const body = await readBody(req);
    const username = str(body.username, 50).toLowerCase();
    const password = String(body.password ?? '');
    const key = auth.clientKey(req, username);

    const locked = auth.tooManyAttempts(key);
    if (locked) {
      throw new HttpError(429, `Sai quá nhiều lần. Thử lại sau ${locked} phút.`);
    }

    const row = username ? await db.findUserByUsername(username) : null;
    const ok = row && auth.verifyPassword(password, row.password_hash);
    if (!ok) {
      auth.noteFailure(key);
      throw new HttpError(401, 'Sai tên đăng nhập hoặc mật khẩu');
    }

    auth.clearFailures(key);
    const token = auth.newToken();
    await db.createSession(auth.hashToken(token), row.id, auth.SESSION_DAYS);
    res.setHeader('Set-Cookie', auth.sessionCookie(req, token));
    return sendJson(res, 200, {
      user: { id: row.id, username: row.username, displayName: row.display_name, role: row.role || 'admin' },
    });
  }

  // POST /api/logout
  if (resource === 'logout' && method === 'POST') {
    const token = auth.readCookie(req);
    if (token) await db.deleteSession(auth.hashToken(token));
    res.setHeader('Set-Cookie', auth.clearCookie(req));
    return sendJson(res, 200, { ok: true });
  }

  return false; // không phải route đăng nhập
}

async function handleUserRoutes(req, res, user, resource, param, method) {
  // GET /api/users
  if (resource === 'users' && method === 'GET') {
    return sendJson(res, 200, { users: await db.listUsers(), me: user.id });
  }

  // POST /api/users — thêm tài khoản
  if (resource === 'users' && method === 'POST') {
    requireRole(user, 'admin');
    const body = await readBody(req);
    const username = str(body.username, 50).toLowerCase();
    const password = String(body.password ?? '');
    if (!/^[a-z0-9._-]{3,50}$/.test(username)) {
      throw new HttpError(400, 'Tên đăng nhập chỉ gồm chữ thường, số, dấu chấm, gạch ngang; dài 3–50 ký tự');
    }
    if (password.length < 6) throw new HttpError(400, 'Mật khẩu phải từ 6 ký tự trở lên');
    const role = str(body.role, 20);
    if (!ROLES.has(role)) throw new HttpError(400, 'Vai trò tài khoản không hợp lệ');
    if (await db.findUserByUsername(username)) throw new HttpError(409, 'Tên đăng nhập đã tồn tại');

    const created = await db.createUser({
      username,
      displayName: str(body.displayName, 100) || username,
      passwordHash: auth.hashPassword(password),
      role,
    });
    return sendJson(res, 201, created);
  }

  // DELETE /api/users/:id
  if (resource === 'users' && method === 'DELETE' && param) {
    requireRole(user, 'admin');
    if (param === user.id) throw new HttpError(400, 'Không thể xoá chính tài khoản đang dùng');
    if ((await db.countUsers()) <= 1) throw new HttpError(400, 'Phải còn ít nhất một tài khoản');
    if (!(await db.deleteUser(param))) throw new HttpError(404, 'Không tìm thấy tài khoản');
    return sendJson(res, 200, { ok: true });
  }

  // PUT /api/users/:id — đổi vai trò tài khoản
  if (resource === 'users' && method === 'PUT' && param) {
    requireRole(user, 'admin');
    if (param === user.id) throw new HttpError(400, 'Không thể đổi vai trò chính tài khoản đang dùng');
    const body = await readBody(req);
    const role = str(body.role, 20);
    if (!ROLES.has(role)) throw new HttpError(400, 'Vai trò tài khoản không hợp lệ');
    if (!(await db.setUserRole(param, role))) throw new HttpError(404, 'Không tìm thấy tài khoản');
    const updated = await db.getUserById(param);
    return sendJson(res, 200, {
      user: { id: updated.id, username: updated.username, displayName: updated.display_name, role: updated.role },
    });
  }

  // PUT /api/password — đổi mật khẩu của chính mình
  if (resource === 'password' && method === 'PUT') {
    const body = await readBody(req);
    const current = String(body.currentPassword ?? '');
    const next = String(body.newPassword ?? '');
    if (next.length < 6) throw new HttpError(400, 'Mật khẩu mới phải từ 6 ký tự trở lên');

    const row = await db.getUserById(user.id);
    if (!row || !auth.verifyPassword(current, row.password_hash)) {
      throw new HttpError(401, 'Mật khẩu hiện tại không đúng');
    }
    await db.setPassword(user.id, auth.hashPassword(next));
    // Đăng xuất các thiết bị khác, giữ lại thiết bị đang thao tác
    const token = auth.readCookie(req);
    await db.deleteSessionsOfUser(user.id, token ? auth.hashToken(token) : null);
    return sendJson(res, 200, { ok: true });
  }

  return false;
}

async function handleApi(req, res, pathname) {
  const method = req.method;
  const [, resource, param] = pathname.split('/').filter(Boolean);

  // Các route không cần đăng nhập
  if (await handleAuthRoutes(req, res, resource, method) !== false) return;

  // Từ đây trở xuống bắt buộc phải đăng nhập
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, 'Chưa đăng nhập');

  if (await handleUserRoutes(req, res, user, resource, param, method) !== false) return;

  // GET /api/data
  if (resource === 'data' && method === 'GET') {
    return sendJson(res, 200, await db.getAllData());
  }

  // PUT /api/settings
  if (resource === 'settings' && method === 'PUT') {
    requireRole(user, 'admin');
    const body = await readBody(req);
    const hotelName = str(body.hotelName, 100) || 'Khách sạn của tôi';
    // Đơn giá dọn: bỏ trống thì quay về mặc định, không cho thành 0 ngoài ý muốn
    const cleaningRate = body.cleaningRate === undefined || body.cleaningRate === ''
      ? db.DEFAULT_CLEANING_RATE
      : num(body.cleaningRate);
    await db.saveSettings({ hotelName, cleaningRate });
    return sendJson(res, 200, { hotelName, cleaningRate });
  }

  // PUT /api/rooms
  if (resource === 'rooms' && method === 'PUT') {
    requireRole(user, 'admin');
    const body = await readBody(req);
    if (!Array.isArray(body.rooms)) throw new HttpError(400, 'Thiếu danh sách phòng');
    const rooms = body.rooms.slice(0, 500).map((r) => ({
      id: str(r.id, 40) || null,
      name: str(r.name, 60) || 'Phòng',
      type: str(r.type, 60),
      defaultPrice: num(r.defaultPrice),
      note: str(r.note, 200),
    }));
    const { blocked } = await db.saveRooms(rooms);
    if (blocked.length) {
      throw new HttpError(409, `Không thể xoá phòng đang có đặt phòng: ${blocked.join(', ')}`);
    }
    return sendJson(res, 200, { rooms: await db.getRooms() });
  }

  // PUT /api/areas
  if (resource === 'areas' && method === 'PUT') {
    requireRole(user, 'admin');
    const body = await readBody(req);
    if (!Array.isArray(body.areas)) throw new HttpError(400, 'Thiếu danh sách khu vực');
    const areas = body.areas.slice(0, 200).map((a) => ({
      id: str(a.id, 40) || null,
      name: str(a.name, 80) || 'Khu vực',
      note: str(a.note, 200),
    }));
    await db.saveAreas(areas);
    return sendJson(res, 200, { areas: await db.getAreas() });
  }

  // PUT /api/staff
  if (resource === 'staff' && method === 'PUT') {
    requireRole(user, 'admin');
    const body = await readBody(req);
    if (!Array.isArray(body.staff)) throw new HttpError(400, 'Thiếu danh sách lễ tân');
    const staff = body.staff.slice(0, 200).map((s) => ({
      id: str(s.id, 40) || null,
      name: str(s.name, 100) || 'Nhân viên',
      phone: str(s.phone, 30),
      note: str(s.note, 200),
    }));
    const { blocked } = await db.saveStaff(staff);
    if (blocked.length) {
      throw new HttpError(409,
        `Không thể xoá lễ tân đã có ngày chấm công: ${blocked.join(', ')}`);
    }
    return sendJson(res, 200, { staff: await db.getStaff() });
  }

  // POST /api/bookings
  if (resource === 'bookings' && method === 'POST') {
    requireRole(user, 'admin');
    const input = await validateBooking(await readBody(req));
    const result = await db.upsertBooking(input);
    if (result.conflict) {
      const name = await db.getRoomName(input.roomId);
      throw new HttpError(409,
        `Phòng ${name} đã có khách từ ${result.conflict.fromDate} đến ${result.conflict.toDate}`);
    }
    return sendJson(res, 201, result.booking);
  }

  // PUT /api/bookings/:id
  if (resource === 'bookings' && method === 'PUT' && param) {
    requireRole(user, 'admin');
    const input = await validateBooking(await readBody(req));
    const result = await db.upsertBooking(input, str(param, 40));
    if (result.notFound) throw new HttpError(404, 'Không tìm thấy đặt phòng');
    if (result.conflict) {
      const name = await db.getRoomName(input.roomId);
      throw new HttpError(409,
        `Phòng ${name} đã có khách từ ${result.conflict.fromDate} đến ${result.conflict.toDate}`);
    }
    return sendJson(res, 200, result.booking);
  }

  // DELETE /api/bookings/:id
  if (resource === 'bookings' && method === 'DELETE' && param) {
    requireRole(user, 'admin');
    if (!(await db.deleteBooking(str(param, 40)))) throw new HttpError(404, 'Không tìm thấy đặt phòng');
    return sendJson(res, 200, { ok: true });
  }

  // PUT /api/housekeeping/:date
  if (resource === 'housekeeping' && method === 'PUT' && param) {
    requireRole(user, 'admin', 'receptionist');
    if (!isValidDate(param)) throw new HttpError(400, 'Ngày không hợp lệ');
    const body = await readBody(req);

    // Chỉ nhận id phòng/khu vực/lễ tân có thật
    const validRooms = new Set((await db.getRooms()).map((r) => r.id));
    const validAreas = new Set((await db.getAreas()).map((a) => a.id));
    const validStaff = new Set((await db.getStaff()).map((s) => s.id));
    const staffId = str(body.staffId, 40);
    if (staffId && !validStaff.has(staffId)) throw new HttpError(400, 'Lễ tân không tồn tại');

    const record = {
      roomIds: Object.keys(body.rooms || {}).filter((id) => body.rooms[id] && validRooms.has(id)),
      areaIds: Object.keys(body.areas || {}).filter((id) => body.areas[id] && validAreas.has(id)),
      staffId,
      note: str(body.note, 500),
      paid: Boolean(body.paid),
      salary: num(body.salary),
    };
    const saved = await db.saveHousekeeping(param, record);
    return sendJson(res, 200, { date: param, record: saved });
  }

  throw new HttpError(404, 'Endpoint không tồn tại');
}

/* ------------------------------------------------------------------ */
/* File tĩnh                                                           */
/* ------------------------------------------------------------------ */

function serveStatic(res, pathname) {
  const rel = pathname === '/' || APP_ROUTES.has(pathname)
    ? 'index.html'
    : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Không tìm thấy trang');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname);
    } catch (err) {
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message || 'Lỗi máy chủ' });
      if (!err.status) console.error(err);
    }
    return;
  }
  serveStatic(res, pathname);
});

/* ------------------------------------------------------------------ */
/* Khởi động                                                           */
/* ------------------------------------------------------------------ */

/** Các địa chỉ IPv4 trong mạng nội bộ mà thiết bị khác có thể gõ vào trình duyệt. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function explainDbError(err) {
  const c = db.config;
  const where = `${c.user}@${c.host}:${c.port}`;
  if (err.code === 'ECONNREFUSED') {
    return `Không kết nối được MariaDB tại ${c.host}:${c.port}.\n` +
      `  → Kiểm tra MariaDB đã cài và service đang chạy chưa:  sc query MariaDB`;
  }
  if (err.code === 'ER_ACCESS_DENIED_ERROR') {
    return `Sai tài khoản hoặc mật khẩu MariaDB (${where}).\n` +
      `  → Sửa lại user/password trong file config.json`;
  }
  return err.message;
}

/**
 * Lần chạy đầu chưa có tài khoản nào thì tạo sẵn một tài khoản quản trị
 * với mật khẩu ngẫu nhiên, in ra màn hình để chủ khách sạn đăng nhập rồi đổi.
 */
async function ensureFirstUser() {
  if ((await db.countUsers()) > 0) return;
  const password = crypto.randomBytes(6).toString('base64url'); // 8 ký tự dễ gõ
  await db.createUser({
    username: 'admin',
    displayName: 'Quản lý',
    passwordHash: auth.hashPassword(password),
    role: 'admin',
  });
  console.log('\n  ╔════════════════════════════════════════════════════╗');
  console.log('  ║  TÀI KHOẢN ĐĂNG NHẬP LẦN ĐẦU                       ║');
  console.log('  ╠════════════════════════════════════════════════════╣');
  console.log(`  ║  Tên đăng nhập :  admin${' '.repeat(28)}║`);
  console.log(`  ║  Mật khẩu      :  ${password.padEnd(33)}║`);
  console.log('  ║                                                    ║');
  console.log('  ║  Hãy đăng nhập rồi đổi mật khẩu ở tab Cài đặt.     ║');
  console.log('  ╚════════════════════════════════════════════════════╝');
}

(async () => {
  try {
    await db.init();
    await ensureFirstUser();
    await db.purgeExpiredSessions();
    // Dọn phiên hết hạn mỗi 6 tiếng
    setInterval(() => db.purgeExpiredSessions().catch(() => {}), 6 * 60 * 60 * 1000).unref();
  } catch (err) {
    console.error('\n  LỖI KẾT NỐI DATABASE\n');
    console.error('  ' + explainDbError(err) + '\n');
    process.exit(1);
  }

  // '::' = nghe trên mọi card mạng, nhờ đó điện thoại trong cùng wifi vào được
  server.listen(PORT, '::', () => {
    const c = db.config;
    console.log(`\n  QUẢN LÝ KHÁCH SẠN đang chạy`);
    console.log(`  ────────────────────────────────────────────`);
    console.log(`  Máy này      :  http://localhost:${PORT}`);
    for (const addr of lanAddresses()) {
      console.log(`  Máy/điện thoại cùng mạng:  http://${addr}:${PORT}`);
    }
    console.log(`  ────────────────────────────────────────────`);
    console.log(`  Database     :  MariaDB ${c.host}:${c.port}/${c.database} (user: ${c.user})`);
    console.log(`  Dừng lại     :  Ctrl+C\n`);
  });
})();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await db.close();
    process.exit(0);
  });
}
