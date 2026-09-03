/* ============================================================
   fn-calendar — macOS 日历风格前端逻辑
   ============================================================ */

'use strict';

/* ---------------- 常量 ---------------- */

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKDAY_FULL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MONTH_CN = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

const COLORS = {
  blue:   '#1e88e5',
  green:  '#43a047',
  red:    '#e53935',
  orange: '#fb8c00',
  purple: '#8e24aa',
  teal:   '#00897b',
  yellow: '#c0a30f',
  gray:   '#757575',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_H = 56; // 每小时的像素高度，与 CSS --hour-h 保持一致

/* ---------------- 状态 ---------------- */

const state = {
  view: 'month',            // year | month | week | day
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  selected: new Date(),     // 选中的日期（去时分秒）
  today: new Date(),
  monthData: null,          // 月网格数据（含农历/事件）
  events: [],               // 当前可见区间的日程
  editing: null,            // { mode: 'create'|'edit'|'view', date, event }
  calendars: [],            // 远程日历源
  remoteEvents: [],         // 远程日历缓存事件
  hiddenCals: new Set(JSON.parse(localStorage.getItem('fnCalHidden') || '[]')),
  syncedThisSession: false,
};

/* ---------------- API 助手 ---------------- */

function apiBase() {
  let p = location.pathname;
  if (p.endsWith('/')) p = p.slice(0, -1);
  p = p.replace(/\/index\.html$/, '');
  if (p === '/index.html') p = '';
  return p;
}

async function apiGet(path, query) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const res = await fetch(apiBase() + path + qs);
  if (!res.ok) throw new Error('请求失败: ' + res.status);
  return res.json();
}

async function apiSend(method, path, body) {
  const res = await fetch(apiBase() + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

/* ---------------- 日期工具 ---------------- */

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function fmtDT(d) {
  const p = (n) => String(n).padStart(2, '0');
  return fmtDate(d) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function parseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function parseDT(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function startOfWeek(d) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() - r.getDay()); // 周日为一周开始
  return r;
}

function addDays(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + n);
  return r;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtTime(s) {
  const d = parseDT(s);
  if (!d) return '';
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function minutesOf(s) {
  const d = parseDT(s);
  if (!d) return 0;
  return d.getHours() * 60 + d.getMinutes();
}

/* ---------------- DOM 工具 ---------------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function clear(node) { node.textContent = ''; }

/* ---------------- 数据加载 ---------------- */

async function refreshAll() {
  const tasks = [loadCalendars(), loadToday()];
  if (state.view === 'month') {
    tasks.push(loadMonth());
  } else if (state.view === 'year') {
    tasks.push(loadYearData());
  } else {
    tasks.push(loadWeekRangeEvents());
  }
  await Promise.all(tasks);
  render();
}

/* 当前视图覆盖的日期区间（含月视图网格溢出部分） */
function viewRange() {
  if (state.view === 'month' && state.monthData && state.monthData.cells.length) {
    const cs = state.monthData.cells;
    return { start: new Date(cs[0].year, cs[0].month - 1, cs[0].day), end: new Date(cs[cs.length - 1].year, cs[cs.length - 1].month - 1, cs[cs.length - 1].day) };
  }
  if (state.view === 'year') {
    return { start: new Date(state.year, 0, 1), end: new Date(state.year, 11, 31) };
  }
  if (state.view === 'week') {
    const s = startOfWeek(state.selected);
    return { start: s, end: addDays(s, 6) };
  }
  return { start: state.selected, end: state.selected };
}

async function loadMonth() {
  const data = await apiGet('/api/months/' + state.year + '/' + state.month);
  state.monthData = data;
  state.events = data.cells.flatMap((c) => c.events);
  await loadRemoteEvents();
}

async function loadWeekRangeEvents() {
  // 周/日视图：加载覆盖当前视口的区间
  const start = startOfWeek(state.selected);
  let end = addDays(start, state.view === 'day' ? 1 : 7);
  end = addDays(end, -1);
  state.events = await apiGet('/api/events', { start: fmtDate(start), end: fmtDate(end) });
  // 同时取该周的农历信息（用于表头显示）
  state.monthData = null;
  const lunar = await apiGet('/api/dates', { start: fmtDate(start), end: fmtDate(end) });
  state.lunarMap = {};
  lunar.forEach((d) => { state.lunarMap[d.today] = d; });
  await loadRemoteEvents();
}

async function loadYearData() {
  const start = new Date(state.year, 0, 1);
  const end = new Date(state.year, 11, 31);
  state.events = await apiGet('/api/events', { start: fmtDate(start), end: fmtDate(end) });
  state.lunarMap = {};
  const lunar = await apiGet('/api/dates', { start: fmtDate(start), end: fmtDate(end) });
  lunar.forEach((d) => { state.lunarMap[d.today] = d; });
  await loadRemoteEvents();
}

/* ---------------- 远程日历源（CalDAV / ICS） ---------------- */

async function loadCalendars() {
  try {
    state.calendars = await apiGet('/api/calendars');
  } catch (e) {
    state.calendars = [];
  }
}

async function loadRemoteEvents() {
  // 防止与 loadCalendars 并发时的竞态：日历列表尚未就绪（如首次导入后）则先补齐
  if (!state.calendars.length) await loadCalendars();
  if (!state.calendars.length) { state.remoteEvents = []; return; }
  const r = viewRange();
  try {
    state.remoteEvents = await apiGet('/api/calendars/events', { start: fmtDate(r.start), end: fmtDate(r.end) });
  } catch (e) {
    state.remoteEvents = [];
  }
}

/** 首次加载时后台同步一次远程日历（不阻塞界面） */
function backgroundSync() {
  if (state.syncedThisSession || !state.calendars.length) return;
  state.syncedThisSession = true;
  apiSend('POST', '/api/calendars/sync').then(() => {
    return Promise.all([loadCalendars(), loadRemoteEvents()]);
  }).then(() => render()).catch(() => {});
}

/** 本地 + 可见远程事件的合并列表 */
function visibleEvents() {
  return state.events.concat(
    state.remoteEvents.filter((ev) => !state.hiddenCals.has(ev.calendarId))
  );
}

function evColor(ev) {
  if (ev.remote) return COLORS[ev.calendarColor] || COLORS.purple;
  return COLORS[ev.color] || COLORS.blue;
}

async function loadToday() {
  try {
    state.todayInfo = await apiGet('/api/today');
  } catch (e) {
    state.todayInfo = null;
  }
}

/* ---------------- 渲染入口 ---------------- */

function render() {
  renderToolbar();
  renderSidebar();
  const area = document.getElementById('mainArea');
  clear(area);
  if (state.view === 'month') renderMonthView(area);
  else if (state.view === 'week') renderWeekView(area);
  else if (state.view === 'day') renderDayView(area);
  else renderYearView(area);
}

function renderToolbar() {
  let title;
  if (state.view === 'year') title = state.year + '年';
  else if (state.view === 'month') title = state.year + '年' + state.month + '月';
  else if (state.view === 'week') {
    const s = startOfWeek(state.selected);
    const e = addDays(s, 6);
    title = s.getFullYear() + '年' + (s.getMonth() + 1) + '月' + s.getDate() + '日 — ' + e.getMonth() + '月' + e.getDate() + '日';
  } else {
    title = state.year + '年' + state.month + '月' + state.selected.getDate() + '日';
  }
  document.getElementById('viewTitle').textContent = title;

  document.querySelectorAll('#viewSwitcher button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
}

function renderSidebar() {
  renderTodayCard();
  renderMiniCalendar();
  const count = state.events.length;
  document.getElementById('calCount').textContent = count || '';
  renderRemoteCalList();
}

function renderRemoteCalList() {
  const wrap = document.getElementById('remoteCalList');
  if (!wrap) return;
  clear(wrap);
  state.calendars.forEach((cal) => {
    const item = el('div', 'cal-item remote-cal' + (state.hiddenCals.has(cal.id) ? '' : ' checked'));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !state.hiddenCals.has(cal.id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.hiddenCals.delete(cal.id);
      else state.hiddenCals.add(cal.id);
      localStorage.setItem('fnCalHidden', JSON.stringify([...state.hiddenCals]));
      render();
    });
    const dot = el('span', 'color-dot');
    dot.style.background = COLORS[cal.color] || COLORS.purple;
    const name = el('span', 'cal-name', cal.name);
    if (cal.lastError) {
      name.classList.add('cal-error');
      name.title = '同步失败：' + cal.lastError;
    }
    const count = el('span', 'cal-count', cal.eventCount || '');
    count.title = '共 ' + (cal.eventCount || 0) + ' 个日程';
    item.append(cb, dot, name, count);

    const actions = el('span', 'cal-actions');
    const infoBtn = el('button', 'cal-btn', '✎');
    infoBtn.title = '查看 / 修改日历信息';
    infoBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openCalModal(cal);
    });
    const syncBtn = el('button', 'cal-btn', '⟳');
    syncBtn.title = '立即同步';
    syncBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      syncBtn.disabled = true;
      try {
        await apiSend('POST', '/api/calendars/' + cal.id + '/sync');
        await loadCalendars();
        await loadRemoteEvents();
        render();
      } catch (ex) {
        alert('同步失败：' + ex.message);
      }
      syncBtn.disabled = false;
    });
    const delBtn = el('button', 'cal-btn', '×');
    delBtn.title = '删除此日历';
    delBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('删除日历「' + cal.name + '」？该操作不影响源服务器上的数据。')) return;
      try {
        await apiSend('DELETE', '/api/calendars/' + cal.id);
        state.hiddenCals.delete(cal.id);
        await loadCalendars();
        await loadRemoteEvents();
        render();
      } catch (ex) {
        alert('删除失败：' + ex.message);
      }
    });
    actions.append(infoBtn, syncBtn, delBtn);
    item.appendChild(actions);
    wrap.appendChild(item);
  });
}

function renderTodayCard() {
  const t = state.todayInfo;
  const num = document.getElementById('todayDayNum');
  const ymd = document.getElementById('todayYmd');
  const lunar = document.getElementById('todayLunar');
  const tags = document.getElementById('todayTags');
  const gz = document.getElementById('todayGanzhi');

  if (!t) {
    num.textContent = state.today.getDate();
    ymd.textContent = fmtDate(state.today);
    lunar.textContent = '';
    return;
  }

  num.textContent = t.day;
  const wd = WEEKDAY_FULL[t.weekday];
  ymd.textContent = t.year + '年' + t.month + '月' + t.day + '日 ' + wd;

  const L = t.lunar;
  let lunarText = '农历' + L.monthCn + '月' + L.dayCn;
  if (L.jieQi) lunarText = '今日节气 · ' + L.jieQi;
  lunar.textContent = lunarText;

  clear(tags);
  if (L.jieQi) tags.appendChild(el('span', 'tag tag-jieqi', L.jieQi));
  (L.festivals || []).forEach((f) => tags.appendChild(el('span', 'tag tag-holiday', f)));
  if (L.holiday) {
    tags.appendChild(el('span', 'tag', (L.holiday.work ? '调休上班' : '休') + ' · ' + L.holiday.name));
  }

  gz.textContent = '干支 ' + L.ganZhiYear + ' · 生肖' + L.shengXiao;
  const yi = (L.dayYi || []).slice(0, 4).join('、');
  const ji = (L.dayJi || []).slice(0, 4).join('、');
  gz.textContent += (yi ? '\n宜 ' + yi : '') + (ji ? '\n忌 ' + ji : '');
  gz.style.whiteSpace = 'pre-line';
}

/* ---------------- 迷你月历 ---------------- */

function renderMiniCalendar() {
  const wrap = document.getElementById('miniCalendar');
  clear(wrap);

  const head = el('div', 'mini-head');
  const prev = el('button', '', '‹');
  const next = el('button', '', '›');
  prev.title = '上个月'; next.title = '下个月';
  const nav = el('div', 'mini-nav');
  nav.appendChild(prev);
  nav.appendChild(next);

  const mc = { y: state.selected.getFullYear(), m: state.selected.getMonth() + 1 };
  const mTitle = el('div', 'mini-title', mc.y + '年' + mc.m + '月');
  head.appendChild(mTitle);
  head.appendChild(nav);
  wrap.appendChild(head);

  const wk = el('div', 'mini-week');
  WEEKDAY_CN.forEach((w, i) => wk.appendChild(el('span', '', w)));
  wrap.appendChild(wk);

  const grid = el('div', 'mini-grid');
  const first = new Date(mc.y, mc.m - 1, 1);
  const start = addDays(first, -first.getDay());
  const cells = state.monthData ? state.monthData.cells : [];
  const cellMap = {};
  cells.forEach((c) => { cellMap[fmtDate(new Date(c.year, c.month - 1, c.day))] = c; });

  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const key = fmtDate(d);
    const c = cellMap[key];
    const cell = el('div', 'mini-cell', String(d.getDate()));
    if (d.getMonth() + 1 !== mc.m) cell.classList.add('out');
    if (isSameDay(d, state.today)) cell.classList.add('today');
    if (isSameDay(d, state.selected)) cell.classList.add('selected');
    // 彩色圆点：本地日程蓝色，远程按日历颜色；同一天多事件显示最多 3 个不同颜色
    const dotColors = [];
    for (const ev of eventsOfDay(d)) {
      const col = evColor(ev);
      if (!dotColors.includes(col)) dotColors.push(col);
      if (dotColors.length >= 3) break;
    }
    if (dotColors.length) {
      const dots = el('span', 'dots');
      dotColors.forEach((col) => {
        const p = el('span', 'dot');
        p.style.background = col;
        dots.appendChild(p);
      });
      cell.appendChild(dots);
    }
    cell.title = c ? c.lunar.monthCn + '月' + c.lunar.dayCn : '';
    cell.addEventListener('click', () => selectDate(d));
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);

  prev.addEventListener('click', () => shiftMini(-1));
  next.addEventListener('click', () => shiftMini(1));
}

function shiftMini(delta) {
  const d = new Date(state.selected.getFullYear(), state.selected.getMonth() + delta, 1);
  state.selected = d;
  // 迷你月历独立导航，仅更新选中月份，视图不变
  if (state.view === 'month') {
    state.year = d.getFullYear();
    state.month = d.getMonth() + 1;
    loadMonth().then(render);
  } else {
    loadWeekRangeEvents().then(render);
  }
}

/* ---------------- 月视图 ---------------- */

function renderMonthView(area) {
  if (!state.monthData) {
    area.appendChild(el('div', 'empty-hint', '加载中…'));
    return;
  }
  const view = el('div', 'month-view');

  const head = el('div', 'month-head');
  WEEKDAY_FULL.forEach((w, i) => head.appendChild(el('span', i === 0 ? 'sun' : '', w)));
  view.appendChild(head);

  const grid = el('div', 'month-grid');
  const cells = state.monthData.cells;
  const cols = 7;
  const rows = cells.length / cols;
  grid.style.gridTemplateRows = 'repeat(' + rows + ', minmax(84px, 1fr))';

  cells.forEach((c) => {
    grid.appendChild(buildDayCell(c));
  });
  view.appendChild(grid);
  area.appendChild(view);
}

function buildDayCell(c) {
  const cell = el('div', 'day-cell');
  const key = fmtDate(new Date(c.year, c.month - 1, c.day));
  if (!c.inMonth) cell.classList.add('out-month');
  if (c.isToday) cell.classList.add('today-cell');
  if (isSameDay(new Date(c.year, c.month - 1, c.day), state.selected)) cell.classList.add('selected');

  const num = el('span', 'day-num', String(c.day));
  cell.appendChild(num);

  const L = c.lunar;
  let lunarText;
  let cls = 'day-lunar';
  if (L.jieQi) { lunarText = L.jieQi; cls += ' jieqi'; }
  else if (L.festivals && L.festivals.length) { lunarText = L.festivals[0]; cls += ' fest'; }
  else lunarText = L.monthCn === '正' && L.dayCn === '初一' ? '春节' : L.monthCn + '月' + L.dayCn;
  const lc = el('div', cls, lunarText);
  cell.appendChild(lc);

  const evWrap = el('div', 'day-events');
  const cellEvents = eventsOfDay(new Date(c.year, c.month - 1, c.day));
  const visible = cellEvents.slice(0, 3);
  visible.forEach((ev) => {
    const pill = el('div', 'ev-pill' + (ev.remote ? ' remote' : ''), ev.title);
    pill.style.background = evColor(ev);
    pill.title = ev.title + (ev.remote ? '（' + ev.calendarName + '，只读）' : '') + (ev.allDay ? '' : ' ' + fmtTime(ev.start) + '-' + fmtTime(ev.end));
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      if (ev.remote) openViewer(ev);
      else openEditor('edit', ev);
    });
    evWrap.appendChild(pill);
  });
  if (cellEvents.length > 3) {
    const more = el('div', 'ev-more', '＋' + (cellEvents.length - 3) + ' 更多');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const d = new Date(c.year, c.month - 1, c.day);
      state.selected = d;
      state.view = 'day';
      refreshAll();
    });
    evWrap.appendChild(more);
  }
  cell.appendChild(evWrap);

  // 点击选中
  cell.addEventListener('click', () => {
    selectDate(new Date(c.year, c.month - 1, c.day));
  });
  // 双击新建日程
  cell.addEventListener('dblclick', () => {
    openEditor('create', new Date(c.year, c.month - 1, c.day));
  });
  return cell;
}

/* ---------------- 周 / 日视图 ---------------- */

function renderWeekView(area) {
  area.appendChild(buildTimeline('week'));
}

function renderDayView(area) {
  area.appendChild(buildTimeline('day'));
}

function buildTimeline(type) {
  const view = el('div', type === 'week' ? 'week-view' : 'day-view');
  const start = type === 'week' ? startOfWeek(state.selected) : new Date(state.selected.getFullYear(), state.selected.getMonth(), state.selected.getDate());
  const days = [];
  for (let i = 0; i < (type === 'week' ? 7 : 1); i++) days.push(addDays(start, i));

  /* 表头 */
  const head = el('div', 'week-head');
  if (type === 'week') head.appendChild(el('div', 'time-gutter'));
  days.forEach((d) => {
    const col = el('div', 'col');
    if (isSameDay(d, state.today)) col.classList.add('today');
    if (d.getDay() === 0) col.classList.add('sun');
    col.appendChild(el('div', 'wd', WEEKDAY_FULL[d.getDay()]));
    col.appendChild(el('div', 'dd', String(d.getDate())));
    const li = state.lunarMap && state.lunarMap[fmtDate(d)];
    if (li) {
      let txt = li.lunar.jieQi || (li.lunar.monthCn + '月' + li.lunar.dayCn);
      col.appendChild(el('div', 'lunar', txt));
    }
    head.appendChild(col);
  });
  view.appendChild(head);

  /* 全天日程行 */
  const adr = el('div', 'all-day-row');
  adr.appendChild(el('div', 'all-day-label', '全天'));
  const adCols = el('div', 'all-day-cols');
  days.forEach((d) => {
    const col = el('div', 'col');
    eventsOfDay(d).filter((ev) => ev.allDay).forEach((ev) => {
      const pill = el('div', 'ev-pill' + (ev.remote ? ' remote' : ''), ev.title);
      pill.style.background = evColor(ev);
      pill.title = ev.title + (ev.remote ? '（' + ev.calendarName + '，只读）' : '');
      pill.addEventListener('click', () => {
        if (ev.remote) openViewer(ev);
        else openEditor('edit', ev);
      });
      col.appendChild(pill);
    });
    if (col.childElementCount === 0) {
      col.addEventListener('dblclick', () => openEditor('create', d));
    }
    adCols.appendChild(col);
  });
  adr.appendChild(adCols);
  view.appendChild(adr);

  /* 时间网格 */
  const wrap = el('div', 'time-grid-wrap');
  const grid = el('div', 'time-grid');

  const gutter = el('div', 'time-gutter');
  for (let h = 0; h < 24; h++) {
    const label = el('div', 'time-label', (h === 0 ? '0时' : pad2(h) + ':00'));
    label.style.top = (h * HOUR_H) + 'px';
    gutter.appendChild(label);
  }
  grid.appendChild(gutter);

  const cols = el('div', 'week-cols');
  days.forEach((d) => {
    const col = el('div', 'col');
    if (d.getDay() === 0 || d.getDay() === 6) col.classList.add('weekend');
    if (isSameDay(d, state.today)) col.classList.add('today-col');
    for (let h = 0; h < 24; h++) {
      const line = el('div', 'hour-line');
      line.style.top = (h * HOUR_H) + 'px';
      col.appendChild(line);
      const half = el('div', 'half-line');
      half.style.top = ((h + 0.5) * HOUR_H) + 'px';
      col.appendChild(half);
    }
    // 事件
    eventsOfDay(d).filter((ev) => !ev.allDay).forEach((ev) => {
      const block = buildEvBlock(ev, d);
      if (block) col.appendChild(block);
    });
    // 双击空白新建
    col.addEventListener('dblclick', (e) => {
      if (e.target !== col && e.target !== grid && e.target !== wrap) return;
      const d2 = new Date(d);
      const y = e.offsetY;
      const mins = Math.floor(y / HOUR_H * 60);
      openEditor('create', d2, mins);
    });
    cols.appendChild(col);
  });
  grid.appendChild(cols);

  /* 当前时间线 */
  const now = new Date();
  if (isSameDay(now, state.today) && days.some((d) => isSameDay(d, now))) {
    const nl = el('div', 'now-line');
    const mins = now.getHours() * 60 + now.getMinutes();
    nl.style.top = (mins / 60 * HOUR_H) + 'px';
    nl.style.left = '52px';
    grid.appendChild(nl);
  }

  wrap.appendChild(grid);
  view.appendChild(wrap);
  return view;
}

function eventsOfDay(d) {
  const key = fmtDate(d);
  return visibleEvents().filter((ev) => {
    if (ev.allDay) {
      const s = parseDate(ev.start), e = parseDate(ev.end);
      if (!s || !e) return false;
      return s <= d && new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1) > d;
    }
    const s = parseDT(ev.start), e = parseDT(ev.end);
    if (!s || !e) return false;
    return s < new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) && e > d;
  });
}

function buildEvBlock(ev, day) {
  const s = parseDT(ev.start), e = parseDT(ev.end);
  if (!s || !e) return null;
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const sClipped = s < dayStart ? dayStart : s;
  const eClipped = e > dayEnd ? dayEnd : e;
  const top = (sClipped.getHours() * 60 + sClipped.getMinutes()) / 60 * HOUR_H;
  const height = Math.max((eClipped - sClipped) / (60 * 1000) / 60 * HOUR_H, 22);

  const block = el('div', 'ev-block' + (ev.remote ? ' remote' : ''));
  block.style.top = top + 'px';
  block.style.height = height + 'px';
  block.style.background = evColor(ev);
  block.appendChild(el('div', 't', ev.title));
  if (height > 34) {
    block.appendChild(el('div', 's', fmtTime(ev.start) + ' — ' + fmtTime(ev.end)));
  }
  block.title = ev.title + (ev.remote ? '（' + ev.calendarName + '，只读）' : '') + ' ' + fmtTime(ev.start) + ' — ' + fmtTime(ev.end);
  block.addEventListener('click', () => {
    if (ev.remote) openViewer(ev);
    else openEditor('edit', ev);
  });
  return block;
}

/* ---------------- 年视图 ---------------- */

function renderYearView(area) {
  const view = el('div', 'year-view');
  for (let m = 1; m <= 12; m++) {
    view.appendChild(buildYearMonth(m));
  }
  area.appendChild(view);
}

function buildYearMonth(m) {
  const box = el('div', 'year-month');
  box.appendChild(el('div', 'ym-title', MONTH_CN[m - 1]));

  const wk = el('div', 'ym-week');
  WEEKDAY_CN.forEach((w, i) => wk.appendChild(el('span', '', w)));
  box.appendChild(wk);

  const grid = el('div', 'ym-grid');
  const first = new Date(state.year, m - 1, 1);
  const start = addDays(first, -first.getDay());
  const daysInMonth = new Date(state.year, m, 0).getDate();

  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const cell = el('div', 'ym-cell', String(d.getDate()));
    if (d.getMonth() + 1 !== m) {
      cell.classList.add('out');
      grid.appendChild(cell);
      continue;
    }
    if (isSameDay(d, state.today)) cell.classList.add('today');
    const li = state.lunarMap && state.lunarMap[fmtDate(d)];
    if (li && li.lunar.jieQi) cell.classList.add('jieqi');
    else if (li && li.lunar.festivals && li.lunar.festivals.length) cell.classList.add('fest');
    const hasEv = visibleEvents().some((ev) => {
      if (ev.allDay) {
        const s = parseDate(ev.start), e = parseDate(ev.end);
        return s && e && s <= d && new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1) > d;
      }
      const s = parseDT(ev.start), e = parseDT(ev.end);
      return s && e && s < new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) && e > d;
    });
    if (hasEv) cell.appendChild(el('span', 'dot'));
    if (li && li.lunar.jieQi) cell.title = li.lunar.jieQi;
    grid.appendChild(cell);
  }
  box.appendChild(grid);

  box.addEventListener('click', () => {
    state.month = m;
    state.view = 'month';
    refreshAll();
  });
  return box;
}

/* ---------------- 选中与导航 ---------------- */

function selectDate(d) {
  state.selected = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (state.view === 'month') {
    state.year = state.selected.getFullYear();
    state.month = state.selected.getMonth() + 1;
  }
  refreshAll();
}

function navigate(delta) {
  if (state.view === 'year') {
    state.year += delta;
    // 年视图下迷你月历跟随当前选中月份
    const day = Math.min(state.selected.getDate(), new Date(state.year, state.month, 0).getDate());
    state.selected = new Date(state.year, state.month - 1, day);
  } else if (state.view === 'month') {
    const d = new Date(state.year, state.month - 1 + delta, 1);
    state.year = d.getFullYear();
    state.month = d.getMonth() + 1;
    // 同步选中日（保持原“日”，超月末则收尾），迷你月历随主视图切换
    const day = Math.min(state.selected.getDate(), new Date(state.year, state.month, 0).getDate());
    state.selected = new Date(state.year, state.month - 1, day);
  } else if (state.view === 'week') {
    state.selected = addDays(state.selected, 7 * delta);
  } else {
    state.selected = addDays(state.selected, delta);
  }
  state.year = state.selected.getFullYear();
  state.month = state.selected.getMonth() + 1;
  refreshAll();
}

/* ---------------- 日程编辑弹窗 ---------------- */

function openEditor(mode, arg, startMin) {
  if (mode === 'edit') {
    // arg 为要编辑的日程对象
    state.editing = { mode, event: Object.assign({}, arg) };
    renderEditor();
    return;
  }

  // create 模式：arg 为日期
  const base = arg || state.selected;
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 9, 0, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 10, 0, 0);
  if (startMin !== undefined) {
    const h = Math.floor(startMin / 60), mm = startMin % 60;
    start.setHours(h, mm, 0, 0);
    end.setHours(h + 1, mm, 0, 0);
  }

  const ev = {
    title: '',
    start: fmtDT(start),
    end: fmtDT(end),
    allDay: false,
    color: 'blue',
    notes: '',
  };
  state.editing = { mode, date: base, event: ev };
  renderEditor();
}

function renderEditor() {
  const ed = state.editing;
  if (!ed) return;
  const modal = document.getElementById('modalMask');
  const isEdit = ed.mode === 'edit';
  const isView = ed.mode === 'view';
  const ev = ed.event;

  document.getElementById('modalTitle').textContent = isView
    ? '日程详情（' + (ev.calendarName || '远程') + '）'
    : (isEdit ? '编辑日程' : '新建日程');
  document.getElementById('evTitle').value = ev.title || '';
  document.getElementById('evTitle').disabled = isView;
  document.getElementById('btnDelete').hidden = !isEdit;
  document.getElementById('btnSave').hidden = isView;
  document.getElementById('btnCancel').textContent = isView ? '关闭' : '取消';
  document.getElementById('formError').textContent = '';

  // 日历选择（仅新建模式）：本地「个人」或已导入的飞书日历
  const calRow = document.getElementById('evCalRow');
  if (!isView && !isEdit) {
    calRow.hidden = false;
    const sel = document.getElementById('evCalendar');
    clear(sel);
    const optLocal = document.createElement('option');
    optLocal.value = 'local';
    optLocal.textContent = '个人（本地）';
    sel.appendChild(optLocal);
    state.calendars.filter((c) => c.type === 'feishu').forEach((c) => {
      const o = document.createElement('option');
      o.value = 'cal:' + c.id;
      o.textContent = c.name + '（飞书）';
      sel.appendChild(o);
    });
    sel.value = 'local';
  } else {
    calRow.hidden = true;
  }

  // 只读模式下禁用全部输入
  ['evStartDate', 'evStartTime', 'evEndDate', 'evEndTime', 'evNotes'].forEach((id) => {
    document.getElementById(id).disabled = isView;
  });
  document.getElementById('evAllDay').style.pointerEvents = isView ? 'none' : '';

  // 全天开关
  const sw = document.getElementById('evAllDay');
  sw.classList.toggle('on', !!ev.allDay);
  const startDate = ev.allDay ? ev.start : fmtDate(parseDT(ev.start) || ed.date || new Date());
  const endDate = ev.allDay ? ev.end : fmtDate(parseDT(ev.end) || ed.date || new Date());
  document.getElementById('evStartDate').value = startDate;
  document.getElementById('evEndDate').value = endDate;
  document.getElementById('evStartTime').value = ev.allDay ? '09:00' : (parseDT(ev.start) ? fmtTime(ev.start) : '09:00');
  document.getElementById('evEndTime').value = ev.allDay ? '10:00' : (parseDT(ev.end) ? fmtTime(ev.end) : '10:00');
  document.getElementById('evNotes').value = isView
    ? (ev.location ? '地点：' + ev.location : '')
    : (ev.notes || '');
  syncTimeVisibility();

  // 颜色
  const picker = document.getElementById('evColorPicker');
  picker.hidden = isView;
  clear(picker);
  Object.entries(COLORS).forEach(([name, color]) => {
    const s = el('span', 'color-swatch' + (ev.color === name ? ' active' : ''));
    s.style.background = color;
    s.addEventListener('click', () => {
      picker.querySelectorAll('.color-swatch').forEach((x) => x.classList.remove('active'));
      s.classList.add('active');
      ev.color = name;
    });
    picker.appendChild(s);
  });

  modal.hidden = false;
}

function syncTimeVisibility() {
  const allDay = document.getElementById('evAllDay').classList.contains('on');
  document.getElementById('evStartTime').style.display = allDay ? 'none' : '';
  document.getElementById('evEndTime').style.display = allDay ? 'none' : '';
}

function collectForm() {
  const ed = state.editing;
  const ev = ed.event;
  ev.title = document.getElementById('evTitle').value.trim();
  ev.notes = document.getElementById('evNotes').value.trim();
  ev.allDay = document.getElementById('evAllDay').classList.contains('on');
  const sd = document.getElementById('evStartDate').value;
  const edd = document.getElementById('evEndDate').value;
  if (ev.allDay) {
    ev.start = sd;
    ev.end = edd;
  } else {
    ev.start = sd + 'T' + document.getElementById('evStartTime').value;
    ev.end = edd + 'T' + document.getElementById('evEndTime').value;
  }
  return ev;
}

async function saveEditor() {
  if (state.editing && state.editing.mode === 'view') return;
  const ev = collectForm();
  const err = document.getElementById('formError');
  if (!ev.title) { err.textContent = '请输入日程标题'; return; }
  if (!ev.start || !ev.end) { err.textContent = '请选择开始和结束时间'; return; }

  const allDay = document.getElementById('evAllDay').classList.contains('on');
  const s = allDay ? parseDate(ev.start) : parseDT(ev.start);
  const e = allDay ? parseDate(ev.end) : parseDT(ev.end);
  if (!s || !e) { err.textContent = '时间格式无效'; return; }
  if (allDay ? s > e : s >= e) { err.textContent = '结束时间必须晚于开始时间'; return; }

  const btn = document.getElementById('btnSave');
  btn.disabled = true;
  try {
    if (state.editing.mode === 'edit') {
      // 仅本地日程可编辑（远程/飞书日程点击时为只读查看）
      await apiSend('PUT', '/api/events/' + ev.id, ev);
    } else {
      // 新建：按下拉「日历」选择路由 —— cal:<id> 写回飞书日历，local 写入本地
      const calSel = document.getElementById('evCalendar');
      const target = calSel ? calSel.value : 'local';
      if (target.indexOf('cal:') === 0) {
        const calId = target.slice(4);
        await apiSend('POST', '/api/calendars/' + encodeURIComponent(calId) + '/events', ev);
      } else {
        await apiSend('POST', '/api/events', ev);
      }
    }
    closeEditor();
    await refreshAll();
  } catch (ex) {
    err.textContent = ex.message;
    btn.disabled = false;
  }
}

async function deleteEvent() {
  const ev = state.editing.event;
  try {
    await apiSend('DELETE', '/api/events/' + ev.id);
    closeEditor();
    await refreshAll();
  } catch (ex) {
    document.getElementById('formError').textContent = ex.message;
  }
}

function closeEditor() {
  document.getElementById('modalMask').hidden = true;
  // 复位只读模式对控件的改动
  ['evTitle', 'evStartDate', 'evStartTime', 'evEndDate', 'evEndTime', 'evNotes'].forEach((id) => {
    document.getElementById(id).disabled = false;
  });
  document.getElementById('evAllDay').style.pointerEvents = '';
  document.getElementById('btnSave').hidden = false;
  document.getElementById('btnSave').disabled = false; // 保存成功后复位，便于下次打开
  document.getElementById('btnCancel').textContent = '取消';
  document.getElementById('evColorPicker').hidden = false;
  state.editing = null;
}

/** 远程日程只读查看 */
function openViewer(ev) {
  state.editing = { mode: 'view', event: Object.assign({}, ev) };
  renderEditor();
}

/* ---------------- 添加日历源弹窗（公开订阅 / CalDAV / 飞书） ---------------- */

let calModalColor = 'purple';
let calModalType = 'ics'; // 弹窗当前类型（添加/编辑均可切换，随 setCalType 更新）
let calEditing = null;    // null=添加模式；否则为正在查看/修改的日历源对象
let feishuPicked = new Set(); // 添加飞书时勾选的日历（calendarId 集合）
let feishuAuthWindow = null;

/** 按日历源类型选择默认颜色（自动分配，保证多个飞书日历颜色不同） */
const PALETTE = ['blue', 'green', 'purple', 'orange', 'teal', 'red'];

function openCalModal(cal) {
  calEditing = cal || null;
  const isEdit = !!cal;
  feishuPicked = new Set();

  document.getElementById('calModalTitle').textContent = isEdit ? '日历信息' : '添加日历';
  document.getElementById('calName').value = isEdit ? (cal.name || '') : '';
  document.getElementById('calUrl').value = isEdit ? (cal.url || '') : '';
  document.getElementById('calUsername').value = isEdit ? (cal.username || '') : '';
  const pwdEl = document.getElementById('calPassword');
  pwdEl.value = '';
  pwdEl.placeholder = (isEdit && cal.hasPassword)
    ? '已保存应用专用密码，留空则不修改'
    : '密码 / 应用专用密码';
  document.getElementById('calError').textContent = '';
  document.getElementById('btnCalSave').disabled = false;

  // 同步状态信息（仅查看/修改模式展示）
  document.getElementById('calHint').hidden = isEdit;
  const metaEl = document.getElementById('calMeta');
  metaEl.hidden = !isEdit;
  if (isEdit) {
    document.getElementById('calMetaCount').textContent = cal.eventCount || 0;
    document.getElementById('calMetaSync').textContent = cal.lastSync
      ? new Date(cal.lastSync).toLocaleString()
      : '从未';
    const errEl = document.getElementById('calMetaErr');
    errEl.hidden = !cal.lastError;
    if (cal.lastError) errEl.textContent = '上次同步失败：' + cal.lastError;
    document.getElementById('btnCalSave').textContent = '保存';
  } else {
    document.getElementById('btnCalSave').textContent = '添加';
  }

  calModalColor = isEdit ? (cal.color || 'purple') : 'purple';
  setCalType(isEdit ? (cal.type === 'caldav' ? 'caldav' : (cal.type === 'feishu' ? 'feishu' : 'ics')) : 'ics');
  renderCalColorPicker();
  document.getElementById('calModalMask').hidden = false;
  setTimeout(() => {
    if (calModalType === 'feishu') refreshFeishuStatus();
    else document.getElementById('calName').focus();
  }, 50);
}

function closeCalModal() {
  document.getElementById('calModalMask').hidden = true;
  document.getElementById('btnCalSave').disabled = false; // 复位，便于下次打开
  calEditing = null;
}

function setCalType(t) {
  calModalType = (t === 'caldav') ? 'caldav' : (t === 'feishu') ? 'feishu' : 'ics';
  document.querySelectorAll('#calTypeSwitcher button').forEach((b) => {
    b.classList.toggle('active', b.dataset.type === calModalType);
  });
  const isFeishu = calModalType === 'feishu';
  const isEdit = !!calEditing;
  document.getElementById('calUrlRow').style.display = isFeishu ? 'none' : '';
  document.getElementById('calAuthRow').hidden = calModalType !== 'caldav';
  // 颜色：添加飞书时自动分配不展示；编辑飞书/ics/caldav 时展示
  document.getElementById('calColorRow').hidden = isFeishu && !isEdit;
  document.getElementById('calFeishuPanel').hidden = !isFeishu;
  if (isFeishu) {
    refreshFeishuStatus();
  }
}

/* -------- 飞书授权面板 -------- */

async function refreshFeishuStatus() {
  const panel = document.getElementById('calFeishuPanel');
  if (!panel || panel.hidden) return;
  const statusEl = document.getElementById('feishuStatus');
  const cfgRow = document.getElementById('feishuAppConfig');
  const tipEl = document.getElementById('feishuTip');
  const listEl = document.getElementById('feishuCalList');
  const redirectEl = document.getElementById('feishuRedirect');
  const btnAuth = document.getElementById('btnFeishuAuthorize');
  const btnRefresh = document.getElementById('btnFeishuRefresh');
  tipEl.hidden = true;
  redirectEl.hidden = true;
  listEl.hidden = true;
  btnAuth.hidden = true;
  btnRefresh.hidden = true;
  btnAuth.disabled = false;

  let st;
  try {
    st = await apiGet('/api/feishu/status');
  } catch (e) {
    statusEl.innerHTML = '<span class="st-err">无法读取飞书状态</span>';
    return;
  }

  if (!st.configured) {
    statusEl.innerHTML = '<span class="st-err">未配置飞书应用凭证</span>';
    cfgRow.hidden = false;
    tipEl.hidden = false;
    tipEl.textContent = '在飞书开放平台创建「企业自建应用」，开通权限 calendar:calendar 并发布版本，然后将 App ID / App Secret 填到此处。';
    return;
  }
  cfgRow.hidden = true;

  if (!st.authorized) {
    statusEl.innerHTML = '<span class="st-err">未授权 · 已保存应用凭证</span>';
    btnAuth.hidden = false;
    try {
      const au = await apiGet('/api/feishu/auth-url');
      document.getElementById('feishuRedirectUri').textContent = au.redirectUri;
      redirectEl.hidden = false;
      feishuRedirectUri = au; // 保存授权链接供按钮点击使用
    } catch (e) { /* 忽略 */ }
    return;
  }

  // 已授权
  const who = st.userName ? ('<b>' + st.userName + '</b>') : '飞书账号';
  statusEl.innerHTML = '<span class="st-ok">已授权 · ' + who + '</span>';
  btnRefresh.hidden = false;

  // 日历选择列表（添加模式才有意义；编辑模式只展示信息）
  const cals = st.calendars || [];
  const isEdit = !!calEditing;
  if (isEdit) {
    listEl.hidden = true;
    return;
  }
  if (!cals.length) {
    listEl.hidden = false;
    clear(listEl);
    listEl.appendChild(el('div', 'feishu-cal-item', '（未发现可导入的日历，点「刷新日历列表」重试）'));
    return;
  }
  listEl.hidden = false;
  clear(listEl);
  const imported = new Set(state.calendars.filter((c) => c.type === 'feishu').map((c) => c.feishuCalendarId));
  cals.forEach((c, i) => {
    const row = el('label', 'feishu-cal-item');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !imported.has(c.calendarId);
    if (imported.has(c.calendarId)) cb.disabled = true; // 已导入的不再重复添加
    cb.addEventListener('change', () => {
      if (cb.checked) feishuPicked.add(c.calendarId);
      else feishuPicked.delete(c.calendarId);
    });
    if (!imported.has(c.calendarId)) feishuPicked.add(c.calendarId);
    const name = el('span', 'fc-name', c.summary + (imported.has(c.calendarId) ? '（已导入）' : ''));
    const role = el('span', 'fc-role', c.role || '');
    row.append(cb, name, role);
    listEl.appendChild(row);
  });
}

let feishuRedirectUri = null;

async function authorizeFeishu() {
  if (!feishuRedirectUri) {
    try {
      feishuRedirectUri = await apiGet('/api/feishu/auth-url');
    } catch (e) {
      alert('获取授权链接失败：' + e.message);
      return;
    }
  }
  feishuAuthWindow = window.open(feishuRedirectUri.url, 'feishu_oauth', 'width=560,height=720');
  if (!feishuAuthWindow) alert('请允许浏览器弹出窗口以完成飞书授权');
}

async function saveFeishuApp() {
  const appId = document.getElementById('feishuAppId').value.trim();
  const appSecret = document.getElementById('feishuAppSecret').value.trim();
  const tipEl = document.getElementById('feishuTip');
  try {
    await apiSend('POST', '/api/feishu/app', { appId, appSecret });
    document.getElementById('feishuAppId').value = '';
    document.getElementById('feishuAppSecret').value = '';
    tipEl.textContent = '';
    await refreshFeishuStatus();
  } catch (e) {
    tipEl.hidden = false;
    tipEl.classList.add('tip-err');
    tipEl.textContent = e.message;
  }
}

async function refreshFeishuCals() {
  const btn = document.getElementById('btnFeishuRefresh');
  const listEl = document.getElementById('feishuCalList');
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    await apiSend('POST', '/api/feishu/refresh');
    await loadCalendars();
    await refreshFeishuStatus();
  } catch (e) {
    listEl.hidden = false;
    clear(listEl);
    listEl.appendChild(el('div', 'feishu-cal-item', '刷新失败：' + e.message));
  }
  btn.disabled = false;
  btn.textContent = '刷新日历列表';
}

/** 授权成功的跨窗口回调 */
function onFeishuAuthSuccess() {
  alert('飞书授权成功，正在加载日历列表…');
  feishuRedirectUri = null;
  refreshFeishuStatus().then(() => {
    if (calModalType === 'feishu' && !calEditing) {
      document.getElementById('calError').textContent = '';
    }
  });
}

/* -------- 渲染与保存 -------- */

function renderCalColorPicker() {
  const picker = document.getElementById('calColorPicker');
  clear(picker);
  Object.entries(COLORS).forEach(([name, color]) => {
    const s = el('span', 'color-swatch' + (calModalColor === name ? ' active' : ''));
    s.style.background = color;
    s.addEventListener('click', () => {
      calModalColor = name;
      renderCalColorPicker();
    });
    picker.appendChild(s);
  });
}

async function saveCalModal() {
  const isEdit = !!calEditing;
  const err = document.getElementById('calError');
  const name = document.getElementById('calName').value.trim();

  // 飞书：添加模式 → 批量导入勾选日历；编辑模式 → 仅更新名称/颜色
  if (calModalType === 'feishu') {
    if (isEdit) {
      if (!name) { err.textContent = '请输入日历名称'; return; }
      const btn = document.getElementById('btnCalSave');
      btn.disabled = true;
      try {
        await apiSend('PUT', '/api/calendars/' + calEditing.id, { name, color: calModalColor });
        closeCalModal();
        await Promise.all([loadCalendars(), loadRemoteEvents()]);
        render();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
      return;
    }
    // 添加模式：需要已授权 + 至少勾选一个日历
    let st = null;
    try { st = await apiGet('/api/feishu/status'); } catch (e) { /* ignore */ }
    if (!st || !st.authorized) { err.textContent = '请先完成飞书授权'; return; }
    if (!feishuPicked.size) { err.textContent = '请至少勾选一个要导入的飞书日历'; return; }
    const calIdToMeta = {};
    (st.calendars || []).forEach((c) => { calIdToMeta[c.calendarId] = c; });

    const btn = document.getElementById('btnCalSave');
    btn.disabled = true;
    err.textContent = '正在导入并同步…';
    const imported = [];
    try {
      let i = 0;
      for (const fid of feishuPicked) {
        const meta = calIdToMeta[fid] || {};
        const body = {
          type: 'feishu',
          name: meta.summary || name || '飞书日历',
          feishuCalendarId: fid,
          feishuSummary: meta.summary || '',
          feishuRole: meta.role || '',
          color: calModalColor === 'purple' ? (PALETTE[i % PALETTE.length]) : calModalColor,
        };
        // 首个导入使用用户选择颜色，其余自动轮换避免同色
        if (i > 0) body.color = PALETTE[i % PALETTE.length];
        const cal = await apiSend('POST', '/api/calendars', body);
        imported.push(cal);
        i++;
      }
      closeCalModal();
      await Promise.all([loadCalendars(), loadRemoteEvents()]);
      render();
      const failed = imported.filter((c) => c && c.lastError);
      if (failed.length) {
        alert('已导入 ' + imported.length + ' 个飞书日历，其中 ' + failed.length + ' 个同步失败：\n' +
          failed.map((c) => '「' + c.name + '」' + c.lastError).join('\n') + '\n\n可稍后在日历列表中点击 ⟳ 重试。');
      }
    } catch (ex) {
      err.textContent = ex.message || '导入失败';
      btn.disabled = false;
    }
    return;
  }

  // —— ics / caldav ——
  const url = document.getElementById('calUrl').value.trim();
  const username = document.getElementById('calUsername').value.trim();
  const password = document.getElementById('calPassword').value;

  if (!name) { err.textContent = '请输入日历名称'; return; }
  if (!url) { err.textContent = '请输入日历地址'; return; }

  const body = { name, url, type: calModalType, color: calModalColor };
  if (calModalType === 'caldav') {
    body.username = username;
    // 输入了新密码才提交；编辑模式留空 = 保留已保存密码
    if (password) body.password = password;
  } else {
    // 公开订阅：清空历史账号凭据（避免改回公开链接后仍带认证头）
    body.username = '';
    body.password = '';
  }

  const btn = document.getElementById('btnCalSave');
  btn.disabled = true;
  err.textContent = '正在连接并同步…';
  try {
    const cal = await apiSend(isEdit ? 'PUT' : 'POST', isEdit ? '/api/calendars/' + calEditing.id : '/api/calendars', body);
    closeCalModal();
    await Promise.all([loadCalendars(), loadRemoteEvents()]);
    render();
    if (cal && cal.lastError) {
      const verb = isEdit ? '已保存' : '已添加';
      alert('日历「' + cal.name + '」' + verb + '，但同步失败：\n' + cal.lastError + '\n\n可稍后在日历列表中点击 ⟳ 重试。');
    }
  } catch (ex) {
    err.textContent = ex.message || (isEdit ? '保存失败' : '添加失败');
  }
  btn.disabled = false;
}

/* ---------------- 初始化 ---------------- */

function bindEvents() {
  document.getElementById('btnToday').addEventListener('click', () => {
    state.selected = new Date();
    state.year = state.selected.getFullYear();
    state.month = state.selected.getMonth() + 1;
    refreshAll();
  });

  document.getElementById('btnPrev').addEventListener('click', () => navigate(-1));
  document.getElementById('btnNext').addEventListener('click', () => navigate(1));

  document.querySelectorAll('#viewSwitcher button').forEach((b) => {
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      refreshAll();
    });
  });

  document.getElementById('btnCreate').addEventListener('click', () => {
    openEditor('create', state.selected);
  });

  // 添加日历源（CalDAV / ICS / 飞书）——必须箭头包装，避免把 MouseEvent 当成 cal（否则误入编辑模式）
  document.getElementById('btnAddList').addEventListener('click', () => openCalModal());
  document.getElementById('btnCalModalClose').addEventListener('click', closeCalModal);
  document.getElementById('btnCalCancel').addEventListener('click', closeCalModal);
  document.getElementById('btnCalSave').addEventListener('click', saveCalModal);
  document.querySelectorAll('#calTypeSwitcher button').forEach((b) => {
    b.addEventListener('click', () => setCalType(b.dataset.type));
  });
  document.getElementById('calModalMask').addEventListener('click', (e) => {
    if (e.target.id === 'calModalMask') closeCalModal();
  });
  document.getElementById('calModalMask').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCalModal();
  });

  // 飞书授权面板
  document.getElementById('btnFeishuAuthorize').addEventListener('click', authorizeFeishu);
  document.getElementById('btnFeishuSaveApp').addEventListener('click', saveFeishuApp);
  document.getElementById('btnFeishuRefresh').addEventListener('click', refreshFeishuCals);
  // 飞书授权窗口成功回调（window.opener.postMessage）
  window.addEventListener('message', (e) => {
    if (e.data && typeof e.data === 'object' && e.data.type === 'feishu-oauth-success') {
      onFeishuAuthSuccess();
    }
  });

  document.getElementById('btnModalClose').addEventListener('click', closeEditor);
  document.getElementById('btnCancel').addEventListener('click', closeEditor);
  document.getElementById('btnSave').addEventListener('click', saveEditor);
  document.getElementById('btnDelete').addEventListener('click', deleteEvent);

  const sw = document.getElementById('evAllDay');
  sw.addEventListener('click', () => {
    sw.classList.toggle('on');
    syncTimeVisibility();
  });

  document.getElementById('modalMask').addEventListener('click', (e) => {
    if (e.target.id === 'modalMask') closeEditor();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditor();
  });
}

async function init() {
  bindEvents();
  await loadCalendars();
  await refreshAll();
  backgroundSync();
}

init();
