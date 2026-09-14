'use strict';

/**
 * Kiểm tra kết nối MariaDB trước khi chạy app.
 *   node check-db.js       (hoặc: npm run check)
 */

const mysql = require('mysql2/promise');
const db = require('./db');

const c = db.config;

(async () => {
  console.log('\n  Đang thử kết nối MariaDB...');
  console.log(`  Máy chủ : ${c.host}:${c.port}`);
  console.log(`  Tài khoản: ${c.user}`);
  console.log(`  Database : ${c.database}`);
  console.log(`  Mật khẩu : ${c.password ? '(đã đặt)' : '(để trống)'}\n`);

  let conn;
  try {
    conn = await mysql.createConnection({
      host: c.host, port: c.port, user: c.user, password: c.password,
      connectTimeout: 5000,
    });
  } catch (err) {
    console.error('  ✗ KHÔNG KẾT NỐI ĐƯỢC\n');
    if (err.code === 'ECONNREFUSED') {
      console.error(`  Không có gì đang lắng nghe ở ${c.host}:${c.port}.`);
      console.error('  → MariaDB chưa cài, hoặc service chưa chạy.');
      console.error('  → Kiểm tra service:   sc query MariaDB');
      console.error('  → Khởi động service:  net start MariaDB   (cần quyền Administrator)');
    } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error(`  MariaDB từ chối tài khoản "${c.user}" — sai mật khẩu.`);
      console.error('  → Sửa lại "password" trong file config.json');
    } else if (err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
      console.error(`  Không tìm thấy máy chủ "${c.host}".`);
      console.error('  → Kiểm tra lại "host" trong config.json');
    } else {
      console.error('  ' + err.message);
    }
    console.error('');
    process.exit(1);
  }

  const [[ver]] = await conn.query('SELECT VERSION() AS v');
  console.log(`  ✓ Kết nối thành công — ${ver.v}`);

  const [dbs] = await conn.query('SHOW DATABASES LIKE ?', [c.database]);
  if (dbs.length === 0) {
    console.log(`  • Database "${c.database}" chưa có — server sẽ tự tạo khi khởi động.`);
  } else {
    await conn.changeUser({ database: c.database });
    const [tables] = await conn.query('SHOW TABLES');
    console.log(`  ✓ Database "${c.database}" đã có, ${tables.length} bảng.`);
    if (tables.length) {
      for (const t of tables) {
        const name = Object.values(t)[0];
        const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
        console.log(`      ${name.padEnd(20)} ${n} dòng`);
      }
    }
  }

  await conn.end();
  console.log('\n  Sẵn sàng. Chạy app bằng:  npm start\n');
})();
