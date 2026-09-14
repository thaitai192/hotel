'use strict';

/**
 * Lớp truy cập dữ liệu MariaDB.
 * Mọi hàm ở đây trả về dữ liệu đúng hình dạng mà giao diện đang dùng
 * (camelCase), nên phần frontend không phải sửa gì.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const LEGACY_JSON = path.join(__dirname, 'data.json');

const uid = () => crypto.randomUUID().slice(0, 8);

/** Đơn giá dọn mỗi mục (mỗi phòng / mỗi khu vực chung) khi chưa cài đặt gì. */
const DEFAULT_CLEANING_RATE = 50000;

/* ------------------------------------------------------------------ */
/* Cấu hình kết nối                                                    */
/* ------------------------------------------------------------------ */

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`config.json không hợp lệ: ${err.message}`);
  }
  // Biến môi trường được ưu tiên hơn config.json
  return {
    host: process.env.DB_HOST || file.host || '127.0.0.1',
    port: Number(process.env.DB_PORT || file.port || 3306),
    user: process.env.DB_USER || file.user || 'root',
    password: process.env.DB_PASSWORD ?? file.password ?? '',
    database: process.env.DB_NAME || file.database || 'hotel',
  };
}

let pool = null;
const cfg = loadConfig();

/* ------------------------------------------------------------------ */
/* Khởi tạo: tạo database, tạo bảng, chuyển dữ liệu cũ                  */
/* ------------------------------------------------------------------ */

async function init() {
  // Kết nối lần đầu KHÔNG chọn database, để có thể tạo nếu chưa có
  const bootstrap = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    multipleStatements: false,
  });
  await bootstrap.query(
    `CREATE DATABASE IF NOT EXISTS \`${cfg.database.replace(/`/g, '')}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await bootstrap.end();

  pool = mysql.createPool({
    ...cfg,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4_unicode_ci',
    dateStrings: true,      // DATE trả về chuỗi 'YYYY-MM-DD', tránh lệch múi giờ
    supportBigNumbers: true,
    timezone: 'local',
  });

  await runSchema();
  await runMigrations();
  await maybeImportLegacyJson();
}

/** Kiểm tra một cột có tồn tại trong bảng không. */
async function hasColumn(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [cfg.database, table, column]
  );
  return rows.length > 0;
}

/**
 * Nâng cấp database tạo từ phiên bản cũ.
 * Trước đây housekeeping_days lưu THẲNG tên lễ tân dưới dạng chữ (cột `staff`).
 * Nay tên lễ tân nằm ở bảng riêng và được tham chiếu bằng staff_id.
 */
async function runMigrations() {
  const hadTextColumn = await hasColumn('housekeeping_days', 'staff');
  const hasStaffId = await hasColumn('housekeeping_days', 'staff_id');

  if (!hasStaffId) {
    await pool.query('ALTER TABLE housekeeping_days ADD COLUMN staff_id VARCHAR(40) NULL');
  }

  if (hadTextColumn) {
    // Chuyển từng tên lễ tân đang lưu dạng chữ thành một dòng trong bảng staff
    const [names] = await pool.query(
      `SELECT DISTINCT staff FROM housekeeping_days WHERE staff <> '' AND staff IS NOT NULL`
    );
    for (const [i, row] of names.entries()) {
      const [existing] = await pool.query('SELECT id FROM staff WHERE name = ?', [row.staff]);
      const id = existing.length ? existing[0].id : uid();
      if (!existing.length) {
        await pool.query('INSERT INTO staff (id, name, sort_order) VALUES (?,?,?)', [id, row.staff, i]);
      }
      await pool.query('UPDATE housekeeping_days SET staff_id = ? WHERE staff = ?', [id, row.staff]);
    }
    await pool.query('ALTER TABLE housekeeping_days DROP COLUMN staff');
    if (names.length) console.log(`  Đã chuyển ${names.length} tên lễ tân sang bảng staff.`);
  }

  // Thêm khoá ngoại nếu chưa có (bảng cũ vừa được thêm cột thì chưa có ràng buộc)
  const [fk] = await pool.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'housekeeping_days'
       AND CONSTRAINT_NAME = 'fk_hkdays_staff'`,
    [cfg.database]
  );
  if (fk.length === 0) {
    await pool.query(
      `ALTER TABLE housekeeping_days
       ADD CONSTRAINT fk_hkdays_staff FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT`
    );
  }

  if (!(await hasColumn('users', 'role'))) {
    await pool.query("ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'admin' AFTER password_hash");
  }

  if (!(await hasColumn('bookings', 'paid_until'))) {
    await pool.query('ALTER TABLE bookings ADD COLUMN paid_until DATE NULL AFTER paid');
    await pool.query('UPDATE bookings SET paid_until = check_out_date WHERE paid = 1');
  }
}

async function runSchema() {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  for (const stmt of sql.split(';')) {
    if (stmt.trim()) await pool.query(stmt);
  }
}

/** Nếu còn data.json từ phiên bản cũ và database đang trống thì nạp vào. */
async function maybeImportLegacyJson() {
  if (!fs.existsSync(LEGACY_JSON)) return;
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM rooms');
  if (Number(n) > 0) return;

  let old;
  try {
    old = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
  } catch {
    console.warn('  Bỏ qua data.json (không đọc được).');
    return;
  }
  if (!old.rooms?.length && !old.areas?.length) return;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (old.hotelName) {
      await conn.query('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
        ['hotelName', old.hotelName]);
    }
    for (const [i, r] of (old.rooms || []).entries()) {
      await conn.query(
        'INSERT INTO rooms (id, name, type, default_price, note, sort_order) VALUES (?,?,?,?,?,?)',
        [r.id || uid(), r.name || 'Phòng', r.type || '', r.defaultPrice || 0, r.note || '', i]
      );
    }
    for (const [i, a] of (old.areas || []).entries()) {
      await conn.query('INSERT INTO areas (id, name, note, sort_order) VALUES (?,?,?,?)',
        [a.id || uid(), a.name || 'Khu vực', a.note || '', i]);
    }
    for (const b of old.bookings || []) {
      await conn.query(
        `INSERT INTO bookings (id, room_id, check_in_date, check_out_date, check_in_time, check_out_time,
                               price, deposit, paid, paid_until, guest_name, guest_phone, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [b.id || uid(), b.roomId, b.fromDate, b.toDate, b.checkinTime || '', b.checkoutTime || '',
         b.price || 0, b.deposit || 0, b.paid ? 1 : 0, b.paidUntil || (b.paid ? b.toDate : null),
         b.guestName || '', b.guestPhone || '', b.note || '']
      );
    }
    // Tên lễ tân trong file cũ là chữ — gom lại thành danh sách nhân viên
    const staffIdByName = new Map();
    for (const rec of Object.values(old.housekeeping || {})) {
      const name = (rec.staff || '').trim();
      if (name && !staffIdByName.has(name)) staffIdByName.set(name, uid());
    }
    for (const [i, [name, id]] of [...staffIdByName].entries()) {
      await conn.query('INSERT INTO staff (id, name, sort_order) VALUES (?,?,?)', [id, name, i]);
    }

    for (const [date, rec] of Object.entries(old.housekeeping || {})) {
      await conn.query(
        'INSERT INTO housekeeping_days (hk_date, staff_id, note, paid, salary) VALUES (?,?,?,?,?)',
        [date, staffIdByName.get((rec.staff || '').trim()) || null,
         rec.note || '', rec.paid ? 1 : 0, rec.salary || 0]
      );
      for (const roomId of Object.keys(rec.rooms || {})) {
        await conn.query('INSERT IGNORE INTO housekeeping_rooms (hk_date, room_id) VALUES (?,?)', [date, roomId]);
      }
      for (const areaId of Object.keys(rec.areas || {})) {
        await conn.query('INSERT IGNORE INTO housekeeping_areas (hk_date, area_id) VALUES (?,?)', [date, areaId]);
      }
    }
    await conn.commit();
    const backup = LEGACY_JSON + '.imported-' + Date.now();
    fs.renameSync(LEGACY_JSON, backup);
    console.log(`  Đã chuyển dữ liệu từ data.json vào MariaDB. File cũ đổi tên thành ${path.basename(backup)}`);
  } catch (err) {
    await conn.rollback();
    console.error('  Không chuyển được data.json:', err.message);
  } finally {
    conn.release();
  }
}

/* ------------------------------------------------------------------ */
/* Chuyển đổi bản ghi DB <-> JSON cho giao diện                        */
/* ------------------------------------------------------------------ */

const toRoom = (r) => ({
  id: r.id, name: r.name, type: r.type,
  defaultPrice: Number(r.default_price), note: r.note,
});

const toArea = (a) => ({ id: a.id, name: a.name, note: a.note });

const toStaff = (s) => ({ id: s.id, name: s.name, phone: s.phone, note: s.note });

const toBooking = (b) => ({
  id: b.id,
  roomId: b.room_id,
  fromDate: b.check_in_date,
  toDate: b.check_out_date,
  checkinTime: b.check_in_time,
  checkoutTime: b.check_out_time,
  price: Number(b.price),
  deposit: Number(b.deposit),
  paid: Boolean(b.paid),
  paidUntil: b.paid_until || '',
  guestName: b.guest_name,
  guestPhone: b.guest_phone,
  note: b.note,
  createdAt: b.created_at,
});

/* ------------------------------------------------------------------ */
/* Đọc dữ liệu                                                         */
/* ------------------------------------------------------------------ */

async function getAllData() {
  const [settings] = await pool.query('SELECT k, v FROM settings');
  const [rooms] = await pool.query('SELECT * FROM rooms ORDER BY sort_order, name');
  const [areas] = await pool.query('SELECT * FROM areas ORDER BY sort_order, name');
  const [staff] = await pool.query('SELECT * FROM staff ORDER BY sort_order, name');
  const [bookings] = await pool.query('SELECT * FROM bookings ORDER BY check_in_date');
  const [hkDays] = await pool.query('SELECT * FROM housekeeping_days');
  const [hkRooms] = await pool.query('SELECT * FROM housekeeping_rooms');
  const [hkAreas] = await pool.query('SELECT * FROM housekeeping_areas');

  const housekeeping = {};
  for (const d of hkDays) {
    housekeeping[d.hk_date] = {
      rooms: {}, areas: {},
      staffId: d.staff_id || '', note: d.note, paid: Boolean(d.paid), salary: Number(d.salary),
    };
  }
  for (const r of hkRooms) if (housekeeping[r.hk_date]) housekeeping[r.hk_date].rooms[r.room_id] = true;
  for (const a of hkAreas) if (housekeeping[a.hk_date]) housekeeping[a.hk_date].areas[a.area_id] = true;

  const settingMap = Object.fromEntries(settings.map((s) => [s.k, s.v]));

  return {
    hotelName: settingMap.hotelName || 'Khách sạn của tôi',
    cleaningRate: Number(settingMap.cleaningRate ?? DEFAULT_CLEANING_RATE) || 0,
    rooms: rooms.map(toRoom),
    areas: areas.map(toArea),
    staff: staff.map(toStaff),
    bookings: bookings.map(toBooking),
    housekeeping,
  };
}

async function getStaff() {
  const [rows] = await pool.query('SELECT * FROM staff ORDER BY sort_order, name');
  return rows.map(toStaff);
}

async function getRooms() {
  const [rows] = await pool.query('SELECT * FROM rooms ORDER BY sort_order, name');
  return rows.map(toRoom);
}

async function getAreas() {
  const [rows] = await pool.query('SELECT * FROM areas ORDER BY sort_order, name');
  return rows.map(toArea);
}

async function roomExists(id) {
  const [rows] = await pool.query('SELECT id FROM rooms WHERE id = ?', [id]);
  return rows.length > 0;
}

async function getRoomName(id) {
  const [rows] = await pool.query('SELECT name FROM rooms WHERE id = ?', [id]);
  return rows.length ? rows[0].name : '';
}

/* ------------------------------------------------------------------ */
/* Ghi dữ liệu                                                         */
/* ------------------------------------------------------------------ */

/** Lưu các cài đặt chung dạng khoá/giá trị. */
async function saveSettings(pairs) {
  for (const [k, v] of Object.entries(pairs)) {
    await pool.query('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
      [k, String(v)]);
  }
}

/**
 * Thay toàn bộ danh sách phòng.
 * Trả về { blocked: [tên phòng] } nếu có phòng bị xoá mà đang có đặt phòng.
 */
async function saveRooms(rooms) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query('SELECT id, name FROM rooms FOR UPDATE');
    const keep = new Set(rooms.map((r) => r.id).filter(Boolean));
    const removing = existing.filter((r) => !keep.has(r.id));

    if (removing.length) {
      const [used] = await conn.query(
        `SELECT DISTINCT r.name FROM rooms r JOIN bookings b ON b.room_id = r.id
         WHERE r.id IN (?)`, [removing.map((r) => r.id)]
      );
      if (used.length) {
        await conn.rollback();
        return { blocked: used.map((r) => r.name) };
      }
      await conn.query('DELETE FROM rooms WHERE id IN (?)', [removing.map((r) => r.id)]);
    }

    for (const [i, r] of rooms.entries()) {
      const id = r.id || uid();
      await conn.query(
        `INSERT INTO rooms (id, name, type, default_price, note, sort_order)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), type=VALUES(type),
           default_price=VALUES(default_price), note=VALUES(note), sort_order=VALUES(sort_order)`,
        [id, r.name, r.type, r.defaultPrice, r.note, i]
      );
    }
    await conn.commit();
    return { blocked: [] };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Thay toàn bộ danh sách lễ tân.
 * Trả về { blocked: [tên] } nếu có người bị xoá mà đã có ngày chấm công —
 * giữ lại để không mất lịch sử lương.
 */
async function saveStaff(staff) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query('SELECT id, name FROM staff FOR UPDATE');
    const keep = new Set(staff.map((s) => s.id).filter(Boolean));
    const removing = existing.filter((s) => !keep.has(s.id));

    if (removing.length) {
      const [used] = await conn.query(
        `SELECT DISTINCT s.name FROM staff s JOIN housekeeping_days h ON h.staff_id = s.id
         WHERE s.id IN (?)`, [removing.map((s) => s.id)]
      );
      if (used.length) {
        await conn.rollback();
        return { blocked: used.map((s) => s.name) };
      }
      await conn.query('DELETE FROM staff WHERE id IN (?)', [removing.map((s) => s.id)]);
    }

    for (const [i, s] of staff.entries()) {
      await conn.query(
        `INSERT INTO staff (id, name, phone, note, sort_order) VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone),
           note=VALUES(note), sort_order=VALUES(sort_order)`,
        [s.id || uid(), s.name, s.phone, s.note, i]
      );
    }
    await conn.commit();
    return { blocked: [] };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function saveAreas(areas) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query('SELECT id FROM areas FOR UPDATE');
    const keep = new Set(areas.map((a) => a.id).filter(Boolean));
    const removing = existing.filter((a) => !keep.has(a.id)).map((a) => a.id);
    if (removing.length) await conn.query('DELETE FROM areas WHERE id IN (?)', [removing]);

    for (const [i, a] of areas.entries()) {
      await conn.query(
        `INSERT INTO areas (id, name, note, sort_order) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), note=VALUES(note), sort_order=VALUES(sort_order)`,
        [a.id || uid(), a.name, a.note, i]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Thêm hoặc sửa đặt phòng, kiểm tra trùng lịch ngay trong transaction
 * nên hai người đặt cùng lúc cũng không thể chèn trùng.
 * Trả về { conflict } nếu trùng, ngược lại { booking }.
 */
async function upsertBooking(b, existingId = null) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [clash] = await conn.query(
      `SELECT id, check_in_date, check_out_date FROM bookings
       WHERE room_id = ? AND check_in_date < ? AND ? < check_out_date AND id <> ?
       LIMIT 1 FOR UPDATE`,
      [b.roomId, b.toDate, b.fromDate, existingId || '']
    );
    if (clash.length) {
      await conn.rollback();
      return { conflict: { fromDate: clash[0].check_in_date, toDate: clash[0].check_out_date } };
    }

    const id = existingId || uid();
    if (existingId) {
      const [res] = await conn.query(
        `UPDATE bookings SET room_id=?, check_in_date=?, check_out_date=?, check_in_time=?, check_out_time=?,
          price=?, deposit=?, paid=?, paid_until=?, guest_name=?, guest_phone=?, note=? WHERE id=?`,
        [b.roomId, b.fromDate, b.toDate, b.checkinTime, b.checkoutTime, b.price, b.deposit,
        b.paid ? 1 : 0, b.paidUntil || null, b.guestName, b.guestPhone, b.note, id]
      );
      if (res.affectedRows === 0) {
        await conn.rollback();
        return { notFound: true };
      }
    } else {
      await conn.query(
        `INSERT INTO bookings (id, room_id, check_in_date, check_out_date, check_in_time, check_out_time,
           price, deposit, paid, paid_until, guest_name, guest_phone, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, b.roomId, b.fromDate, b.toDate, b.checkinTime, b.checkoutTime, b.price, b.deposit,
         b.paid ? 1 : 0, b.paidUntil || null, b.guestName, b.guestPhone, b.note]
      );
    }

    const [rows] = await conn.query('SELECT * FROM bookings WHERE id = ?', [id]);
    await conn.commit();
    return { booking: toBooking(rows[0]) };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function deleteBooking(id) {
  const [res] = await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  return res.affectedRows > 0;
}

/** Lưu ghi nhận lễ tân của một ngày. Bản ghi rỗng thì xoá luôn khỏi bảng. */
async function saveHousekeeping(date, rec) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const empty = rec.roomIds.length === 0 && rec.areaIds.length === 0 &&
      !rec.staffId && !rec.note && !rec.paid && !rec.salary;

    if (empty) {
      await conn.query('DELETE FROM housekeeping_days WHERE hk_date = ?', [date]); // CASCADE xoá chi tiết
      await conn.commit();
      return { rooms: {}, areas: {}, staffId: '', note: '', paid: false, salary: 0 };
    }

    await conn.query(
      `INSERT INTO housekeeping_days (hk_date, staff_id, note, paid, salary) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE staff_id=VALUES(staff_id), note=VALUES(note),
         paid=VALUES(paid), salary=VALUES(salary)`,
      [date, rec.staffId || null, rec.note, rec.paid ? 1 : 0, rec.salary]
    );

    await conn.query('DELETE FROM housekeeping_rooms WHERE hk_date = ?', [date]);
    await conn.query('DELETE FROM housekeeping_areas WHERE hk_date = ?', [date]);
    if (rec.roomIds.length) {
      await conn.query('INSERT INTO housekeeping_rooms (hk_date, room_id) VALUES ?',
        [rec.roomIds.map((id) => [date, id])]);
    }
    if (rec.areaIds.length) {
      await conn.query('INSERT INTO housekeeping_areas (hk_date, area_id) VALUES ?',
        [rec.areaIds.map((id) => [date, id])]);
    }
    await conn.commit();

    return {
      rooms: Object.fromEntries(rec.roomIds.map((id) => [id, true])),
      areas: Object.fromEntries(rec.areaIds.map((id) => [id, true])),
      staffId: rec.staffId, note: rec.note, paid: rec.paid, salary: rec.salary,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* ------------------------------------------------------------------ */
/* Tài khoản đăng nhập & phiên làm việc                                */
/* ------------------------------------------------------------------ */

const toUser = (u) => ({
  id: u.id, username: u.username, displayName: u.display_name, role: u.role || 'admin',
});

async function countUsers() {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users');
  return Number(n);
}

async function listUsers() {
  const [rows] = await pool.query('SELECT * FROM users ORDER BY created_at');
  return rows.map(toUser);
}

async function findUserByUsername(username) {
  const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
  return rows[0] || null;
}

async function createUser({ username, displayName, passwordHash, role = 'viewer' }) {
  const id = uid();
  await pool.query(
    'INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?,?,?,?,?)',
    [id, username, displayName, passwordHash, role]
  );
  return { id, username, displayName, role };
}

async function deleteUser(id) {
  const [res] = await pool.query('DELETE FROM users WHERE id = ?', [id]);
  return res.affectedRows > 0;
}

async function setUserRole(id, role) {
  const [res] = await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  return res.affectedRows > 0;
}

async function setPassword(id, passwordHash) {
  const [res] = await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  return res.affectedRows > 0;
}

async function getUserById(id) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

async function createSession(tokenHash, userId, days) {
  await pool.query(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))',
    [tokenHash, userId, days]
  );
}

/** Trả về người dùng của phiên còn hạn, hoặc null. */
async function userForSession(tokenHash) {
  const [rows] = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > NOW()`,
    [tokenHash]
  );
  return rows[0] ? toUser(rows[0]) : null;
}

async function deleteSession(tokenHash) {
  await pool.query('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
}

/** Đăng xuất mọi thiết bị của một tài khoản (dùng khi đổi mật khẩu). */
async function deleteSessionsOfUser(userId, exceptTokenHash = null) {
  if (exceptTokenHash) {
    await pool.query('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [userId, exceptTokenHash]);
  } else {
    await pool.query('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
}

async function purgeExpiredSessions() {
  const [res] = await pool.query('DELETE FROM sessions WHERE expires_at <= NOW()');
  return res.affectedRows;
}

async function close() {
  if (pool) await pool.end();
}

module.exports = {
  init, close, config: cfg,
  getAllData, getRooms, getAreas, getStaff, roomExists, getRoomName,
  saveSettings, saveRooms, saveAreas, saveStaff, upsertBooking, deleteBooking, saveHousekeeping,
  DEFAULT_CLEANING_RATE,
  // tài khoản & phiên đăng nhập
  countUsers, listUsers, findUserByUsername, createUser, deleteUser, setUserRole, setPassword, getUserById,
  createSession, userForSession, deleteSession, deleteSessionsOfUser, purgeExpiredSessions,
};
