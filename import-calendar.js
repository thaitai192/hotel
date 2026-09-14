'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const db = require('./db');

const ICS_FILE = path.join(__dirname, 'data', 'Calendar.ics');
const IMPORT_FROM = '2026-06-01';
const ROOM_ORDER = ['101', '201', '202', '203', '204', '301', '303'];

function unescapeIcs(value) {
  return String(value || '')
    .replace(/\\N/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function unfoldIcs(text) {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

function parseEvents(text) {
  const events = [];
  let current = null;
  let nestedComponent = false;
  for (const line of unfoldIcs(text)) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('BEGIN:') && line !== 'BEGIN:VEVENT') {
      nestedComponent = true;
      continue;
    }
    if (line.startsWith('END:') && line !== 'END:VEVENT') {
      nestedComponent = false;
      continue;
    }
    if (nestedComponent) continue;
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).split(';', 1)[0];
    current[key] = unescapeIcs(line.slice(colon + 1));
  }
  return events;
}

function parseDate(value) {
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function parseMoney(value) {
  const text = String(value || '').toLowerCase().replace(/\s+/g, ' ');
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(m|tr(?:iệu)?|k)?/i);
  if (!match) return 0;
  const number = Number(match[1].replace(',', '.'));
  const unit = match[2] || '';
  if (/^k$/i.test(unit)) return Math.round(number * 1000);
  if (/^(m|tr)/i.test(unit)) return Math.round(number * 1000000);
  return Math.round(number);
}

function firstMoney(text) {
  const match = String(text || '').match(/\d+(?:[.,]\d+)?\s*(?:m|tr(?:iệu)?|k)/i);
  return match ? parseMoney(match[0]) : 0;
}

function bookingId(uid, roomNumber) {
  const digest = crypto.createHash('sha256').update(`${uid}:${roomNumber}`).digest('hex').slice(0, 36);
  return `ics-${digest}`;
}

function parseFinancials(description) {
  const text = String(description || '').replace(/\r/g, '').trim();
  const depositMatch = text.match(/cọc\s*(\d+(?:[.,]\d+)?\s*(?:m|tr(?:iệu)?|k)?)/i);
  const deposit = depositMatch ? parseMoney(depositMatch[1]) : 0;
  const price = firstMoney(text);
  const paid = /đã\s*(?:trả|thu)|đã trả/i.test(text);
  let note = text
    .replace(/(?:đã\s*)?cọc\s*\d+(?:[.,]\d+)?\s*(?:m|tr(?:iệu)?|k)?/gi, '')
    .replace(/\d+(?:[.,]\d+)?\s*(?:m|tr(?:iệu)?|k)/gi, '')
    .replace(/đã\s*(?:trả|thu)/gi, '')
    .replace(/\s*;\s*/g, '; ')
    .replace(/^[;,.\s]+|[;,.\s]+$/g, '')
    .replace(/;\s*;/g, ';');
  return { price, deposit, paid, note };
}

function roomTokens(summary) {
  return [...String(summary || '').matchAll(/P?(10[1]|20[1-4]|30[13])/gi)]
    .map((match) => match[1]);
}

function guestName(summary, rooms) {
  let name = String(summary || '');
  for (const room of rooms) name = name.replace(new RegExp(`\\(?P?${room}`, 'i'), '');
  return name
    .replace(/\s*\(?(?:booking|airbnb|zalo)\)?\s*$/i, '')
    .replace(/^[-:,\s()]+|[-:,\s()]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function overlaps(a, b) {
  return a.fromDate < b.toDate && b.fromDate < a.toDate;
}

function chooseRoom(preferred, booking, assigned, roomIdsByNumber, roomKeys) {
  const candidates = [preferred, ...roomKeys.filter((room) => room !== preferred)];
  const roomNumber = candidates.find((number) => {
    if (!roomIdsByNumber.has(number)) return false;
    return !assigned.some((item) => item.roomNumber === number && overlaps(item, booking));
  });
  return roomNumber || null;
}

async function main() {
  if (!fs.existsSync(ICS_FILE)) throw new Error(`Không tìm thấy ${ICS_FILE}`);
  await db.init();
  const connection = await mysql.createConnection({ ...db.config, database: db.config.database });
  try {
    const [roomRows] = await connection.query('SELECT id, name FROM rooms');
    const roomIdsByNumber = new Map();
    const roomKeyById = new Map();
    for (const room of roomRows) {
      const match = room.name.match(/\b(10[1]|20[1-4]|30[13])\b/);
      const roomKey = match ? match[1] : room.name;
      roomIdsByNumber.set(roomKey, room.id);
      roomKeyById.set(room.id, roomKey);
    }
    if (!roomIdsByNumber.size) throw new Error('Không tìm thấy phòng có mã 101/201/202/203/204/301/303');

    const events = parseEvents(fs.readFileSync(ICS_FILE, 'utf8'))
      .filter((event) => parseDate(event.DTSTART) >= IMPORT_FROM && event.DTEND)
      .filter((event) => parseDate(event.DTEND) > parseDate(event.DTSTART));
    const [existingRows] = await connection.query('SELECT id, room_id, check_in_date, check_out_date FROM bookings');
    const existingIds = new Set(existingRows.map((row) => row.id));
    const roomKeys = [
      ...ROOM_ORDER.filter((room) => roomIdsByNumber.has(room)),
      ...roomRows.map((room) => roomKeyById.get(room.id)).filter((room) => !ROOM_ORDER.includes(room)),
    ];
    const assigned = existingRows.map((row) => ({
      id: row.id,
      roomNumber: roomKeyById.get(row.room_id),
      fromDate: String(row.check_in_date).slice(0, 10),
      toDate: String(row.check_out_date).slice(0, 10),
    }));

    let inserted = 0;
    let skipped = 0;
    const moved = [];
    await connection.beginTransaction();
    for (const event of events) {
      if (ROOM_ORDER.some((room) => existingIds.has(bookingId(event.UID, room)))) {
        skipped++;
        continue;
      }
      const fromDate = parseDate(event.DTSTART);
      const toDate = parseDate(event.DTEND);
      const sourceRooms = roomTokens(event.SUMMARY);
      const preferredRooms = sourceRooms.length ? [...new Set(sourceRooms)] : ['303'];
      const financials = parseFinancials(event.DESCRIPTION);
      const name = guestName(event.SUMMARY, preferredRooms);

      for (const preferred of preferredRooms) {
        const booking = { fromDate, toDate };
        const roomNumber = chooseRoom(preferred, booking, assigned, roomIdsByNumber, roomKeys);
        if (!roomNumber) throw new Error(`Không còn phòng trống cho "${event.SUMMARY}" (${fromDate} - ${toDate})`);
        const wasMoved = roomNumber !== preferred;
        const noteParts = [financials.note];
        if (wasMoved) {
          noteParts.push(`Phòng gốc: P${preferred}`);
          moved.push(`${event.SUMMARY}: P${preferred} -> P${roomNumber}`);
        }
        const note = noteParts.filter(Boolean).join('; ').slice(0, 500);
        const id = bookingId(event.UID, roomNumber);
        await connection.query(
          `INSERT INTO bookings (id, room_id, check_in_date, check_out_date, check_in_time, check_out_time,
             price, deposit, paid, guest_name, guest_phone, note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, roomIdsByNumber.get(roomNumber), fromDate, toDate, '', '', financials.price,
            financials.deposit, financials.paid ? 1 : 0, name, '', note]
        );
        assigned.push({ roomNumber, fromDate, toDate, id });
        inserted++;
      }
    }
    await connection.commit();
    console.log(`Đã nhập ${inserted} đặt phòng từ ${events.length} sự kiện trong Calendar.ics.`);
    if (skipped) console.log(`Bỏ qua ${skipped} bản ghi đã tồn tại.`);
    if (moved.length) {
      console.log(`Đã chuyển ${moved.length} lịch sang phòng khác vì trùng:`);
      for (const item of moved) console.log(`  - ${item}`);
    }
  } catch (error) {
    try { await connection.rollback(); } catch { /* transaction may not have started */ }
    throw error;
  } finally {
    await connection.end();
    await db.close();
  }
}

main().catch((error) => {
  console.error('Không nhập được lịch:', error.message);
  process.exitCode = 1;
});
