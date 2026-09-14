'use strict';

/**
 * Đặt lại mật khẩu cho một tài khoản, dùng khi quên mật khẩu.
 * Chạy trực tiếp trên máy chủ nên bỏ qua quy định độ dài tối thiểu của API.
 *
 *   node set-password.js <tên-đăng-nhập> <mật-khẩu-mới>
 *
 * Nếu tài khoản chưa có thì sẽ được tạo mới.
 */

const db = require('./db');
const auth = require('./auth');

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error('\n  Cách dùng:  node set-password.js <tên-đăng-nhập> <mật-khẩu-mới>\n');
  process.exit(1);
}

(async () => {
  await db.init();
  const existing = await db.findUserByUsername(username.toLowerCase());

  if (existing) {
    await db.setPassword(existing.id, auth.hashPassword(password));
    await db.deleteSessionsOfUser(existing.id);   // buộc đăng nhập lại ở mọi thiết bị
    console.log(`\n  Đã đổi mật khẩu cho "${username}". Mọi thiết bị phải đăng nhập lại.\n`);
  } else {
    await db.createUser({
      username: username.toLowerCase(),
      displayName: username,
      passwordHash: auth.hashPassword(password),
      role: 'admin',
    });
    console.log(`\n  Đã tạo tài khoản "${username}".\n`);
  }

  if (password.length < 6) {
    console.log('  Lưu ý: mật khẩu này ngắn, chỉ nên dùng khi app chạy trong mạng nội bộ.\n');
  }
  await db.close();
})().catch((err) => {
  console.error('\n  Lỗi:', err.message, '\n');
  process.exit(1);
});
