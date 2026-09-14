-- =====================================================================
--  Quản lý khách sạn — cấu trúc bảng MariaDB
--  File này được server.js tự chạy khi khởi động, không cần chạy tay.
--  Muốn xem/sửa bằng tay:  mysql -u root -p hotel < schema.sql
-- =====================================================================

-- Cài đặt chung (tên khách sạn...)
CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(50)  NOT NULL PRIMARY KEY,
  v TEXT         NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Danh sách phòng
CREATE TABLE IF NOT EXISTS rooms (
  id            VARCHAR(40)  NOT NULL PRIMARY KEY,
  name          VARCHAR(60)  NOT NULL,
  type          VARCHAR(60)  NOT NULL DEFAULT '',
  default_price BIGINT       NOT NULL DEFAULT 0,
  note          VARCHAR(200) NOT NULL DEFAULT '',
  sort_order    INT          NOT NULL DEFAULT 0,
  INDEX idx_rooms_order (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Khu vực chung: nhà xe, hành lang tầng 1, sảnh...
CREATE TABLE IF NOT EXISTS areas (
  id         VARCHAR(40)  NOT NULL PRIMARY KEY,
  name       VARCHAR(80)  NOT NULL,
  note       VARCHAR(200) NOT NULL DEFAULT '',
  sort_order INT          NOT NULL DEFAULT 0,
  INDEX idx_areas_order (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tài khoản đăng nhập vào app
CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(40)  NOT NULL PRIMARY KEY,
  username      VARCHAR(50)  NOT NULL UNIQUE,
  display_name  VARCHAR(100) NOT NULL DEFAULT '',
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'admin',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phiên đăng nhập. Chỉ lưu bản băm của token, lộ database cũng không mạo danh được.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64)    NOT NULL PRIMARY KEY,
  user_id    VARCHAR(40) NOT NULL,
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME    NOT NULL,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Danh sách lễ tân / nhân viên dọn dẹp
CREATE TABLE IF NOT EXISTS staff (
  id         VARCHAR(40)  NOT NULL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  phone      VARCHAR(30)  NOT NULL DEFAULT '',
  note       VARCHAR(200) NOT NULL DEFAULT '',
  sort_order INT          NOT NULL DEFAULT 0,
  INDEX idx_staff_order (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Đặt phòng. Phòng bị chiếm từ check_in_date đến TRƯỚC check_out_date (tính theo đêm).
-- Lưu ý: không đặt tên cột là `to_date` — MariaDB 12.3 có hàm TO_DATE() nên đó là từ khoá.
CREATE TABLE IF NOT EXISTS bookings (
  id             VARCHAR(40)  NOT NULL PRIMARY KEY,
  room_id        VARCHAR(40)  NOT NULL,
  check_in_date  DATE         NOT NULL,
  check_out_date DATE         NOT NULL,
  check_in_time  VARCHAR(5)   NOT NULL DEFAULT '',
  check_out_time VARCHAR(5)   NOT NULL DEFAULT '',
  price          BIGINT       NOT NULL DEFAULT 0,
  deposit        BIGINT       NOT NULL DEFAULT 0,
  paid           TINYINT(1)   NOT NULL DEFAULT 0,
  paid_until     DATE         NULL,
  guest_name     VARCHAR(100) NOT NULL DEFAULT '',
  guest_phone    VARCHAR(30)  NOT NULL DEFAULT '',
  note           VARCHAR(500) NOT NULL DEFAULT '',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_bookings_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT,
  CONSTRAINT chk_bookings_dates CHECK (check_out_date > check_in_date),
  INDEX idx_bookings_room_dates (room_id, check_in_date, check_out_date),
  INDEX idx_bookings_dates (check_in_date, check_out_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ghi nhận công việc lễ tân theo từng ngày.
-- staff_id trỏ tới bảng staff; RESTRICT để không xoá mất lịch sử chấm công.
CREATE TABLE IF NOT EXISTS housekeeping_days (
  hk_date  DATE        NOT NULL PRIMARY KEY,
  staff_id VARCHAR(40) NULL,
  note     VARCHAR(500) NOT NULL DEFAULT '',
  paid     TINYINT(1)  NOT NULL DEFAULT 0,
  salary   BIGINT      NOT NULL DEFAULT 0,
  CONSTRAINT fk_hkdays_staff FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT,
  INDEX idx_hkdays_staff (staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Các phòng đã dọn trong ngày
CREATE TABLE IF NOT EXISTS housekeeping_rooms (
  hk_date DATE        NOT NULL,
  room_id VARCHAR(40) NOT NULL,
  PRIMARY KEY (hk_date, room_id),
  CONSTRAINT fk_hkrooms_day  FOREIGN KEY (hk_date) REFERENCES housekeeping_days(hk_date) ON DELETE CASCADE,
  CONSTRAINT fk_hkrooms_room FOREIGN KEY (room_id) REFERENCES rooms(id)                  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Các khu vực chung đã dọn trong ngày
CREATE TABLE IF NOT EXISTS housekeeping_areas (
  hk_date DATE        NOT NULL,
  area_id VARCHAR(40) NOT NULL,
  PRIMARY KEY (hk_date, area_id),
  CONSTRAINT fk_hkareas_day  FOREIGN KEY (hk_date) REFERENCES housekeeping_days(hk_date) ON DELETE CASCADE,
  CONSTRAINT fk_hkareas_area FOREIGN KEY (area_id) REFERENCES areas(id)                  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
