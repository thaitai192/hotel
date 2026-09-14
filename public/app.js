'use strict';

/* ================================================================
   Trạng thái
   ================================================================ */

const state = {
  user: null,      // người đang đăng nhập
  users: [],       // danh sách tài khoản (tab Cài đặt)
  data: { hotelName: '', cleaningRate: 50000, rooms: [], areas: [], staff: [], bookings: [], housekeeping: {} },
  bkMonth: startOfMonth(new Date()),
  hkMonth: startOfMonth(new Date()),
  bkSelected: null,   // 'YYYY-MM-DD'
  hkSelected: null,
  hkDraft: null,      // bản nháp của ngày đang chọn ở tab Lễ tân
  hkDirty: false,
};

const $ = (id) => document.getElementById(id);

const TAB_PATHS = {
  booking: '/booking',
  housekeeping: '/reception',
  settings: '/settings',
};

const canEditBooking = () => state.user?.role === 'admin';
const canEditHousekeeping = () => ['admin', 'receptionist'].includes(state.user?.role);
const canEditSettings = () => state.user?.role === 'admin';

function roleLabel(role) {
  return role === 'admin' ? 'Admin' : role === 'receptionist' ? 'Lễ tân' : 'Viewer';
}

function tabFromPath(pathname) {
  const path = pathname.replace(/\/$/, '') || '/';
  if (path === '/booking') return 'booking';
  if (path === '/settings') return 'settings';
  if (path === '/reception' || path === '/') return 'housekeeping';
  return null;
}

function navigateTo(path, replace = false) {
  if (window.location.pathname === path) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
}

/* ================================================================
   Tiện ích ngày tháng (dùng giờ địa phương, không lệch múi giờ)
   ================================================================ */

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Thứ trong tuần, 0 = Thứ Hai … 6 = Chủ Nhật */
function weekIndex(d) { return (d.getDay() + 6) % 7; }

function nightsBetween(from, to) {
  return Math.round((parseYmd(to) - parseYmd(from)) / 86400000);
}

function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

const TODAY = ymd(new Date());

function formatDayLong(s) {
  const d = parseYmd(s);
  const names = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
  return `${names[d.getDay()]}, ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

const money = (n) => Number(n || 0).toLocaleString('vi-VN');

/* ================================================================
   Gọi API
   ================================================================ */

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (res.status === 401 && url !== '/api/login' && url !== '/api/me') {
    // Phiên hết hạn giữa chừng — quay về màn hình đăng nhập
    showLogin();
    throw new Error('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
  }
  if (!res.ok) throw new Error(json.error || 'Lỗi kết nối máy chủ');
  return json;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ================================================================
   Truy vấn dữ liệu
   ================================================================ */

const roomById = (id) => state.data.rooms.find((r) => r.id === id);

const staffById = (id) => state.data.staff.find((s) => s.id === id);

const staffName = (id) => (staffById(id) || {}).name || '';

/** Các đặt phòng chiếm đêm `date` (nhận phòng <= date < trả phòng). */
function bookingsOn(date) {
  return state.data.bookings.filter((b) => b.fromDate <= date && date < b.toDate);
}

/** Các đặt phòng trả phòng đúng ngày `date`. */
function checkoutsOn(date) {
  return state.data.bookings.filter((b) => b.toDate === date);
}

function occupancyOn(date) {
  const total = state.data.rooms.length;
  const used = new Set(bookingsOn(date).map((b) => b.roomId)).size;
  return { total, used, free: total - used };
}

function bookingMonthStats(month) {
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  let occupiedNights = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const date = ymd(new Date(month.getFullYear(), month.getMonth(), day));
    const dailyBookings = bookingsOn(date);
    occupiedNights += new Set(dailyBookings.map((b) => b.roomId)).size;
  }

  const availableNights = state.data.rooms.length * daysInMonth;
  const monthStart = ymd(new Date(month.getFullYear(), month.getMonth(), 1));
  const monthEnd = ymd(new Date(month.getFullYear(), month.getMonth() + 1, 1));
  const revenue = state.data.bookings.reduce((sum, booking) => {
    const overlapStart = booking.fromDate > monthStart ? booking.fromDate : monthStart;
    const overlapEnd = booking.toDate < monthEnd ? booking.toDate : monthEnd;
    if (overlapStart >= overlapEnd) return sum;

    const bookingNights = nightsBetween(booking.fromDate, booking.toDate) || 1;
    const monthNights = nightsBetween(overlapStart, overlapEnd);
    return sum + (booking.price / bookingNights) * monthNights;
  }, 0);

  return {
    occupancy: availableNights ? Math.round((occupiedNights / availableNights) * 100) : 0,
    revenue: Math.round(revenue),
  };
}

function hkOn(date) {
  return state.data.housekeeping[date] || null;
}

/* ================================================================
   Lịch tháng dùng chung
   ================================================================ */

/**
 * @param {HTMLElement} container
 * @param {Date} month
 * @param {string|null} selected
 * @param {(date:string, cell:HTMLElement)=>void} decorate
 * @param {(date:string)=>void} onPick
 */
function renderCalendar(container, month, selected, decorate, onPick) {
  container.textContent = '';
  const first = startOfMonth(month);
  const lead = weekIndex(first);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((lead + daysInMonth) / 7) * 7;

  const frag = document.createDocumentFragment();
  for (let i = 0; i < cells; i++) {
    const d = new Date(first);
    d.setDate(1 - lead + i);
    const date = ymd(d);
    const inMonth = d.getMonth() === month.getMonth();

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'day' + (inMonth ? '' : ' outside') + (date === TODAY ? ' today' : '') +
      (date === selected ? ' selected' : '');
    cell.dataset.date = date;

    const num = document.createElement('span');
    num.className = 'day-num';
    num.textContent = d.getDate();
    cell.appendChild(num);

    decorate(date, cell, inMonth);
    cell.addEventListener('click', () => onPick(date));
    frag.appendChild(cell);
  }
  container.appendChild(frag);
}

function monthLabel(m) {
  return `Tháng ${m.getMonth() + 1}/${m.getFullYear()}`;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

/* ================================================================
   TAB ĐẶT PHÒNG
   ================================================================ */

function renderBookingCalendar() {
  $('bkMonthLabel').textContent = monthLabel(state.bkMonth);
  const monthStats = bookingMonthStats(state.bkMonth);
  $('bkMonthSummary').replaceChildren(
    makeStat(`${monthStats.occupancy}%`, 'lấp đầy tháng'),
    makeStat(`${money(monthStats.revenue)} ₫`, 'doanh thu tháng')
  );
  renderCalendar($('bkCalendar'), state.bkMonth, state.bkSelected, (date, cell, inMonth) => {
    if (!inMonth) return;
    const { total, used, free } = occupancyOn(date);
    if (total === 0) return;

    const statusClass = free >= 4 ? 'status-free' : free <= 1 ? 'status-full' : 'status-partial';
    cell.classList.add(statusClass);
    const badge = el('span', 'day-badge', `${used}/${total}`);
    badge.classList.add(statusClass.replace('status-', 'badge-'));
    cell.appendChild(badge);

    if (free > 0 && used > 0) cell.appendChild(el('span', 'day-sub', `còn ${free} phòng`));
    else if (used === 0) cell.appendChild(el('span', 'day-sub', 'trống hết'));
    else cell.appendChild(el('span', 'day-sub', 'kín phòng'));

    const outs = checkoutsOn(date).length;
    const ins = state.data.bookings.filter((b) => b.fromDate === date).length;
    if (ins || outs) {
      const flags = [];
      if (ins) flags.push(`↓${ins} nhận`);
      if (outs) flags.push(`↑${outs} trả`);
      cell.appendChild(el('span', 'day-flag', flags.join('  ')));
    }

    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = `${total ? (used / total) * 100 : 0}%`;
    bar.appendChild(fill);
    cell.appendChild(bar);
  }, selectBookingDay);
}

function selectBookingDay(date) {
  state.bkSelected = date;
  const d = parseYmd(date);
  if (d.getMonth() !== state.bkMonth.getMonth() || d.getFullYear() !== state.bkMonth.getFullYear()) {
    state.bkMonth = startOfMonth(d);
  }
  renderBookingCalendar();
  renderBookingDay();
}

function renderBookingDay() {
  const date = state.bkSelected;
  const list = $('bkRoomList');
  const summary = $('bkDaySummary');
  list.textContent = '';
  summary.textContent = '';
  summary.className = 'muted';

  if (!date) {
    $('bkDayTitle').textContent = 'Chọn một ngày';
    $('bkAddBtn').hidden = true;
    $('bkAddBtn').disabled = true;
    summary.textContent = 'Bấm vào một ngày trên lịch để xem tình trạng từng phòng.';
    return;
  }

  $('bkDayTitle').textContent = formatDayLong(date);
  $('bkAddBtn').hidden = state.data.rooms.length === 0;
  $('bkAddBtn').disabled = !canEditBooking();

  if (state.data.rooms.length === 0) {
    summary.textContent = 'Chưa có phòng nào. Vào tab Cài đặt để nhập danh sách phòng.';
    return;
  }

  const { total, used, free } = occupancyOn(date);
  const revenue = bookingsOn(date).reduce((sum, b) => {
    const n = nightsBetween(b.fromDate, b.toDate) || 1;
    return sum + b.price / n;
  }, 0);

  summary.className = 'day-summary-box';
  summary.append(
    makeStat(String(used), 'đang thuê'),
    makeStat(String(free), 'còn trống'),
    makeStat(`${total ? Math.round((used / total) * 100) : 0}%`, 'lấp đầy'),
    makeStat(money(Math.round(revenue)), 'doanh thu đêm (₫)')
  );

  const occupiedBy = new Map(bookingsOn(date).map((b) => [b.roomId, b]));
  const checkoutBy = new Map(checkoutsOn(date).map((b) => [b.roomId, b]));

  for (const room of state.data.rooms) {
    const booking = occupiedBy.get(room.id);
    const paidUntil = booking?.paidUntil || (booking?.paid ? booking.toDate : '');
    const paymentClass = booking ? (paidUntil && date <= paidUntil ? 'paid' : 'unpaid') : 'vacant';
    const card = el('div', `room-card ${booking ? 'occupied' : 'vacant'} ${paymentClass}`);

    const top = el('div', 'room-top');
    const nameWrap = el('div', 'room-name', room.name);
    if (room.type) nameWrap.append(' ', el('span', 'tag', room.type));
    top.appendChild(nameWrap);
    top.appendChild(el('span', 'status-pill ' + (booking ? 'occupied' : 'vacant'), booking ? 'Đang thuê' : 'Trống'));
    card.appendChild(top);

    if (booking) {
      const nights = nightsBetween(booking.fromDate, booking.toDate);
      const meta = el('div', 'room-meta');
      meta.append(
        metaItem('Khách', booking.guestName || '—'),
        metaItem('SĐT', booking.guestPhone || '—'),
        metaItem('Thời gian', `${fmtShort(booking.fromDate)} → ${fmtShort(booking.toDate)} (${nights} đêm)`),
        metaItem('Giá', `${money(booking.price)} ₫`),
        metaItem('Đã thanh toán tới', booking.paidUntil ? formatDayLong(booking.paidUntil) : 'Chưa thanh toán')
      );
      card.appendChild(meta);

      const tags = el('div', 'room-meta');
      if (booking.fromDate === date) {
        tags.appendChild(el('span', 'tag in', 'Nhận phòng hôm nay' + (booking.checkinTime ? ` · ${booking.checkinTime}` : '')));
      }
      if (booking.toDate === addDays(date, 1)) {
        tags.appendChild(el('span', 'tag out', 'Trả phòng ngày mai' + (booking.checkoutTime ? ` · ${booking.checkoutTime}` : '')));
      }
      if (booking.paidUntil) tags.appendChild(el('span', 'tag paid', `Đã thanh toán tới ${fmtShort(booking.paidUntil)}`));
      else if (booking.deposit) tags.appendChild(el('span', 'tag', `Cọc ${money(booking.deposit)} ₫`));
      if (tags.children.length) card.appendChild(tags);

      if (booking.note) card.appendChild(el('div', 'room-note', booking.note));
      card.addEventListener('click', () => openBookingModal(booking));
    } else {
      const out = checkoutBy.get(room.id);
      if (out) {
        card.appendChild(el('div', 'room-meta',
          `Khách ${out.guestName || out.guestPhone || ''} trả phòng hôm nay${out.checkoutTime ? ' lúc ' + out.checkoutTime : ''}`));
      }
      if (canEditBooking()) {
        const btn = el('button', 'ghost-btn small', '+ Đặt phòng này');
        btn.style.marginTop = '8px';
        btn.addEventListener('click', () => openBookingModal(null, room.id, date));
        card.appendChild(btn);
      }
    }

    list.appendChild(card);
  }
}

function makeStat(value, label) {
  const d = el('div');
  d.appendChild(el('b', null, value));
  d.appendChild(document.createTextNode(label));
  return d;
}

function metaItem(label, value) {
  const s = el('span');
  s.append(label + ': ', el('b', null, value));
  return s;
}

function fmtShort(date) {
  const d = parseYmd(date);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

/* ================================================================
   Modal đặt phòng
   ================================================================ */

let editingId = null;

function openBookingModal(booking, roomId, date) {
  editingId = booking ? booking.id : null;
  $('modalTitle').textContent = booking && canEditBooking() ? 'Sửa đặt phòng' : booking ? 'Thông tin đặt phòng' : 'Đặt phòng mới';
  $('deleteBooking').hidden = !booking;
  $('saveBooking').disabled = !canEditBooking();
  $('formError').hidden = true;

  const select = $('fRoom');
  select.textContent = '';
  for (const r of state.data.rooms) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.name + (r.type ? ` (${r.type})` : '');
    select.appendChild(opt);
  }

  const base = booking || {
    roomId: roomId || (state.data.rooms[0] && state.data.rooms[0].id),
    fromDate: date || state.bkSelected || TODAY,
    toDate: addDays(date || state.bkSelected || TODAY, 1),
    checkinTime: '14:00',
    checkoutTime: '12:00',
    price: roomId ? (roomById(roomId)?.defaultPrice || 0) : 0,
    deposit: 0, paid: false, paidUntil: '', guestName: '', guestPhone: '', note: '',
  };

  select.value = base.roomId || '';
  $('fFrom').value = base.fromDate;
  $('fTo').value = base.toDate;
  $('fCheckin').value = base.checkinTime || '';
  $('fCheckout').value = base.checkoutTime || '';
  $('fPrice').value = base.price || '';
  $('fDeposit').value = base.deposit || '';
  $('fPaidUntil').value = base.paidUntil || (base.paid ? base.toDate : '');
  $('fName').value = base.guestName || '';
  $('fPhone').value = base.guestPhone || '';
  $('fNote').value = base.note || '';
  ['fRoom', 'fFrom', 'fTo', 'fCheckin', 'fCheckout', 'fPrice', 'fDeposit', 'fPaidUntil', 'fName', 'fPhone', 'fNote']
    .forEach((id) => { $(id).disabled = !canEditBooking(); });
  $('deleteBooking').disabled = !canEditBooking();

  updateNightsHint();
  $('modal').hidden = false;
  $('fName').focus();
}

function closeModal() {
  $('modal').hidden = true;
  editingId = null;
}

function updateNightsHint() {
  const from = $('fFrom').value;
  const to = $('fTo').value;
  const hint = $('nightsHint');
  if (!from || !to || to <= from) {
    hint.textContent = 'Giá tính theo đêm: từ ngày nhận phòng đến trước ngày trả phòng.';
    return;
  }
  const n = nightsBetween(from, to);
  const price = Number($('fPrice').value) || 0;
  hint.textContent = `${n} đêm` + (price ? ` · ${money(Math.round(price / n))} ₫/đêm` : '');
}

async function submitBooking(e) {
  e.preventDefault();
  if (!canEditBooking()) return;
  const payload = {
    roomId: $('fRoom').value,
    fromDate: $('fFrom').value,
    toDate: $('fTo').value,
    checkinTime: $('fCheckin').value,
    checkoutTime: $('fCheckout').value,
    price: Number($('fPrice').value) || 0,
    deposit: Number($('fDeposit').value) || 0,
    paidUntil: $('fPaidUntil').value,
    guestName: $('fName').value,
    guestPhone: $('fPhone').value,
    note: $('fNote').value,
  };

  try {
    if (editingId) {
      const updated = await api('PUT', `/api/bookings/${editingId}`, payload);
      const idx = state.data.bookings.findIndex((b) => b.id === editingId);
      state.data.bookings[idx] = updated;
    } else {
      state.data.bookings.push(await api('POST', '/api/bookings', payload));
    }
    closeModal();
    renderBookingCalendar();
    renderBookingDay();
    toast('Đã lưu đặt phòng');
  } catch (err) {
    const box = $('formError');
    box.textContent = err.message;
    box.hidden = false;
  }
}

async function deleteBooking() {
  if (!editingId || !confirm('Xoá đặt phòng này?')) return;
  try {
    await api('DELETE', `/api/bookings/${editingId}`);
    state.data.bookings = state.data.bookings.filter((b) => b.id !== editingId);
    closeModal();
    renderBookingCalendar();
    renderBookingDay();
    toast('Đã xoá đặt phòng');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ================================================================
   TAB LỄ TÂN
   ================================================================ */

function renderHkCalendar() {
  $('hkMonthLabel').textContent = monthLabel(state.hkMonth);
  const totalTargets = state.data.rooms.length + state.data.areas.length;

  renderCalendar($('hkCalendar'), state.hkMonth, state.hkSelected, (date, cell, inMonth) => {
    if (!inMonth) return;
    const rec = hkOn(date);
    if (rec && rec.paid) cell.classList.add('paid-day');
    if (!rec) return;

    const done = Object.keys(rec.rooms).length + Object.keys(rec.areas).length;
    if (done > 0) {
      const badge = el('span', 'day-badge', `${done}/${totalTargets}`);
      badge.classList.add(done >= totalTargets ? 'badge-done' : 'badge-none');
      cell.appendChild(badge);
    }
    if (rec.staffId) cell.appendChild(el('span', 'day-sub', staffName(rec.staffId)));
    if (rec.salary) cell.appendChild(el('span', 'day-flag', `${money(rec.salary)} ₫`));
    if (rec.paid) cell.appendChild(el('span', 'day-flag', '✓ Đã trả lương'));
  }, (date) => { void selectHkDay(date); });

  renderHkMonthTotal();
}

function renderHkMonthTotal() {
  const y = state.hkMonth.getFullYear();
  const m = state.hkMonth.getMonth();
  const prefix = `${y}-${String(m + 1).padStart(2, '0')}-`;
  let paid = 0, unpaid = 0, days = 0;
  for (const [date, rec] of Object.entries(state.data.housekeeping)) {
    if (!date.startsWith(prefix)) continue;
    days++;
    if (rec.paid) paid += rec.salary || 0;
    else unpaid += rec.salary || 0;
  }
  const box = $('hkMonthTotal');
  box.textContent = '';
  box.append(
    `Tháng này: ${days} ngày có ghi nhận · Đã trả lương `,
    el('b', null, `${money(paid)} ₫`),
    ' · Chưa trả ',
    el('b', null, `${money(unpaid)} ₫`)
  );
}

async function selectHkDay(date) {
  if (state.hkDirty) await saveHk(true);
  state.hkSelected = date;
  const d = parseYmd(date);
  if (d.getMonth() !== state.hkMonth.getMonth() || d.getFullYear() !== state.hkMonth.getFullYear()) {
    state.hkMonth = startOfMonth(d);
  }
  const rec = hkOn(date);
  state.hkDraft = rec
    ? { rooms: { ...rec.rooms }, areas: { ...rec.areas }, staffId: rec.staffId, note: rec.note, paid: rec.paid, salary: rec.salary }
    : { rooms: {}, areas: {}, staffId: '', note: '', paid: false, salary: 0 };
  // Ngày đã lưu mà lương khác con số tự tính nghĩa là trước đó đã sửa tay — tôn trọng điều đó
  state.hkDraft.salaryAuto = !rec || rec.salary === autoSalary(state.hkDraft);
  state.hkDirty = false;
  renderHkCalendar();
  renderHkDay();
}

function renderHkDay() {
  const date = state.hkSelected;
  $('hkForm').hidden = !date;
  $('hkEmptyHint').hidden = Boolean(date);
  if (!date) {
    $('hkDayTitle').textContent = 'Chọn một ngày';
    return;
  }
  $('hkDayTitle').textContent = formatDayLong(date);

  const d = state.hkDraft;
  fillStaffSelect(d.staffId);
  $('hkSalary').value = d.salary || '';
  $('hkNote').value = d.note || '';
  $('hkPaid').checked = Boolean(d.paid);

  buildCheckList($('hkRooms'), state.data.rooms, d.rooms, bookingsOn(date));
  buildCheckList($('hkAreas'), state.data.areas, d.areas, null);
  setHousekeepingReadonly();
  renderSalaryHint(autoSalary(d));
  $('hkSaveHint').textContent = '';
}

/** Số mục đã dọn trong ngày = số phòng + số khu vực chung. */
function cleanedCount(draft) {
  return Object.keys(draft.rooms).length + Object.keys(draft.areas).length;
}

/** Lương tự tính = số mục đã dọn × đơn giá. */
function autoSalary(draft) {
  return cleanedCount(draft) * (state.data.cleaningRate || 0);
}

/**
 * Cập nhật ô lương theo số mục đã tick.
 * Chỉ ghi đè khi người dùng chưa tự sửa tay cho ngày này.
 */
function refreshSalary() {
  const d = state.hkDraft;
  if (!d) return;
  const auto = autoSalary(d);
  if (d.salaryAuto) {
    d.salary = auto;
    $('hkSalary').value = auto || '';
  }
  renderSalaryHint(auto);
}

function renderSalaryHint(auto) {
  const box = $('hkSalaryHint');
  const d = state.hkDraft;
  box.textContent = '';
  const soMuc = cleanedCount(d);
  const donGia = state.data.cleaningRate || 0;

  if (d.salaryAuto) {
    box.className = 'salary-hint';
    box.textContent = `Tự tính: ${soMuc} mục × ${money(donGia)} = ${money(auto)} ₫`;
    return;
  }
  box.className = 'salary-hint manual';
  box.append(`Đã sửa tay. Tự tính sẽ là ${money(auto)} ₫ `);
  if (canEditHousekeeping()) {
    const btn = el('button', 'link-btn', 'Tính lại');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      d.salaryAuto = true;
      refreshSalary();
      markHkDirty();
    });
    box.appendChild(btn);
  }
}

/** Đổ danh sách lễ tân vào ô chọn, giữ lại người đang được chọn. */
function fillStaffSelect(selectedId) {
  const sel = $('hkStaff');
  const defaultStaffId = selectedId || state.data.staff[0]?.id || '';
  sel.textContent = '';

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = state.data.staff.length
    ? '— Chưa chọn —'
    : '— Chưa có lễ tân, thêm ở tab Cài đặt —';
  sel.appendChild(blank);

  for (const s of state.data.staff) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name + (s.phone ? ` · ${s.phone}` : '');
    sel.appendChild(opt);
  }

  // Người từng được chọn nhưng nay đã bị xoá khỏi danh sách
  if (selectedId && !staffById(selectedId)) {
    const opt = document.createElement('option');
    opt.value = selectedId;
    opt.textContent = '(nhân viên đã bị xoá)';
    sel.appendChild(opt);
  }
  sel.value = defaultStaffId;
}

function buildCheckList(container, items, store, occupiedBookings) {
  container.textContent = '';
  const occupiedIds = occupiedBookings ? new Set(occupiedBookings.map((b) => b.roomId)) : null;

  for (const item of items) {
    const label = el('label', 'check-item' + (store[item.id] ? ' checked' : ''));
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = Boolean(store[item.id]);
    cb.disabled = !canEditHousekeeping();
    cb.addEventListener('change', () => {
      if (cb.checked) store[item.id] = true;
      else delete store[item.id];
      label.classList.toggle('checked', cb.checked);
      refreshSalary();
      markHkDirty();
    });
    label.appendChild(cb);
    label.appendChild(el('span', null, item.name));
    if (occupiedIds && occupiedIds.has(item.id)) label.appendChild(el('span', 'tag', 'có khách'));
    container.appendChild(label);
  }
}

function markHkDirty() {
  state.hkDirty = true;
  $('hkSaveHint').textContent = 'Có thay đổi chưa lưu';
  $('hkSaveHint').style.color = '#e0962c';
}

function collectHkDraft() {
  const d = state.hkDraft;
  d.staffId = $('hkStaff').value;
  d.salary = Number($('hkSalary').value) || 0;
  d.note = $('hkNote').value.trim();
  d.paid = $('hkPaid').checked;
  return d;
}

async function saveHk(silent = false) {
  const date = state.hkSelected;
  if (!date) return;
  const draft = collectHkDraft();
  try {
    const res = await api('PUT', `/api/housekeeping/${date}`, draft);
    const isEmpty = Object.keys(res.record.rooms).length === 0 && Object.keys(res.record.areas).length === 0 &&
      !res.record.staffId && !res.record.note && !res.record.paid && !res.record.salary;
    if (isEmpty) delete state.data.housekeeping[date];
    else state.data.housekeeping[date] = res.record;
    state.hkDirty = false;
    renderHkCalendar();
    if (!silent) {
      $('hkSaveHint').textContent = 'Đã lưu ✓';
      $('hkSaveHint').style.color = '';
      toast('Đã lưu ghi nhận ngày ' + fmtShort(date));
    }
  } catch (err) {
    toast(err.message, true);
  }
}

/* ================================================================
   TAB CÀI ĐẶT
   ================================================================ */

function roomRow(room, index) {
  const tr = document.createElement('tr');
  tr.dataset.id = room.id || '';

  tr.appendChild(el('td', 'idx', String(index + 1)));

  const nameTd = el('td');
  nameTd.dataset.label = 'Tên phòng';
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'r-name';
  name.value = room.name || '';
  name.placeholder = 'Tên phòng';
  nameTd.appendChild(name);
  tr.appendChild(nameTd);

  const typeTd = el('td');
  typeTd.dataset.label = 'Loại phòng';
  const type = document.createElement('input');
  type.type = 'text';
  type.className = 'r-type';
  type.value = room.type || '';
  type.placeholder = 'Đơn / Đôi / VIP';
  typeTd.appendChild(type);
  tr.appendChild(typeTd);

  const priceTd = el('td');
  priceTd.dataset.label = 'Giá mặc định';
  const price = document.createElement('input');
  price.type = 'number';
  price.className = 'r-price';
  price.min = '0';
  price.step = '1000';
  price.value = room.defaultPrice || '';
  price.placeholder = '0';
  priceTd.appendChild(price);
  tr.appendChild(priceTd);

  const delTd = el('td');
  const del = el('button', 'row-del', '✕');
  del.type = 'button';
  del.title = 'Xoá phòng';
  del.addEventListener('click', () => { tr.remove(); reindex($('roomRows')); });
  delTd.appendChild(del);
  tr.appendChild(delTd);

  return tr;
}

function areaRow(area, index) {
  const tr = document.createElement('tr');
  tr.dataset.id = area.id || '';

  tr.appendChild(el('td', 'idx', String(index + 1)));

  const nameTd = el('td');
  nameTd.dataset.label = 'Tên khu vực';
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'a-name';
  name.value = area.name || '';
  name.placeholder = 'Nhà xe, hành lang tầng 1...';
  nameTd.appendChild(name);
  tr.appendChild(nameTd);

  const noteTd = el('td');
  noteTd.dataset.label = 'Ghi chú';
  const note = document.createElement('input');
  note.type = 'text';
  note.className = 'a-note';
  note.value = area.note || '';
  note.placeholder = 'Ghi chú';
  noteTd.appendChild(note);
  tr.appendChild(noteTd);

  const delTd = el('td');
  const del = el('button', 'row-del', '✕');
  del.type = 'button';
  del.title = 'Xoá khu vực';
  del.addEventListener('click', () => { tr.remove(); reindex($('areaRows')); });
  delTd.appendChild(del);
  tr.appendChild(delTd);

  return tr;
}

function staffRow(person, index) {
  const tr = document.createElement('tr');
  tr.dataset.id = person.id || '';

  tr.appendChild(el('td', 'idx', String(index + 1)));

  const nameTd = el('td');
  nameTd.dataset.label = 'Tên lễ tân';
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 's-name';
  name.value = person.name || '';
  name.placeholder = 'Nguyễn Thị Lan';
  nameTd.appendChild(name);
  tr.appendChild(nameTd);

  const phoneTd = el('td');
  phoneTd.dataset.label = 'Số điện thoại';
  const phone = document.createElement('input');
  phone.type = 'tel';
  phone.className = 's-phone';
  phone.value = person.phone || '';
  phone.placeholder = '09xx xxx xxx';
  phoneTd.appendChild(phone);
  tr.appendChild(phoneTd);

  const noteTd = el('td');
  noteTd.dataset.label = 'Ghi chú';
  const note = document.createElement('input');
  note.type = 'text';
  note.className = 's-note';
  note.value = person.note || '';
  note.placeholder = 'Ca sáng / ca tối...';
  noteTd.appendChild(note);
  tr.appendChild(noteTd);

  const delTd = el('td');
  const del = el('button', 'row-del', '✕');
  del.type = 'button';
  del.title = 'Xoá lễ tân';
  del.addEventListener('click', () => { tr.remove(); reindex($('staffRows')); });
  delTd.appendChild(del);
  tr.appendChild(delTd);

  return tr;
}

function reindex(tbody) {
  [...tbody.rows].forEach((tr, i) => { tr.cells[0].textContent = String(i + 1); });
}

function renderSettings() {
  $('setHotelName').value = state.data.hotelName || '';
  $('setCleaningRate').value = state.data.cleaningRate ?? '';
  const rt = $('roomRows');
  rt.textContent = '';
  state.data.rooms.forEach((r, i) => rt.appendChild(roomRow(r, i)));
  const at = $('areaRows');
  at.textContent = '';
  state.data.areas.forEach((a, i) => at.appendChild(areaRow(a, i)));
  const st = $('staffRows');
  st.textContent = '';
  state.data.staff.forEach((s, i) => st.appendChild(staffRow(s, i)));
  setSettingsReadonly();
}

function setHousekeepingReadonly() {
  const editable = canEditHousekeeping();
  ['hkStaff', 'hkSalary', 'hkNote', 'hkPaid', 'hkSave'].forEach((id) => { $(id).disabled = !editable; });
  document.querySelectorAll('[data-toggle-all]').forEach((btn) => { btn.disabled = !editable; });
}

function setSettingsReadonly() {
  const editable = canEditSettings();
  document.querySelectorAll('#view-settings input, #view-settings select, #view-settings button, #view-settings textarea')
    .forEach((control) => { control.disabled = !editable; });
  if (!editable) {
    ['curPass', 'newPass', 'changePass'].forEach((id) => { $(id).disabled = false; });
  }
}

/** "Phòng 101" + 3 phòng -> Phòng 101, Phòng 102, Phòng 103 */
function generateNames(prefix, count) {
  const m = String(prefix || '').match(/^(.*?)(\d+)\s*$/);
  const out = [];
  if (m) {
    const head = m[1];
    const start = Number(m[2]);
    const width = m[2].length;
    for (let i = 0; i < count; i++) out.push(head + String(start + i).padStart(width, '0'));
  } else {
    const head = (prefix || 'Phòng').trim() + ' ';
    for (let i = 0; i < count; i++) out.push(head + (i + 1));
  }
  return out;
}

function collectRooms() {
  return [...$('roomRows').rows].map((tr) => ({
    id: tr.dataset.id || undefined,
    name: tr.querySelector('.r-name').value.trim(),
    type: tr.querySelector('.r-type').value.trim(),
    defaultPrice: Number(tr.querySelector('.r-price').value) || 0,
  })).filter((r) => r.name);
}

function collectAreas() {
  return [...$('areaRows').rows].map((tr) => ({
    id: tr.dataset.id || undefined,
    name: tr.querySelector('.a-name').value.trim(),
    note: tr.querySelector('.a-note').value.trim(),
  })).filter((a) => a.name);
}

async function saveRooms() {
  try {
    const res = await api('PUT', '/api/rooms', { rooms: collectRooms() });
    state.data.rooms = res.rooms;
    renderSettings();
    renderAll();
    $('roomHint').textContent = 'Đã lưu ✓';
    setTimeout(() => { $('roomHint').textContent = ''; }, 2000);
    toast(`Đã lưu ${res.rooms.length} phòng`);
  } catch (err) {
    toast(err.message, true);
  }
}

function collectStaff() {
  return [...$('staffRows').rows].map((tr) => ({
    id: tr.dataset.id || undefined,
    name: tr.querySelector('.s-name').value.trim(),
    phone: tr.querySelector('.s-phone').value.trim(),
    note: tr.querySelector('.s-note').value.trim(),
  })).filter((s) => s.name);
}

async function saveStaff() {
  try {
    const res = await api('PUT', '/api/staff', { staff: collectStaff() });
    state.data.staff = res.staff;
    renderSettings();
    renderAll();
    $('staffHint').textContent = 'Đã lưu ✓';
    setTimeout(() => { $('staffHint').textContent = ''; }, 2000);
    toast(`Đã lưu ${res.staff.length} lễ tân`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveAreas() {
  try {
    const res = await api('PUT', '/api/areas', { areas: collectAreas() });
    state.data.areas = res.areas;
    renderSettings();
    renderAll();
    $('areaHint').textContent = 'Đã lưu ✓';
    setTimeout(() => { $('areaHint').textContent = ''; }, 2000);
    toast(`Đã lưu ${res.areas.length} khu vực`);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ================================================================
   Khởi tạo
   ================================================================ */

function renderAll() {
  document.title = (state.data.hotelName || 'Quản lý khách sạn') + ' — Quản lý khách sạn';
  $('hotelTitle').textContent = state.data.hotelName || 'Quản lý khách sạn';
  renderBookingCalendar();
  renderBookingDay();
  renderHkCalendar();
  if (state.hkSelected) renderHkDay();
}

function switchTab(name, updateUrl = true) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'settings') renderSettings();
  if (updateUrl) navigateTo(TAB_PATHS[name]);
}

function wire() {
  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) switchTab(btn.dataset.tab);
  });
  window.addEventListener('popstate', () => {
    const tab = tabFromPath(window.location.pathname);
    if (tab) switchTab(tab, false);
  });

  // Lịch đặt phòng
  $('bkPrev').addEventListener('click', () => { state.bkMonth = new Date(state.bkMonth.getFullYear(), state.bkMonth.getMonth() - 1, 1); renderBookingCalendar(); });
  $('bkNext').addEventListener('click', () => { state.bkMonth = new Date(state.bkMonth.getFullYear(), state.bkMonth.getMonth() + 1, 1); renderBookingCalendar(); });
  $('bkToday').addEventListener('click', () => selectBookingDay(TODAY));
  $('bkAddBtn').addEventListener('click', () => openBookingModal(null, null, state.bkSelected));

  // Lịch lễ tân
  $('hkPrev').addEventListener('click', () => { state.hkMonth = new Date(state.hkMonth.getFullYear(), state.hkMonth.getMonth() - 1, 1); renderHkCalendar(); });
  $('hkNext').addEventListener('click', () => { state.hkMonth = new Date(state.hkMonth.getFullYear(), state.hkMonth.getMonth() + 1, 1); renderHkCalendar(); });
  $('hkToday').addEventListener('click', () => selectHkDay(TODAY));
  $('hkSave').addEventListener('click', () => saveHk());
  ['hkStaff', 'hkSalary', 'hkNote', 'hkPaid'].forEach((id) => {
    $(id).addEventListener('input', markHkDirty);
    $(id).addEventListener('change', markHkDirty);
  });
  // Tự gõ vào ô lương nghĩa là muốn giữ số của mình, thôi tự tính
  $('hkSalary').addEventListener('input', () => {
    if (!state.hkDraft) return;
    state.hkDraft.salaryAuto = false;
    renderSalaryHint(autoSalary(state.hkDraft));
  });
  document.querySelectorAll('[data-toggle-all]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.toggleAll;
      const items = which === 'rooms' ? state.data.rooms : state.data.areas;
      const store = state.hkDraft ? state.hkDraft[which] : null;
      if (!store) return;
      const allOn = items.length > 0 && items.every((i) => store[i.id]);
      for (const i of items) { if (allOn) delete store[i.id]; else store[i.id] = true; }
      buildCheckList($(which === 'rooms' ? 'hkRooms' : 'hkAreas'), items, store,
        which === 'rooms' ? bookingsOn(state.hkSelected) : null);
      refreshSalary();
      markHkDirty();
    });
  });

  // Modal
  $('bookingForm').addEventListener('submit', submitBooking);
  $('cancelBooking').addEventListener('click', closeModal);
  $('modalClose').addEventListener('click', closeModal);
  $('deleteBooking').addEventListener('click', deleteBooking);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });
  ['fFrom', 'fTo', 'fPrice'].forEach((id) => $(id).addEventListener('change', updateNightsHint));
  $('fFrom').addEventListener('change', () => {
    if ($('fTo').value <= $('fFrom').value) $('fTo').value = addDays($('fFrom').value, 1);
    updateNightsHint();
  });
  $('fRoom').addEventListener('change', () => {
    const r = roomById($('fRoom').value);
    if (r && r.defaultPrice && !Number($('fPrice').value)) {
      const n = Math.max(1, nightsBetween($('fFrom').value, $('fTo').value) || 1);
      $('fPrice').value = r.defaultPrice * n;
      updateNightsHint();
    }
  });

  // Cài đặt
  $('setSaveName').addEventListener('click', async () => {
    try {
      const res = await api('PUT', '/api/settings', {
        hotelName: $('setHotelName').value,
        cleaningRate: $('setCleaningRate').value,
      });
      state.data.hotelName = res.hotelName;
      state.data.cleaningRate = res.cleaningRate;
      renderSettings();
      renderAll();
      toast(`Đã lưu · đơn giá dọn ${money(res.cleaningRate)} ₫/mục`);
    } catch (err) { toast(err.message, true); }
  });
  $('genRooms').addEventListener('click', () => {
    const count = Number($('roomCount').value);
    if (!count || count < 1) return toast('Nhập số lượng phòng', true);
    if (count > 500) return toast('Tối đa 500 phòng', true);
    const existing = $('roomRows').rows.length;
    if (existing && !confirm(`Thao tác này thay thế ${existing} phòng đang hiển thị. Tiếp tục?`)) return;
    const names = generateNames($('roomPrefix').value, count);
    const tbody = $('roomRows');
    tbody.textContent = '';
    names.forEach((name, i) => tbody.appendChild(roomRow({ name }, i)));
    toast(`Đã tạo ${count} phòng — nhớ bấm Lưu`);
  });
  $('addRoom').addEventListener('click', () => {
    const tbody = $('roomRows');
    tbody.appendChild(roomRow({ name: '' }, tbody.rows.length));
    tbody.rows[tbody.rows.length - 1].querySelector('.r-name').focus();
  });
  $('saveRooms').addEventListener('click', saveRooms);
  $('addArea').addEventListener('click', () => {
    const tbody = $('areaRows');
    tbody.appendChild(areaRow({ name: '' }, tbody.rows.length));
    tbody.rows[tbody.rows.length - 1].querySelector('.a-name').focus();
  });
  $('saveAreas').addEventListener('click', saveAreas);
  $('addStaff').addEventListener('click', () => {
    const tbody = $('staffRows');
    tbody.appendChild(staffRow({ name: '' }, tbody.rows.length));
    tbody.rows[tbody.rows.length - 1].querySelector('.s-name').focus();
  });
  $('saveStaff').addEventListener('click', saveStaff);

  window.addEventListener('beforeunload', (e) => {
    if (state.hkDirty) e.preventDefault();
  });
}

/* ================================================================
   Đăng nhập
   ================================================================ */

function showLogin() {
  $('loginScreen').hidden = false;
  $('app').hidden = true;
  $('loginError').hidden = true;
  $('loginPass').value = '';
  state.hkDirty = false;   // tránh hỏi "chưa lưu" khi phiên đã hết hạn
  navigateTo('/login', true);
}

function showApp() {
  $('loginScreen').hidden = true;
  $('app').hidden = false;
  const tab = tabFromPath(window.location.pathname) || 'housekeeping';
  switchTab(tab, false);
  if (window.location.pathname === '/login' || window.location.pathname === '/') {
    navigateTo(TAB_PATHS[tab], true);
  }
}

async function doLogin(e) {
  e.preventDefault();
  const btn = $('loginSubmit');
  const err = $('loginError');
  btn.disabled = true;
  btn.textContent = 'Đang đăng nhập...';
  err.hidden = true;
  try {
    const res = await api('POST', '/api/login', {
      username: $('loginUser').value.trim(),
      password: $('loginPass').value,
    });
    state.user = res.user;
    showApp();
    await loadEverything();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    $('loginPass').value = '';
    $('loginPass').focus();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Đăng nhập';
  }
}

async function doLogout() {
  if (state.hkDirty && !confirm('Còn thay đổi chưa lưu ở tab Lễ tân. Vẫn đăng xuất?')) return;
  try {
    await api('POST', '/api/logout');
  } catch { /* dù lỗi vẫn về màn hình đăng nhập */ }
  state.user = null;
  showLogin();
  $('loginUser').focus();
}

/* ================================================================
   Tài khoản (tab Cài đặt)
   ================================================================ */

function renderUsers() {
  const tbody = $('userRows');
  tbody.textContent = '';
  state.users.forEach((u, i) => {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', 'idx', String(i + 1)));

    const userTd = el('td', null, u.username);
    userTd.dataset.label = 'Tên đăng nhập';
    if (u.id === (state.user && state.user.id)) userTd.append(' ', el('span', 'tag in', 'bạn'));
    tr.appendChild(userTd);

    const nameTd = el('td', null, u.displayName || '');
    nameTd.dataset.label = 'Tên hiển thị';
    tr.appendChild(nameTd);

    const roleTd = el('td');
    roleTd.dataset.label = 'Vai trò';
    if (canEditSettings() && u.id !== (state.user && state.user.id)) {
      const role = document.createElement('select');
      role.innerHTML = '<option value="admin">Admin</option><option value="receptionist">Lễ tân</option><option value="viewer">Viewer</option>';
      role.value = u.role || 'viewer';
      role.addEventListener('change', async () => {
        try {
          await api('PUT', `/api/users/${u.id}`, { role: role.value });
          u.role = role.value;
          toast(`Đã đổi vai trò ${u.username}`);
        } catch (err) {
          role.value = u.role || 'viewer';
          toast(err.message, true);
        }
      });
      roleTd.appendChild(role);
    } else {
      roleTd.textContent = roleLabel(u.role);
    }
    tr.appendChild(roleTd);

    const delTd = el('td');
    if (canEditSettings() && u.id !== (state.user && state.user.id) && state.users.length > 1) {
      const del = el('button', 'row-del', '✕');
      del.type = 'button';
      del.title = 'Xoá tài khoản';
      del.addEventListener('click', async () => {
        if (!confirm(`Xoá tài khoản "${u.username}"? Người này sẽ không đăng nhập được nữa.`)) return;
        try {
          await api('DELETE', `/api/users/${u.id}`);
          await loadUsers();
          toast('Đã xoá tài khoản');
        } catch (err) { toast(err.message, true); }
      });
      delTd.appendChild(del);
    }
    tr.appendChild(delTd);
    tbody.appendChild(tr);
  });
  setSettingsReadonly();
}

async function loadUsers() {
  try {
    const res = await api('GET', '/api/users');
    state.users = res.users;
    const current = state.users.find((u) => u.id === res.me);
    if (current && state.user) state.user.role = current.role;
    renderUsers();
  } catch (err) { toast(err.message, true); }
}

async function addUser() {
  const username = $('newUsername').value.trim();
  const displayName = $('newDisplayName').value.trim();
  const password = $('newUserPass').value;
  if (!username || !password) return toast('Nhập tên đăng nhập và mật khẩu', true);
  try {
    await api('POST', '/api/users', {
      username, displayName, password, role: $('newUserRole').value,
    });
    $('newUsername').value = '';
    $('newDisplayName').value = '';
    $('newUserPass').value = '';
    $('addUserForm').hidden = true;
    $('showAddUser').hidden = false;
    await loadUsers();
    toast(`Đã tạo tài khoản ${username}`);
  } catch (err) { toast(err.message, true); }
}

async function changePassword() {
  const currentPassword = $('curPass').value;
  const newPassword = $('newPass').value;
  if (!currentPassword || !newPassword) return toast('Nhập đủ mật khẩu hiện tại và mật khẩu mới', true);
  try {
    await api('PUT', '/api/password', { currentPassword, newPassword });
    $('curPass').value = '';
    $('newPass').value = '';
    toast('Đã đổi mật khẩu');
  } catch (err) { toast(err.message, true); }
}

/* ================================================================
   Khởi tạo
   ================================================================ */

async function loadEverything() {
  try {
    state.data = await api('GET', '/api/data');
  } catch (err) {
    toast('Không tải được dữ liệu: ' + err.message, true);
    return;
  }
  $('whoAmI').textContent = state.user ? (state.user.displayName || state.user.username) : '';
  state.bkSelected = TODAY;
  renderAll();
  renderSettings();
  await loadUsers();
  if (state.data.rooms.length === 0) switchTab('settings');
}

async function init() {
  wire();
  $('loginForm').addEventListener('submit', doLogin);
  $('logoutBtn').addEventListener('click', doLogout);
  $('showAddUser').addEventListener('click', () => {
    $('addUserForm').hidden = false;
    $('showAddUser').hidden = true;
    $('newUsername').focus();
  });
  $('addUser').addEventListener('click', addUser);
  $('changePass').addEventListener('click', changePassword);

  try {
    const res = await api('GET', '/api/me');
    state.user = res.user;
    showApp();
    await loadEverything();
  } catch {
    showLogin();
    $('loginUser').focus();
  }
}

init();
