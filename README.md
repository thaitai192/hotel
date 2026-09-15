# 🏨 Quản lý khách sạn

Web app quản lý khách sạn nhỏ: danh sách phòng, khu vực chung, đặt phòng theo lịch tháng và theo dõi công việc lễ tân / dọn dẹp.

**Database: MariaDB** · Backend: Node.js · Frontend: HTML/CSS/JS thuần (không cần build)

Giao diện dùng tốt trên cả máy tính và **điện thoại** (đã kiểm tra ở 360px, 375px, 393px).

---

## Chạy ứng dụng

```bash
npm install        # chỉ cần chạy lần đầu
npm run check      # kiểm tra kết nối MariaDB
npm start          # chạy app
```

Mở trình duyệt tại **http://localhost:3000**. Mỗi tính năng có một đường dẫn riêng để có thể mở trực tiếp:

- Đăng nhập: `http://localhost:3000/login`
- Lễ tân: `http://localhost:3000/reception`
- Đặt phòng: `http://localhost:3000/booking`
- Cài đặt: `http://localhost:3000/settings`

Server tự trả giao diện cho các đường dẫn này, nên tải lại trang hoặc mở trực tiếp một đường dẫn vẫn giữ đúng tính năng.

Khi khởi động, server in ra cả địa chỉ để **máy khác / điện thoại trong cùng mạng** truy cập, dạng `http://192.168.x.x:3000`. Nếu thiết bị khác không vào được thì thường là tường lửa Windows chặn — mở cổng bằng lệnh sau (chạy PowerShell với quyền Administrator):

```powershell
New-NetFirewallRule -DisplayName "Quan ly khach san 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

Lần chạy đầu tiên app sẽ **tự tạo database `hotel` và toàn bộ bảng** — bạn không phải chạy file SQL nào bằng tay.

Đổi cổng web: `PORT=8080 npm start`

### Tự chạy lại sau khi khởi động Windows hoặc VS Code bị đóng

Trên Windows, mở PowerShell tại thư mục dự án và chạy một lần:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-task.ps1
```

Lệnh này tạo hai shortcut `HotelAppServer` và `HotelAppTunnel` trong thư mục Startup. Server chạy độc lập với VS Code, còn tunnel Cloudflare tự thử kết nối lại sau 5 giây nếu bị mất. Sau khi cài, có thể đóng VS Code; web vẫn chạy tại `http://localhost:3000` và `https://thefhouse.top`. Khi máy khởi động lại, sau khi đăng nhập Windows cả app và tunnel sẽ tự chạy.

### Cập nhật code lên web đang chạy

- Sửa `public/index.html`, `public/app.js` hoặc `public/styles.css`: lưu file rồi tải lại trang bằng `Ctrl+F5`.
- Sửa `server.js`, `db.js`, `auth.js` hoặc code backend: sau khi lưu, chạy PowerShell:

```powershell
$serverPid = (Get-NetTCPConnection -LocalPort 3000 -State Listen).OwningProcess
Stop-Process -Id $serverPid -Force
```

Watcher sẽ tự khởi động lại Node trong khoảng 5 giây. Sau đó tải lại `https://thefhouse.top`. Tunnel không cần restart khi chỉ cập nhật code app.

Kiểm tra shortcut tự chạy:

```powershell
Test-Path (Join-Path ([Environment]::GetFolderPath('Startup')) 'HotelAppServer.lnk')
```

Gỡ tự chạy:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-windows-task.ps1
```

---

## Cấu hình kết nối database

Sửa file [config.json](config.json):

```json
{
  "host": "127.0.0.1",
  "port": 3306,
  "user": "root",
  "password": "mật-khẩu-của-bạn",
  "database": "hotel"
}
```

Cũng có thể dùng biến môi trường (được ưu tiên hơn file): `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.

> `config.json` chứa mật khẩu nên đã được đưa vào `.gitignore`.

### Cài MariaDB (nếu máy khác chưa có)

1. Tải bản Windows tại <https://mariadb.org/download/> → chạy file `.msi`.
2. Trong lúc cài, đặt **mật khẩu cho tài khoản root** và nhớ lấy mật khẩu đó.
3. Giữ nguyên cổng mặc định **3306** và tuỳ chọn cài MariaDB làm **Windows service** (để nó tự chạy cùng máy).
4. Điền mật khẩu vừa đặt vào `config.json`, rồi chạy `npm run check`.

Vài lệnh hữu ích khi cần:

```bash
sc query MariaDB      # xem service còn chạy không
net start MariaDB     # khởi động service (cần quyền Administrator)
```

---

## Đăng nhập

App bắt buộc đăng nhập. **Lần chạy đầu tiên**, server tự tạo tài khoản `admin` với mật khẩu ngẫu nhiên và in ra màn hình trong một khung dễ thấy — hãy đăng nhập rồi **đổi mật khẩu ngay** ở tab Cài đặt.

- Mỗi người một tài khoản riêng (tạo ở tab Cài đặt), nghỉ việc thì xoá tài khoản.
- Mỗi tài khoản có một vai trò: **Admin** được xem và sửa mọi thứ; **Lễ tân** được sửa tab Lễ tân nhưng chỉ xem tab Đặt phòng và Cài đặt; **Viewer** chỉ được xem.
- Chỉ Admin mới được tạo/xoá tài khoản, sửa đặt phòng, sửa Cài đặt hoặc đổi mật khẩu.
- Đăng nhập được giữ **30 ngày** trên thiết bị đó, nên điện thoại không phải gõ lại mỗi lần.
- Đổi mật khẩu sẽ **đăng xuất các thiết bị khác** của chính tài khoản đó.
- Sai mật khẩu 8 lần thì khoá 10 phút (tính theo địa chỉ máy gọi tới).

Kỹ thuật: mật khẩu băm bằng **scrypt** với muối riêng cho từng mật khẩu; phiên đăng nhập dùng token ngẫu nhiên 32 byte mà database **chỉ lưu bản băm SHA-256**, nên lộ database cũng không mạo danh được ai. Cookie đặt `HttpOnly` + `SameSite=Lax`, và tự thêm `Secure` khi chạy qua HTTPS.

### Quên mật khẩu?

```bash
node set-password.js admin matkhaumoi
```

Lệnh này đặt lại mật khẩu cho tài khoản đã có (hoặc tạo mới nếu chưa có) và đăng xuất tài khoản đó khỏi mọi thiết bị. Vì chạy trực tiếp trên máy chủ nên nó không áp dụng quy định tối thiểu 6 ký tự như khi đổi qua giao diện.

## Các tính năng

### 1. Cài đặt
- Đặt tên khách sạn và **đơn giá dọn mỗi mục** (dùng để tự tính lương lễ tân).
- **Nhập số lượng phòng** rồi bấm *Tạo danh sách* — hệ thống sinh sẵn tên theo mẫu (ví dụ “Phòng 101” → 101, 102, 103…), sau đó sửa lại **tên từng phòng**, loại phòng và giá mặc định.
- **Danh sách lễ tân**: tên, số điện thoại, ghi chú. Những người này sẽ hiện trong ô “Lễ tân trực” ở tab Lễ tân.
- **Khu vực chung**: nhà xe, hành lang tầng 1, sảnh, thang máy… dùng cho phần lễ tân.
- Phòng đang có đặt phòng sẽ không cho xoá (tránh mất dữ liệu khách), và lễ tân đã có ngày chấm công cũng vậy (tránh mất lịch sử lương).

### 2. Đặt phòng
- Lịch theo tháng, mỗi ngày hiển thị số phòng đang thuê / tổng số phòng, số khách nhận và trả phòng trong ngày.
  - 🟢 còn trống · 🟠 còn ít phòng · 🔴 kín phòng
- **Click vào một ngày** → hiện tình trạng **từng phòng** của ngày đó: trống hay đang thuê, tên khách, **số điện thoại**, **từ ngày – tới ngày**, **giờ check-in / check-out**, **giá tiền**, tiền cọc, ghi chú.
- Bấm vào phòng đang thuê để sửa/xoá; bấm *+ Đặt phòng này* ở phòng trống để đặt nhanh.
- Chặn đặt trùng phòng trùng ngày ngay trong transaction của database, nên hai máy đặt cùng lúc cũng không thể chèn trùng.
- Quy ước tính theo đêm: phòng bị chiếm từ **ngày nhận phòng** đến **trước ngày trả phòng**.

### 3. Lễ tân
- Lịch theo tháng của công việc dọn dẹp.
- **Click vào một ngày** → **chọn lễ tân trực từ danh sách** (khai báo ở tab Cài đặt), tick các **phòng đã dọn** và **khu vực chung đã dọn**, ghi chú.
- **Tiền lương tự tính**: `(số phòng đã dọn + số khu vực chung đã dọn) × đơn giá mỗi mục`. Đơn giá đặt ở tab Cài đặt, mặc định 50.000 ₫.
  - Tick thêm/bớt thì lương tự cập nhật theo.
  - **Sửa tay được**: gõ số khác vào ô lương thì app ngừng tự tính cho ngày đó và nhớ điều này cả sau khi tải lại trang. Muốn quay về số tự tính thì bấm **Tính lại**.
- **Ô “Đã trả lương”** — ngày đã trả lương hiển thị **màu xám** trên lịch tháng.
- Cuối lịch có tổng kết tháng: đã trả lương bao nhiêu, còn nợ bao nhiêu.

---

## Cấu trúc thư mục

```
server.js        Máy chủ HTTP + REST API
db.js            Lớp truy cập MariaDB (transaction, chuyển đổi camelCase ⇄ snake_case)
schema.sql       Định nghĩa bảng — server tự chạy khi khởi động
check-db.js      Công cụ kiểm tra kết nối database
config.json      Thông tin kết nối (KHÔNG commit lên git)
public/
  index.html     Giao diện
  styles.css     Style
  app.js         Toàn bộ logic phía trình duyệt
```

## Các bảng trong database

| Bảng | Nội dung |
| --- | --- |
| `settings` | Cài đặt chung (tên khách sạn, đơn giá dọn) |
| `users` | Tài khoản đăng nhập (mật khẩu băm bằng scrypt) |
| `sessions` | Phiên đăng nhập (chỉ lưu bản băm của token) |
| `rooms` | Danh sách phòng, loại phòng, giá mặc định |
| `areas` | Khu vực chung |
| `staff` | Danh sách lễ tân (tên, sđt, ghi chú) |
| `bookings` | Đặt phòng — khoá ngoại tới `rooms`, chặn xoá phòng còn khách |
| `housekeeping_days` | Ghi nhận lễ tân theo ngày (`staff_id`, lương, đã trả lương) — khoá ngoại tới `staff` |
| `housekeeping_rooms` | Phòng đã dọn trong ngày |
| `housekeeping_areas` | Khu vực đã dọn trong ngày |

> **Lưu ý khi sửa schema:** đừng đặt tên cột là `to_date` — MariaDB 12.3 có hàm `TO_DATE()`, và với `sql_mode` mặc định (có `IGNORE_SPACE`) tên hàm trở thành từ khoá nên `CREATE TABLE` sẽ lỗi cú pháp. Vì vậy các cột ở đây tên là `check_in_date` / `check_out_date`.

## Sao lưu dữ liệu

```bash
"C:\Program Files\MariaDB 12.3\bin\mariadb-dump" -u root -p hotel > backup.sql   # sao lưu
"C:\Program Files\MariaDB 12.3\bin\mariadb" -u root -p hotel < backup.sql        # phục hồi
```

## API

| Method | Đường dẫn | Mô tả |
| --- | --- | --- |
| GET | `/api/data` | Lấy toàn bộ dữ liệu |
| PUT | `/api/settings` | Đổi tên khách sạn |
| PUT | `/api/rooms` | Lưu danh sách phòng |
| PUT | `/api/areas` | Lưu danh sách khu vực chung |
| PUT | `/api/staff` | Lưu danh sách lễ tân |
| POST | `/api/login` | Đăng nhập (không cần phiên) |
| POST | `/api/logout` | Đăng xuất thiết bị hiện tại |
| GET | `/api/me` | Tài khoản đang đăng nhập |
| GET | `/api/users` | Danh sách tài khoản |
| POST | `/api/users` | Tạo tài khoản |
| DELETE | `/api/users/:id` | Xoá tài khoản |
| PUT | `/api/password` | Đổi mật khẩu của chính mình |
| POST | `/api/bookings` | Tạo đặt phòng |
| PUT | `/api/bookings/:id` | Sửa đặt phòng |
| DELETE | `/api/bookings/:id` | Xoá đặt phòng |
| PUT | `/api/housekeeping/:date` | Lưu ghi nhận lễ tân của một ngày (`YYYY-MM-DD`) |

> Mọi endpoint trừ `/api/login` đều trả về **401** nếu chưa đăng nhập.

## Nâng cấp database tự động

Khi khởi động, app tự so schema hiện có với `schema.sql` và vá phần thiếu. Cụ thể, bản trước lưu tên lễ tân dạng chữ ngay trong `housekeeping_days.staff`; bản này tách ra bảng `staff` riêng. App sẽ tự gom các tên đang có thành bản ghi lễ tân, nối lại bằng `staff_id`, rồi bỏ cột chữ cũ — **không mất dữ liệu, không phải làm gì bằng tay**.

## Chuyển từ bản cũ dùng file JSON

Nếu còn file `data.json` từ phiên bản trước, lần khởi động đầu tiên app sẽ **tự nạp toàn bộ dữ liệu vào MariaDB** rồi đổi tên file cũ thành `data.json.imported-<thời-điểm>` để khỏi nạp lại.
