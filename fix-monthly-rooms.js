'use strict';

const mysql = require('mysql2/promise');
const db = require('./db');

const ROOM_ORDER = ['101', '201', '202', '203', '204', '301', '303'];

function overlaps(a, b) {
  return a.fromDate < b.toDate && b.fromDate < a.toDate;
}

async function main() {
  await db.init();
  const connection = await mysql.createConnection({ ...db.config, dateStrings: true });
  try {
    const [rooms] = await connection.query('SELECT id, name FROM rooms');
    const roomIdByKey = new Map();
    const roomKeyById = new Map();
    for (const room of rooms) {
      const match = room.name.match(/\b(10[1]|20[1-4]|30[13])\b/);
      const key = match ? match[1] : room.name;
      roomIdByKey.set(key, room.id);
      roomKeyById.set(room.id, key);
    }
    const roomKeys = [
      ...ROOM_ORDER.filter((key) => roomIdByKey.has(key)),
      ...rooms.map((room) => roomKeyById.get(room.id)).filter((key) => !ROOM_ORDER.includes(key)),
    ];

    const [rows] = await connection.query('SELECT * FROM bookings ORDER BY check_in_date, check_out_date, id');
    const bookings = rows.map((row) => ({
      row,
      id: row.id,
      roomKey: roomKeyById.get(row.room_id),
      fromDate: String(row.check_in_date).slice(0, 10),
      toDate: String(row.check_out_date).slice(0, 10),
    }));
    const targets = bookings.filter((booking) =>
      (booking.row.guest_name === 'Thuê tháng Sherry' && booking.fromDate === '2026-09-06') ||
      (booking.row.guest_name === 'thuê tháng Kristof' && booking.fromDate === '2026-08-01')
    );
    if (targets.length !== 3) {
      throw new Error(`Tìm thấy ${targets.length}/3 bản ghi thuê tháng cần sửa`);
    }

    const desired = new Map();
    for (const target of targets) {
      if (target.row.guest_name === 'Thuê tháng Sherry') desired.set(target.id, '202');
      else desired.set(target.id, target.row.note.includes('P303') ? '303' : '203');
    }

    const targetIds = new Set(targets.map((target) => target.id));
    const assigned = [];
    for (const booking of bookings) {
      if (targetIds.has(booking.id)) continue;
      assigned.push({ ...booking });
    }
    for (const target of targets) {
      assigned.push({ ...target, roomKey: desired.get(target.id) });
    }

    const changes = [];
    const nonTargets = assigned
      .filter((booking) => !targetIds.has(booking.id))
      .sort((a, b) => a.fromDate.localeCompare(b.fromDate) || a.toDate.localeCompare(b.toDate));
    const reservedTargets = assigned.filter((booking) => targetIds.has(booking.id));
    const placed = [...reservedTargets];

    for (const booking of nonTargets) {
      const roomBusy = (roomKey) => placed.some((other) =>
        other.roomKey === roomKey && overlaps(booking, other)
      );
      let roomKey = booking.roomKey;
      if (!roomKey || roomBusy(roomKey)) {
        roomKey = roomKeys.find((candidate) => !roomBusy(candidate));
      }
      if (!roomKey) throw new Error(`Không còn phòng trống cho ${booking.row.guest_name}`);
      if (roomKey !== booking.roomKey) changes.push({ booking, roomKey });
      placed.push({ ...booking, roomKey });
    }

    await connection.beginTransaction();
    for (const target of targets) {
      await connection.query('UPDATE bookings SET room_id = ? WHERE id = ?', [roomIdByKey.get(desired.get(target.id)), target.id]);
    }
    for (const change of changes) {
      await connection.query('UPDATE bookings SET room_id = ? WHERE id = ?', [roomIdByKey.get(change.roomKey), change.booking.id]);
    }
    await connection.commit();

    console.log(`Đã gán đúng phòng cho ${targets.length} bản ghi thuê tháng.`);
    console.log(`Đã chuyển ${changes.length} lịch khác để tránh trùng phòng.`);
    for (const target of targets) console.log(`  - ${target.row.guest_name}: P${desired.get(target.id)}`);
  } catch (error) {
    try { await connection.rollback(); } catch { /* transaction may not have started */ }
    throw error;
  } finally {
    await connection.end();
    await db.close();
  }
}

main().catch((error) => {
  console.error('Không sửa được phòng thuê tháng:', error.message);
  process.exitCode = 1;
});
