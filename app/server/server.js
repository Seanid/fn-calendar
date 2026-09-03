#!/usr/bin/env node
/**
 * fn-calendar 日历应用后端服务
 *
 * 通过飞牛统一网关访问：监听 FNNAS_GATEWAY_SOCKET 指定的 Unix Socket，
 * 路由前缀为 FNNAS_GATEWAY_PREFIX（如 /app/fn-calendar）。
 *
 * 本地调试：未设置 FNNAS_GATEWAY_SOCKET 时，回退为监听 TCP 端口（PORT，默认 3000），
 * 此时可通过 http://localhost:3000 直接访问。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Solar, HolidayUtil } = require('lunar-javascript');
const ical = require('node-ical');

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const GATEWAY_SOCKET = process.env.FNNAS_GATEWAY_SOCKET || '';
const GATEWAY_PREFIX = (process.env.FNNAS_GATEWAY_PREFIX || '/app/fn-calendar').replace(/\/+$/, '');
const UI_DIR = process.env.UI_DIR || path.join(__dirname, '..', 'ui');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'var');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const CALENDARS_FILE = path.join(DATA_DIR, 'calendars.json');
const FEISHU_FILE = path.join(DATA_DIR, 'feishu.json');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const PORT = parseInt(process.env.PORT || '3000', 10);

/* ------------------------------------------------------------------ */
/* 事件存储（JSON 文件持久化，位于 var 目录，升级/卸载数据保留）            */
/* ------------------------------------------------------------------ */

function loadEvents() {
  try {
    if (fs.existsSync(EVENTS_FILE)) {
      const raw = fs.readFileSync(EVENTS_FILE, 'utf8');
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    }
  } catch (e) {
    console.error('[fn-calendar] 读取事件数据失败:', e.message);
  }
  return [];
}

function saveEvents(list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = EVENTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, EVENTS_FILE);
  } catch (e) {
    console.error('[fn-calendar] 保存事件数据失败:', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 远程日历源（CalDAV / ICS 订阅）                                      */
/* ------------------------------------------------------------------ */

function loadCalendars() {
  try {
    if (fs.existsSync(CALENDARS_FILE)) {
      const list = JSON.parse(fs.readFileSync(CALENDARS_FILE, 'utf8'));
      return Array.isArray(list) ? list : [];
    }
  } catch (e) {
    console.error('[fn-calendar] 读取日历源失败:', e.message);
  }
  return [];
}

function saveCalendars(list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CALENDARS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, CALENDARS_FILE);
  } catch (e) {
    console.error('[fn-calendar] 保存日历源失败:', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 飞书日历（OAuth 授权 + 开放平台 API）                                */
/* ------------------------------------------------------------------ */

// 允许通过环境变量覆盖飞书接口地址（主要用于本地/离线联调与自动化测试；默认指向线上）
const FEISHU_BASE = process.env.FEISHU_BASE || 'https://open.feishu.cn';
const FEISHU_AUTH = process.env.FEISHU_AUTH || 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';

let _appTokenCache = { token: '', expiresAt: 0 };

/** 读取飞书连接配置（appId/appSecret + 授权后的 user token） */
function loadFeishu() {
  try {
    if (fs.existsSync(FEISHU_FILE)) {
      return JSON.parse(fs.readFileSync(FEISHU_FILE, 'utf8')) || {};
    }
  } catch (e) {
    console.error('[fn-calendar] 读取飞书配置失败:', e.message);
  }
  return {};
}

function saveFeishu(cfg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FEISHU_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, FEISHU_FILE);
  } catch (e) {
    console.error('[fn-calendar] 保存飞书配置失败:', e.message);
  }
}

/** 请求飞书开放平台 JSON 接口；成功时返回 data，失败抛中文错误 */
async function feishuReq(apiPath, opts) {
  const o = opts || {};
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (o.auth === 'user') headers['Authorization'] = 'Bearer ' + (await feishuUserToken());
  else if (o.auth === 'app') headers['Authorization'] = 'Bearer ' + (await feishuAppToken());

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 20000);
  let resp;
  try {
    resp = await fetch(FEISHU_BASE + apiPath, {
      method: o.method || 'GET',
      headers,
      body: o.body ? JSON.stringify(o.body) : undefined,
      signal: timeout.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('请求飞书超时（20 秒）');
    throw new Error('无法连接飞书服务器：' + e.message);
  }
  clearTimeout(timer);

  let json = null;
  try { json = await resp.json(); } catch (e) { /* 非 JSON */ }
  if (!json || typeof json.code !== 'number') {
    throw new Error('飞书服务器响应异常（HTTP ' + resp.status + '）');
  }
  if (json.code !== 0) {
    const msg = json.msg || ('错误码 ' + json.code);
    // token 失效/过期：尝试刷新一次后重放
    if (o.auth === 'user' && o.retry !== false && /token/i.test(msg)) {
      try {
        await feishuRefreshToken();
        return feishuReq(apiPath, Object.assign({}, o, { retry: false }));
      } catch (e) { /* 刷新失败则抛原始错误 */ }
    }
    throw new Error('飞书接口错误：' + msg);
  }
  // 多数接口返回 { code, data }；少数（如 app_access_token/internal）把字段直接放在顶层
  return (json.data !== undefined) ? json.data : json;
}

/** app_access_token（自建应用凭证，缓存至过期） */
async function feishuAppToken() {
  const cfg = loadFeishu();
  if (!cfg.appId || !cfg.appSecret) throw new Error('尚未配置飞书应用凭证');
  if (_appTokenCache.token && _appTokenCache.expiresAt > Date.now() + 60000) {
    return _appTokenCache.token;
  }
  const data = await feishuReq('/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    auth: 'none',
    body: { app_id: cfg.appId, app_secret: cfg.appSecret },
  });
  _appTokenCache = { token: data.app_access_token, expiresAt: Date.now() + (data.expire || 7200) * 1000 };
  return data.app_access_token;
}

/** user_access_token：未过期直接用，将过期则用 refresh_token 刷新 */
async function feishuUserToken() {
  const cfg = loadFeishu();
  if (!cfg.accessToken) throw new Error('尚未授权飞书账号');
  if (cfg.tokenExpiresAt && cfg.tokenExpiresAt > Date.now() + 120000) return cfg.accessToken;
  if (cfg.refreshToken) {
    try { return await feishuRefreshToken(); } catch (e) { /* 继续用旧 token 尝试 */ }
  }
  return cfg.accessToken;
}

/** 用 refresh_token 换新 user token */
async function feishuRefreshToken() {
  const cfg = loadFeishu();
  if (!cfg.refreshToken) throw new Error('缺少 refresh_token，请重新授权');
  const data = await feishuReq('/open-apis/authen/v1/oidc/refresh_access_token', {
    method: 'POST',
    auth: 'app',
    body: { grant_type: 'refresh_token', refresh_token: cfg.refreshToken },
  });
  cfg.accessToken = data.access_token;
  cfg.refreshToken = data.refresh_token;
  cfg.tokenExpiresAt = Date.now() + (data.expires_in || 7200) * 1000;
  saveFeishu(cfg);
  return cfg.accessToken;
}

/** 生成飞书 OAuth 授权链接（含回调地址与随机 state） */
function feishuAuthUrl(cfg, req) {
  const host = req.headers['host'] || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const redirectUri = proto + '://' + host + GATEWAY_PREFIX + '/feishu/oauth/callback';
  cfg.pendingState = crypto.randomBytes(16).toString('hex');
  saveFeishu(cfg);
  const q = new URLSearchParams({
    app_id: cfg.appId,
    redirect_uri: redirectUri,
    scope: 'calendar:calendar',
    state: cfg.pendingState,
  });
  return { url: FEISHU_AUTH + '?' + q.toString(), redirectUri };
}

/** 换取日历读写权限所需 scope 说明（引导文案用） */
const FEISHU_SCOPE_HINT =
  '请确认飞书开放平台应用已开通权限 calendar:calendar（读写）并发布版本；' +
  '在「安全设置 → 重定向 URL」中登记上方回调地址（与授权弹窗中一致）。';

/** 拉取当前授权用户可访问的日历列表（含 role/权限） */
async function feishuListCalendars() {
  const out = [];
  let pageToken = '';
  for (let guard = 0; guard < 20; guard++) {
    const q = new URLSearchParams({ page_size: '50' });
    if (pageToken) q.set('page_token', pageToken);
    const data = await feishuReq('/open-apis/calendar/v4/calendars?' + q.toString(), { auth: 'user' });
    for (const cal of data.calendar_list || []) {
      out.push({
        calendarId: cal.calendar_id,
        summary: cal.summary || '(未命名日历)',
        role: cal.role || 'unknown',
        color: cal.color || '',
      });
    }
    if (data.has_more && data.page_token) pageToken = data.page_token;
    else break;
  }
  return out;
}

/** 飞书日程 JSON → 内部事件（沿用远端 cache 事件结构） */
function feishuEventToInternal(ev, fid, cname, ccolor) {
  const startRaw = (ev.start_time || {});
  const endRaw = (ev.end_time || {});
  const allDay = !!ev.is_all_day || (!!startRaw.date && !startRaw.timestamp);
  const fmt = (ts) => {
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const start = startRaw.timestamp ? fmt(Number(startRaw.timestamp)) : (startRaw.date || '');
  // 全天：飞书 date 结束日期含当天（内部 end 为最后一天，直接沿用）；非全天用 timestamp
  const end = allDay
    ? (endRaw.date || startRaw.date || start)
    : (endRaw.timestamp ? fmt(Number(endRaw.timestamp)) : start);
  return {
    id: ev.event_id + (ev.recurring_event_id && ev.recurring_event_id !== ev.event_id ? '@' + ev.event_id : ''),
    title: ev.summary && String(ev.summary).trim() ? String(ev.summary) : '（无标题）',
    start,
    end,
    allDay,
    location: (ev.location && ev.location.name) ? String(ev.location.name) : '',
    description: ev.description || '',
    remote: true,
    calendarId: fid,
    calendarName: cname,
    calendarColor: ccolor,
  };
}

/** 飞书日历事件列表拉取 → 内部事件数组（含循环日程 RRULE 展开与例外替换） */
async function fetchFeishuEvents(cal, from, to) {
  const list = await feishuApiEvents(cal.feishuCalendarId, from, to);
  const out = [];       // 最终内部事件
  const seriesMeta = []; // { fe } 循环系列主事件（含 recurrence）
  const single = [];     // 单次事件（非系列、非系列派生实例）
  const removeKeys = new Set(); // 被删除/取消实例的“原时间”（分钟粒度），用于从系列展开结果中剔除

  /**
   * 记录一个需从系列展开中剔除的原时间。
   * 飞书把「循环日程的某个实例被删除」表示为 status=cancelled 的例外项，
   * 其原时间可从 event_id 尾部 `_{original_time}` 解析；解析不到时退化为用 start_time 定位。
   */
  const addRemoveKey = (fe) => {
    let ori = 0;
    const m = /_(\d{9,11})$/.exec(fe.event_id || '');
    if (m) ori = Number(m[1]);
    if (!ori && fe.start_time && fe.start_time.timestamp) ori = Number(fe.start_time.timestamp);
    if (ori && ori > 100000000) removeKeys.add('ts' + Math.floor(ori / 1000 / 60));
  };

  for (const fe of list) {
    // status === 'cancelled'（注意飞书写 cancelled）：日程已被删除。
    // 被删的普通日程只剩空标题的时间占位；被删的系列主事件不应再展开；
    // 被删的系列单次实例（例外）只用于把该次实例从展开结果中剔除，都不再展示。
    if (fe.status === 'cancelled') {
      if (fe.recurring_event_id || fe.is_exception) addRemoveKey(fe);
      continue;
    }
    // recurring_event_id 存在且无 recurrence → 是系列在窗口内的派生实例快照（无独立时间信息用于完整展开），跳过
    if (fe.recurring_event_id && !fe.recurrence) continue;
    if (fe.recurrence) seriesMeta.push(fe);
    else single.push(fe);
  }

  // 1) 循环系列：展开为窗口内实例
  for (const fe of seriesMeta) {
    const base = feishuEventToInternal(fe, cal.id, cal.name, cal.color);
    out.push(...expandFeishuSeries(base, fe, from, to));
  }

  // 2) 例外实例（exceptions）：优先级最高——展开结果中与例外原时间冲突的实例移除，以例外为准；
  //    status=cancelled 的例外表示该次实例被删除（飞书会清空标题），只剔除实例、不补回占位。
  const overrideEvs = [];
  for (const fe of seriesMeta) {
    for (const ex of (fe.exceptions || [])) {
      const ori = ex.original_time ? Number((ex.original_time.timestamp) || 0) : 0;
      if (ori) removeKeys.add('ts' + Math.floor(ori / 1000 / 60)); // 分钟粒度匹配
      if (ex.status === 'cancelled') continue; // 删除实例：仅剔除，不再生成事件
      const base = feishuEventToInternal(ex, cal.id, cal.name, cal.color);
      if (!base.title || base.title === '（无标题）') base.title = fe.summary || '（无标题）';
      overrideEvs.push(base);
    }
  }
  if (removeKeys.size) {
    for (let i = out.length - 1; i >= 0; i--) {
      const s = out[i].allDay ? (parseDate(out[i].start) || new Date(NaN)).getTime() : new Date(out[i].start).getTime();
      if (!isNaN(s) && removeKeys.has('ts' + Math.floor(s / 1000 / 60))) out.splice(i, 1);
    }
  }
  out.push(...overrideEvs);

  // 3) 单次事件（含非循环 standalone 与可能的主日历单次实例）
  for (const fe of single) out.push(feishuEventToInternal(fe, cal.id, cal.name, cal.color));

  // 按 id 去重（例外 override 与系列展开结果可能产生同 id 事件）
  const seen = new Set();
  return out.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

/** 分页拉取飞书日历时间窗内全部事件（REST 原语） */
async function feishuApiEvents(calendarId, from, to) {
  const out = [];
  let pageToken = '';
  const q = new URLSearchParams({
    start_time: String(Math.floor(from.getTime() / 1000)),
    end_time: String(Math.floor(to.getTime() / 1000)),
    page_size: '500',
  });
  for (let guard = 0; guard < 50; guard++) {
    if (pageToken) q.set('page_token', pageToken);
    const data = await feishuReq('/open-apis/calendar/v4/calendars/' + encodeURIComponent(calendarId) + '/events?' + q.toString(), { auth: 'user' });
    for (const it of data.items || []) out.push(it);
    if (data.has_more && data.page_token) pageToken = data.page_token;
    else break;
  }
  return out;
}

/**
 * 展开飞书循环系列为窗口内实例：把系列转成单个 VEVENT 文本，
 * 复用 node-ical（parseICSContent）的 RRULE 展开 + 全天语义 + 时间窗过滤。
 */
function expandFeishuSeries(seriesEv, fe, from, to) {
  const startDate = seriesEv.allDay ? parseDate(seriesEv.start) : new Date(seriesEv.start);
  const endDate = seriesEv.allDay ? parseDate(seriesEv.end) : new Date(seriesEv.end);
  if (!startDate || isNaN(startDate.getTime()) || !endDate || isNaN(endDate.getTime())) return [seriesEv];

  const rrule = String(fe.recurrence || '').replace(/\\n/g, '\n').trim();
  let vevent = '';
  try {
    // 非全天用 UTC（'Z'）：node-ical 对 Z 时区解析与 RRULE 展开最成熟；
    // 中国无夏令时，UTC 展开不会造成实例时间漂移，parseICSContent 输出时会转回本地时区。
    const p = (n) => String(n).padStart(2, '0');
    const dtUtc = (d) => `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`;
    const dtDate = (d) => `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
    const endRaw = seriesEv.allDay ? new Date(endDate.getTime() + 24 * 3600 * 1000) : endDate; // ICS 全天 DTEND 排他
    const parts = [
      'BEGIN:VEVENT',
      'UID:' + fe.event_id,
      'DTSTAMP:19700101T000000Z',
      'SUMMARY:' + esc(seriesEv.title),
      (seriesEv.allDay ? 'DTSTART;VALUE=DATE:' + dtDate(startDate) : 'DTSTART:' + dtUtc(startDate)),
      (seriesEv.allDay ? 'DTEND;VALUE=DATE:' + dtDate(endRaw) : 'DTEND:' + dtUtc(endRaw)),
    ];
    // RRULE 是属性值而非 TEXT：逗号/分号不可转义（转义会被 rrule 解析为字面符导致 FREQ 无效）
    if (rrule) parts.push('RRULE:' + rrule);
    parts.push('END:VEVENT');
    vevent = parts.join('\r\n');
  } catch (e) {
    return [seriesEv];
  }

  let expanded;
  try {
    expanded = parseICSContent(vevent);
  } catch (e) {
    return [seriesEv];
  }
  // parseICSContent 展开窗口为内置（过去2年~未来3年），此处按调用方时间窗再次收窄
  const fMs = from.getTime(), tMs = to.getTime();
  expanded = expanded.filter((x) => {
    const s = x.allDay ? (parseDate(x.start) || new Date(NaN)) : new Date(x.start);
    return !isNaN(s.getTime()) && s.getTime() >= fMs && s.getTime() < tMs;
  });
  return expanded.map((x) => Object.assign({}, x, {
    remote: true,
    calendarId: seriesEv.calendarId,
    calendarName: seriesEv.calendarName,
    calendarColor: seriesEv.calendarColor,
  }));
}

/** 在飞书上创建一个日程，返回飞书事件 JSON */
async function feishuCreateEvent(cal, body) {
  const allDay = !!body.allDay;
  const startT = allDay ? parseDate(body.start) : new Date(body.start);
  const endT = allDay ? parseDate(body.end) : new Date(body.end);
  if (!startT || isNaN(startT.getTime()) || !endT || isNaN(endT.getTime())) {
    throw new Error('时间格式无效');
  }
  const payload = {
    summary: body.title,
    start_time: {},
    end_time: {},
  };
  if (body.notes) payload.description = String(body.notes);
  if (allDay) {
    const p = (n) => String(n).padStart(2, '0');
    payload.is_all_day = true;
    // 飞书全天事件 date 字段：结束日期含当天
    payload.start_time.date = `${startT.getFullYear()}-${p(startT.getMonth() + 1)}-${p(startT.getDate())}`;
    payload.end_time.date = `${endT.getFullYear()}-${p(endT.getMonth() + 1)}-${p(endT.getDate())}`;
  } else {
    const tz = 'Asia/Shanghai';
    payload.start_time = { timestamp: String(Math.floor(startT.getTime() / 1000)), timezone: tz };
    payload.end_time = { timestamp: String(Math.floor(endT.getTime() / 1000)), timezone: tz };
  }
  const data = await feishuReq('/open-apis/calendar/v4/calendars/' + encodeURIComponent(cal.feishuCalendarId) + '/events', {
    method: 'POST',
    auth: 'user',
    body: payload,
  });
  return data.event;
}

/**
 * 判断内部缓存 id 是否属于「重复日程的展开实例」。
 * 展开实例 id = '{系列主event_id}#{实例起始时间戳}'（见 parseICSContent / expandFeishuSeries）；
 * 非重复日程的缓存 id 就是飞书 event_id 本身（无 '#'）。
 * 返回系列主 event_id；非实例返回 null。
 */
function feishuSeriesId(internalId) {
  const s = String(internalId || '');
  const i = s.indexOf('#');
  return i > 0 ? s.slice(0, i) : null;
}

/**
 * 更新飞书日历上的一个日程（PATCH）。
 * 非重复日程：标题/备注/时间均可改；重复系列的展开实例：仅允许文本字段（作用于整个系列），
 * 时间/全天字段原样保留（飞书对单实例改期需在其客户端创建「例外」，无直接 API）。
 * 注意：飞书 PATCH 成功响应不含事件体，缓存由调用方基于本地数据回填。
 */
async function feishuUpdateEvent(cal, internalId, body) {
  const seriesId = feishuSeriesId(internalId);
  const evId = seriesId || internalId; // 请求飞书用的 event_id
  const apiBase = '/open-apis/calendar/v4/calendars/' + encodeURIComponent(cal.feishuCalendarId) + '/events/' + encodeURIComponent(evId);
  const cachedAllDay = loadCache(cal.id).find((e) => e.id === internalId);
  const curAllDay = !!(cachedAllDay && cachedAllDay.allDay);

  const payload = {};
  if (body.title !== undefined && String(body.title).trim()) payload.summary = String(body.title).trim();
  if (body.notes !== undefined) payload.description = String(body.notes || '');

  if (seriesId) {
    // 重复系列：不允许修改单次时间/全天（语义上会改变整个系列起始，容易误伤），仅文本字段更新
    if (body.start !== undefined || body.end !== undefined || body.allDay !== undefined) {
      throw new Error('该日程为重复日程的某次实例，暂不支持单独修改时间；如要调整请到飞书客户端操作该次日程');
    }
  } else {
    // 非重复日程：时间/全天同步修改（PATCH 语义与 create 相同的时间结构）
    if (body.allDay !== undefined && !!body.allDay !== curAllDay) {
      throw new Error('暂不支持切换日程的全天/定时类型，请到飞书客户端操作');
    }
    if (body.start !== undefined || body.end !== undefined) {
      const allDay = body.allDay !== undefined ? !!body.allDay : curAllDay;
      const startT = allDay ? parseDate(body.start) : body.start ? new Date(body.start) : null;
      const endT = allDay ? parseDate(body.end) : body.end ? new Date(body.end) : null;
      if (!startT || isNaN(startT.getTime()) || !endT || isNaN(endT.getTime())) {
        throw new Error('时间格式无效');
      }
      const p = (n) => String(n).padStart(2, '0');
      if (allDay) {
        payload.start_time = { date: `${startT.getFullYear()}-${p(startT.getMonth() + 1)}-${p(startT.getDate())}` };
        payload.end_time = { date: `${endT.getFullYear()}-${p(endT.getMonth() + 1)}-${p(endT.getDate())}` };
      } else {
        payload.start_time = { timestamp: String(Math.floor(startT.getTime() / 1000)), timezone: 'Asia/Shanghai' };
        payload.end_time = { timestamp: String(Math.floor(endT.getTime() / 1000)), timezone: 'Asia/Shanghai' };
      }
    }
  }

  if (!Object.keys(payload).length) return; // 无变更字段，静默成功
  await feishuReq(apiBase, { method: 'PATCH', auth: 'user', body: payload });
}

/** 删除飞书日历上的一个日程（DELETE）。重复系列展开实例禁止单次删除。 */
async function feishuDeleteEvent(cal, internalId) {
  const seriesId = feishuSeriesId(internalId);
  if (seriesId) {
    throw new Error('该日程为重复日程的某次实例，暂不支持删除单次；可到飞书客户端删除该次或整个系列');
  }
  await feishuReq('/open-apis/calendar/v4/calendars/' + encodeURIComponent(cal.feishuCalendarId) + '/events/' + encodeURIComponent(internalId), {
    method: 'DELETE',
    auth: 'user',
  });
}

/** 飞书 user_info（显示授权账号名） */
async function feishuUserInfo() {
  const data = await feishuReq('/open-apis/authen/v1/user_info', { auth: 'user' });
  return { openId: data.open_id || '', name: data.name || data.en_name || '' };
}

/** 计算远程源同步窗口（与 CalDAV/ICS 一致：过去 2 年 ~ 未来 3 年） */
function syncWindow() {
  const now = new Date();
  return {
    from: new Date(now.getFullYear() - 2, now.getMonth(), now.getDate()),
    to: new Date(now.getFullYear() + 3, now.getMonth(), now.getDate()),
  };
}

function cacheFile(id) {
  return path.join(CACHE_DIR, id + '.json');
}

function loadCache(id) {
  try {
    if (fs.existsSync(cacheFile(id))) {
      const list = JSON.parse(fs.readFileSync(cacheFile(id), 'utf8'));
      return Array.isArray(list) ? list : [];
    }
  } catch (e) { /* 忽略损坏的缓存 */ }
  return [];
}

function saveCache(id, events) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = cacheFile(id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(events), 'utf8');
    fs.renameSync(tmp, cacheFile(id));
  } catch (e) {
    console.error('[fn-calendar] 写入缓存失败:', e.message);
  }
}

function fmtLocalDT(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtLocalDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** CalDAV HTTP 状态 → 中文可读信息 */
function caldavHttpErr(status) {
  const map = {
    401: '认证失败：用户名或密码不正确',
    403: '无访问权限：该账号可能没有此日历的读取权限，或需要在日历服务端重新生成专用密码',
    400: '服务器拒绝了该请求：地址可能不是有效的 CalDAV 日历地址',
    404: '地址不存在（404）：请检查 URL 是否正确',
    408: '请求超时',
    429: '请求过于频繁（429），请稍后重试',
  };
  return map[status] || ('服务器返回 HTTP ' + status);
}

/** 以 UTC 生成 CalDAV time-range 用的 yyyyMMdd'T'HHmmss'Z' */
function fmtCalUTC(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

const DAV_TAG = '(?:[A-Za-z0-9-]+:)?';

/** 从 multistatus XML 中提取 calendar-data 文本块（反转义 XML 实体） */
function extractCalendarData(xml) {
  const blocks = [];
  const re = new RegExp(`<${DAV_TAG}calendar-data[^>]*>([\\s\\S]*?)<\\/${DAV_TAG}calendar-data>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&amp;/g, '&'));
  }
  return blocks;
}

/** multistatus 中是否存在日程资源引用（.ics 的 href），用于区分“无数据”与“拒绝下发数据” */
function hasEventRefs(xml) {
  return new RegExp(`<${DAV_TAG}href>[^<]+\\.ics<\\/${DAV_TAG}href>`, 'i').test(xml);
}

/** 规范化相对 href 为绝对 URL */
function davAbsHref(href, baseUrl) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) return h;
  const b = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  try { return new URL(h, b).href; } catch (e) { return ''; }
}

/**
 * CalDAV 日历集合自动发现：
 * 1) 目标 URL 本身是 calendar 集合 → 直接用；
 * 2) 否则 PROPFIND 找 calendar-home-set，枚举其下 resourcetype 含 calendar 的集合；
 * 3) 无法发现时退化为 [baseUrl]（直接对其 REPORT）。
 * 认证失败(401/403)直接抛出便于上层提示。
 */
async function discoverCalDavCollections(baseUrl, headers, signal) {
  const propBody = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:resourcetype/><D:displayname/><C:calendar-home-set/></D:prop>
</D:propfind>`;
  const pfHeaders = Object.assign({}, headers, { 'Content-Type': 'application/xml; charset=utf-8' });

  try {
    const r0 = await fetch(baseUrl, { method: 'PROPFIND', headers: Object.assign({}, pfHeaders, { 'Depth': '0' }), body: propBody, signal });
    if (r0.status === 401 || r0.status === 403) throw new Error(caldavHttpErr(r0.status));
    const xml0 = r0.ok ? await r0.text() : '';

    // 1) 目标本身就是 calendar 集合
    if (new RegExp(`<${DAV_TAG}resourcetype>[\\s\\S]*?<${DAV_TAG}calendar\\s*\\/?>`, 'i').test(xml0)) {
      return [baseUrl];
    }

    // 2) 找 calendar-home-set 并枚举子日历
    const homeRe = new RegExp(`<${DAV_TAG}calendar-home-set[^>]*>[\\s\\S]*?<${DAV_TAG}href>([^<]+)<\\/${DAV_TAG}href>`, 'i');
    const homeMatch = xml0.match(homeRe);
    const home = homeMatch ? davAbsHref(homeMatch[1], baseUrl) : '';
    if (home) {
      const r1 = await fetch(home, { method: 'PROPFIND', headers: Object.assign({}, pfHeaders, { 'Depth': '1' }), body: propBody, signal });
      if (r1.ok) {
        const xml1 = await r1.text();
        const out = [];
        const blocks = xml1.match(new RegExp(`<${DAV_TAG}response>[\\s\\S]*?<\\/${DAV_TAG}response>`, 'gi')) || [];
        for (const blk of blocks) {
          const isCal = new RegExp(`<${DAV_TAG}resourcetype>[\\s\\S]*?<${DAV_TAG}calendar\\s*\\/?>`, 'i').test(blk);
          if (!isCal) continue;
          const h = blk.match(new RegExp(`<${DAV_TAG}href>([^<]+)<\\/${DAV_TAG}href>`, 'i'));
          const abs = h ? davAbsHref(h[1], home) : '';
          if (abs && !out.includes(abs)) out.push(abs);
        }
        if (out.length) return out;
      }
    }
    // 3) 退化
    return [baseUrl];
  } catch (e) {
    // 认证/权限错误透传；网络错误等其它情况退化为直接 REPORT
    if (/认证|权限/.test(e.message)) throw e;
    return [baseUrl];
  }
}

/** 构造 REPORT calendar-query 请求体（time-range 窗口） */
function caldavQueryBody(from, to) {
  return `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${fmtCalUTC(from)}" end="${fmtCalUTC(to)}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
}

/** XML 文本转义（用于把 href 嵌入 multiget 请求体） */
function escapeXmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 构造 REPORT calendar-multiget 请求体（按 href 批量拉取日程正文） */
function caldavMultigetBody(hrefs) {
  const rows = [...new Set(hrefs)].map((h) => `  <D:href>${escapeXmlText(h)}</D:href>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
${rows}
</C:calendar-multiget>`;
}

/**
 * 把 multistatus 里的 href 规范化为“可直接回填给 multiget”的根相对路径。
 * 飞书要求 multiget 的 href 前缀必须与所 REPORT 集合一致（如 /u_xxx/<uuid>/ev.ics），
 * 服务器在 query 响应中返回的就是这种格式，原样透传即可；绝对 URL / 相对 href 也在此归一化。
 */
function davPathHref(href, colUrl) {
  let h = String(href || '').trim();
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) {
    try { h = new URL(h).pathname; } catch (e) { return ''; }
  }
  if (!h.startsWith('/')) {
    try {
      const cp = new URL(colUrl).pathname;
      h = (cp.endsWith('/') ? cp : cp + '/') + h;
    } catch (e) { return h; }
  }
  return h;
}

/** 从 multistatus XML 中提取所有日程资源 href（.ics 结尾） */
function extractEventHrefs(xml) {
  const out = [];
  const re = new RegExp(`<${DAV_TAG}href>([^<]+)<\\/${DAV_TAG}href>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const h = m[1].trim();
    if (/\.ics$/i.test(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

/** 抓取远程日历内容，返回 ICS 文本 */
async function fetchRemoteICS(cal) {
  let url = (cal.url || '').trim();
  if (/^webcal:\/\//i.test(url)) url = 'https://' + url.slice(9);
  if (!/^https?:\/\//i.test(url)) throw new Error('无效的 URL（仅支持 http/https/webcal）');

  const headers = {
    'User-Agent': 'fn-calendar/1.0 (fnOS)',
    'Accept': 'text/calendar, application/xml, text/xml, */*',
  };
  if (cal.username) {
    headers['Authorization'] = 'Basic ' + Buffer.from(cal.username + ':' + (cal.password || '')).toString('base64');
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 20000);

  try {
    if (cal.type === 'caldav') {
      // CalDAV：自动发现日历集合 → calendar-query 拿事件引用 → calendar-multiget 拉正文。
      // 注意：飞书等（CalendarServer 魔改）在 calendar-query 里永远不回传 calendar-data（恒 404），
      // 只给 href/etag，正文必须用 calendar-multiget 按集合前缀 href 二次拉取。
      const now = new Date();
      const from = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
      const to = new Date(now.getFullYear() + 3, now.getMonth(), now.getDate());
      const queryBody = caldavQueryBody(from, to);
      const reportHeaders = Object.assign({}, headers, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '1',
      });

      const collections = await discoverCalDavCollections(url, headers, timeout.signal);
      const colHrefs = new Map(); // 集合 -> 事件 href 数组
      let queryOk207 = false;
      let lastStatus = 0;
      let sawAuthIssue = false;
      let queryXml = '';

      // 第 1 步：calendar-query（时间窗口内的事件引用）。
      // 个别服务端偶发返回空/部分引用，故对每个集合最多查 2 轮取 href 并集：
      // 第 1 轮拿到引用后，第 2 轮若无新引用即视为收敛（不影响正常同步速度）。
      const MAX_QUERY_ROUNDS = 4;
      for (const col of collections) {
        const unionHrefs = [];
        let noGrowthStreak = 0;
        for (let round = 1; round <= MAX_QUERY_ROUNDS; round++) {
          try {
            const resp = await fetch(col, { method: 'REPORT', headers: reportHeaders, body: queryBody, signal: timeout.signal });
            lastStatus = resp.status;
            if (resp.status === 401 || resp.status === 403) { sawAuthIssue = true; break; }
            if (!resp.ok) continue; // 下一轮重试 / 尝试下一个发现的集合
            const xml = await resp.text();
            queryXml += xml;
            queryOk207 = true;
            // 若标准服务器直接在 query 里回了正文，直接使用
            const blocks = extractCalendarData(xml);
            if (blocks.length) return blocks.join('\r\n');
            const hrefs = extractEventHrefs(xml);
            const before = unionHrefs.length;
            for (const h of hrefs) if (!unionHrefs.includes(h)) unionHrefs.push(h);
            noGrowthStreak = unionHrefs.length === before ? noGrowthStreak + 1 : 0;
            // 已有引用且本轮未发现新引用（第 1 轮结果被第 2 轮确认）→ 收敛，停止重复查询
            if (unionHrefs.length && noGrowthStreak >= 1 && round >= 2) break;
          } catch (e) {
            if (e.name === 'AbortError') throw new Error('请求超时（20 秒）');
            throw e;
          }
        }
        if (unionHrefs.length) colHrefs.set(col, unionHrefs);
      }
      if (sawAuthIssue) throw new Error(caldavHttpErr(401)); // 该凭据连发现的日历都无法读取

      // 第 2 步：calendar-multiget 按 href 批量拉正文（每批 50）。
      // 同一日历若被不同前缀集合重复发现，multiget 会返回字节相同的 calendar-data，
      // 用 Set 按正文内容去重，避免重复事件。
      const dataBlocks = [];
      const seenBlocks = new Set();
      for (const [col, hrefs] of colHrefs) {
        for (let i = 0; i < hrefs.length; i += 50) {
          const batch = hrefs.slice(i, i + 50).map((h) => davPathHref(h, col));
          try {
            const resp = await fetch(col, { method: 'REPORT', headers: reportHeaders, body: caldavMultigetBody(batch), signal: timeout.signal });
            if (resp.ok) {
              for (const blk of extractCalendarData(await resp.text())) {
                if (!seenBlocks.has(blk)) { seenBlocks.add(blk); dataBlocks.push(blk); }
              }
            }
          } catch (e) {
            if (e.name === 'AbortError') throw new Error('请求超时（20 秒）');
            throw e;
          }
        }
      }
      if (dataBlocks.length) return dataBlocks.join('\r\n');

      // 兜底诊断
      if (!colHrefs.size) {
        if (queryOk207) return ''; // 查询成功但区间内无日程（空日历/窗口内没有事件）——合法空结果
        if (hasEventRefs(queryXml)) return ''; // 极端情况：有引用但非 .ics 结尾，按空处理避免误报
      }
      if (hasEventRefs(queryXml)) {
        // 有事件引用但 multiget 全部未返回正文
        throw new Error('服务器返回了日程引用，但未能拉取日程内容（calendar-multiget 未返回数据）。请确认该账号具备完整读取权限后重试');
      }
      throw new Error(lastStatus ? caldavHttpErr(lastStatus) : '无法连接 CalDAV 服务器，请检查地址与网络');
    }

    // ICS 订阅：直接 GET
    const resp = await fetch(url, { headers, signal: timeout.signal });
    if (!resp.ok) throw new Error(`服务器返回 ${resp.status}`);
    return await resp.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时（20 秒）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把可能包含多个 VCALENDAR 的文本拆成独立块。
 * node-ical 解析拼接后的多块文本只会保留最后一块（实测），
 * 因此必须按 BEGIN:VCALENDAR...END:VCALENDAR 逐个切分后分别解析。
 */
function splitIcsBlocks(text) {
  const t = String(text || '');
  const re = /BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/g;
  const out = [];
  let m;
  while ((m = re.exec(t)) !== null) out.push(m[0]);
  return out.length ? out : (t.trim() ? [t] : []);
}

/** 解析 ICS 文本为内部事件格式（逐块解析后合并，展开循环事件，窗口：过去2年 ~ 未来3年） */
function parseICSContent(icsBlocks) {
  const out = [];
  const now = new Date();
  const from = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
  const to = new Date(now.getFullYear() + 3, now.getMonth(), now.getDate());

  for (const chunk of splitIcsBlocks(icsBlocks)) {
    let parsed;
    try {
      parsed = ical.sync.parseICS(chunk);
    } catch (e) {
      console.error('[fn-calendar] 解析 ICS 块失败:', e.message);
      continue;
    }
    const raw = Object.values(parsed).filter((o) => o.type === 'VEVENT');

    for (const ev of raw) {
      if (!ev.start || !ev.summary) continue;
      const allDay = ev.datetype === 'date';
      const durationMs = ev.end && ev.start ? ev.end.getTime() - ev.start.getTime() : 3600000;

      let instances = [ev];
      if (ev.rrule) {
        try {
          instances = ical.expandRecurringEvent(ev, { from, to });
        } catch (e) {
          console.error('[fn-calendar] 展开循环事件失败:', e.message);
          instances = [ev];
        }
      }

      for (const inst of instances) {
        if (!inst.start) continue;
        const start = inst.start;
        let end = new Date(start.getTime() + durationMs);
        // ICS 全天事件的 DTEND 是排他语义（exclusive），内部存储为包含语义（end 为最后一天）
        if (allDay && end.getTime() > start.getTime()) {
          end = new Date(end.getTime() - 24 * 60 * 60 * 1000);
        }
        // 循环展开后的每个实例需要唯一 id：node-ical 展开结果不带 recurrenceId，
        // 这里用“起始时间戳”做后缀，避免同一系列的多条实例共享同一个 id。
        const instSuffix = inst.recurrenceId
          ? '-' + inst.recurrenceId.toISOString()
          : (ev.rrule ? '#' + start.getTime() : '');
        out.push({
          id: ev.uid + instSuffix,
          title: String(ev.summary),
          start: allDay ? fmtLocalDate(start) : fmtLocalDT(start),
          end: allDay ? fmtLocalDate(end) : fmtLocalDT(end),
          allDay,
          location: ev.location ? String(ev.location) : '',
        });
      }
    }
  }

  // 按 id 去重（同一 uid 的例外实例/跨块重复时保证唯一）
  const seen = new Set();
  return out.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

/** 同步单个日历源 */
async function syncCalendar(cal) {
  try {
    if (cal.type === 'feishu') {
      // 飞书日历：走开放平台 REST（OAuth 授权），事件缓存与 CalDAV/ICS 同一机制
      const win = syncWindow();
      const events = await fetchFeishuEvents(cal, win.from, win.to);
      saveCache(cal.id, events);
      cal.lastSync = new Date().toISOString();
      cal.lastError = '';
      cal.eventCount = events.length;
      return cal;
    }
    const icsText = await fetchRemoteICS(cal);
    const events = parseICSContent(icsText);
    saveCache(cal.id, events);
    cal.lastSync = new Date().toISOString();
    cal.lastError = '';
    cal.eventCount = events.length;
  } catch (e) {
    cal.lastError = e.message;
    console.error(`[fn-calendar] 同步日历源 ${cal.name} 失败:`, e.message);
  }
  return cal;
}

/** 日历源信息（不含密码） */
function publicCalendar(cal) {
  const pub = {
    id: cal.id,
    name: cal.name,
    url: cal.url,
    type: cal.type,
    username: cal.username || '',
    color: cal.color || 'purple',
    lastSync: cal.lastSync || '',
    lastError: cal.lastError || '',
    eventCount: cal.eventCount || 0,
    hasPassword: !!cal.password,
  };
  if (cal.type === 'feishu') {
    pub.feishuCalendarId = cal.feishuCalendarId || '';
    pub.feishuSummary = cal.feishuSummary || '';
    pub.feishuRole = cal.feishuRole || '';
  }
  return pub;
}

/** 判断某日历源是否可写入日程（本地个人日历之外，仅飞书日历支持写回） */
function isWritableCalendar(cal) {
  return !!cal && cal.type === 'feishu' && !!cal.feishuCalendarId;
}

/* ------------------------------------------------------------------ */
/* 农历 / 日历数据                                                      */
/* ------------------------------------------------------------------ */

function buildDayInfo(y, m, d) {
  const solar = Solar.fromYmd(y, m, d);
  const lunar = solar.getLunar();

  const festivals = lunar.getFestivals().concat(lunar.getOtherFestivals());
  const holiday = HolidayUtil.getHoliday(y, m, d);

  return {
    year: y,
    month: m,
    day: d,
    weekday: solar.getWeek(), // 0=周日
    lunar: {
      monthCn: lunar.getMonthInChinese(),
      dayCn: lunar.getDayInChinese(),
      jieQi: lunar.getJieQi(), // 节气（非节气日为空串）
      festivals, // 农历节日 + 公历节日
      holiday: holiday ? { name: holiday.getName(), work: holiday.isWork() } : null,
      ganZhiYear: lunar.getYearInGanZhi(),
      shengXiao: lunar.getYearShengXiao(),
      dayYi: lunar.getDayYi(),
      dayJi: lunar.getDayJi(),
    },
  };
}

/** 生成某月的完整日历网格（周日起始，5~6 行），含农历与事件 */
function buildMonthData(year, month, events) {
  const first = new Date(year, month - 1, 1);
  const firstWeekday = first.getDay(); // 0=周日
  const daysInMonth = new Date(year, month, 0).getDate();
  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const gridStart = new Date(year, month - 1, 1 - firstWeekday);

  const today = new Date();
  const todayStr = fmtDate(today);

  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    const dt = new Date(gridStart);
    dt.setDate(gridStart.getDate() + i);
    const c = buildDayInfo(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
    c.inMonth = dt.getMonth() + 1 === month;
    c.isToday = fmtDate(dt) === todayStr;
    c.events = events.filter((ev) => eventOverlapsDay(ev, dt));
    cells.push(c);
  }

  return {
    year,
    month,
    today: todayStr,
    cells,
  };
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseDate(str) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(str || '');
  if (!m) return null;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d);
}

/** 事件是否覆盖某天 */
function eventOverlapsDay(ev, dt) {
  const dayStart = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const dayEnd = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1);
  if (ev.allDay) {
    const es = parseDate(ev.start);
    const ee = parseDate(ev.end);
    if (!es || !ee) return false;
    const eEnd = new Date(ee.getFullYear(), ee.getMonth(), ee.getDate() + 1);
    return es < dayEnd && eEnd > dayStart;
  }
  const es = new Date(ev.start);
  const ee = new Date(ev.end);
  return es < dayEnd && ee > dayStart;
}

/* ------------------------------------------------------------------ */
/* HTTP 路由                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

// 服务 index.html：注入 <base> 标签，使相对资源（styles.css / app.js / images/）
// 在网关前缀路径（如 /app/fn-calendar，无尾斜杠）下也能正确解析，
// 否则浏览器会把 styles.css 解析成 /app/styles.css 导致 404。
function serveIndex(res, basePath) {
  const filePath = path.join(UI_DIR, 'index.html');
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) {
      return sendText(res, 404, 'Not Found');
    }
    const baseHref = basePath ? basePath + '/' : '/';
    const out = html.replace(
      '<head>',
      '<head>\n  <base href="' + baseHref + '">'
    );
    const data = Buffer.from(out, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function serveStatic(res, urlPath) {
  // 防止路径穿越
  let rel = decodeURIComponent(urlPath);
  if (rel.startsWith('/')) rel = rel.slice(1);
  const filePath = path.normalize(path.join(UI_DIR, rel));
  if (!filePath.startsWith(path.normalize(UI_DIR))) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      // no-cache：允许浏览器缓存但每次校验，避免应用升级后拿到旧版 JS/CSS
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function handleApi(method, segments, req, res) {
  // /api/... → segments 以 api 开头
  if (segments[0] === 'today') {
    if (method === 'GET') {
      const now = new Date();
      const info = buildDayInfo(now.getFullYear(), now.getMonth() + 1, now.getDate());
      info.today = fmtDate(now);
      info.time = now.toTimeString().slice(0, 8);
      return sendJson(res, 200, info);
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  if (segments[0] === 'dates') {
    if (method === 'GET') {
      const params = new URL(req.url, 'http://x').searchParams;
      const s = parseDate(params.get('start'));
      const e = parseDate(params.get('end'));
      if (!s || !e || s > e) return sendJson(res, 400, { error: 'invalid range' });
      const out = [];
      for (let dt = new Date(s); dt <= e; dt.setDate(dt.getDate() + 1)) {
        const info = buildDayInfo(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
        info.today = fmtDate(dt);
        out.push(info);
      }
      return sendJson(res, 200, out);
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  if (segments[0] === 'months') {
    const y = parseInt(segments[1], 10);
    const m = parseInt(segments[2], 10);
    if (!y || !m || y < 1900 || y > 2100 || m < 1 || m > 12) {
      return sendJson(res, 400, { error: 'invalid month' });
    }
    const events = loadEvents();
    return sendJson(res, 200, buildMonthData(y, m, events));
  }

  if (segments[0] === 'events') {
    if (method === 'GET') {
      let events = loadEvents();
      const params = new URL(req.url, 'http://x').searchParams;
      const start = params.get('start');
      const end = params.get('end');
      if (start && end) {
        const s = parseDate(start);
        const e = parseDate(end);
        if (s && e) {
          const eEnd = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1);
          events = events.filter((ev) => {
            const es = ev.allDay ? parseDate(ev.start) : new Date(ev.start);
            const ee = ev.allDay ? parseDate(ev.end) : new Date(ev.end);
            if (!es || !ee) return false;
            const endDt = ev.allDay ? new Date(ee.getFullYear(), ee.getMonth(), ee.getDate() + 1) : ee;
            return es < eEnd && endDt > s;
          });
        }
      }
      return sendJson(res, 200, events.sort((a, b) => String(a.start).localeCompare(String(b.start))));
    }

    if (method === 'POST') {
      return readBody(req).then((body) => {
        const errors = validateEvent(body, false);
        if (errors) return sendJson(res, 400, { error: errors });
        const now = new Date().toISOString();
        const ev = {
          id: crypto.randomUUID(),
          title: body.title,
          start: body.start,
          end: body.end,
          allDay: !!body.allDay,
          color: body.color || 'blue',
          notes: body.notes || '',
          createdAt: now,
          updatedAt: now,
        };
        const events = loadEvents();
        events.push(ev);
        saveEvents(events);
        return sendJson(res, 200, ev);
      }).catch((e) => sendJson(res, 400, { error: e.message }));
    }

    if (segments.length >= 2 && (method === 'PUT' || method === 'DELETE')) {
      const id = segments[1];
      const events = loadEvents();
      const idx = events.findIndex((ev) => ev.id === id);
      if (idx < 0) return sendJson(res, 404, { error: 'event not found' });

      if (method === 'DELETE') {
        events.splice(idx, 1);
        saveEvents(events);
        return sendJson(res, 200, { ok: true });
      }

      return readBody(req).then((body) => {
        const merged = Object.assign({}, events[idx], body);
        const errors = validateEvent(merged, true);
        if (errors) return sendJson(res, 400, { error: errors });
        merged.updatedAt = new Date().toISOString();
        events[idx] = merged;
        saveEvents(events);
        return sendJson(res, 200, merged);
      }).catch((e) => sendJson(res, 400, { error: e.message }));
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  /* -------- 远程日历源管理 -------- */

  if (segments[0] === 'calendars') {
    // GET /api/calendars — 列表（不含密码）
    if (method === 'GET' && segments.length === 1) {
      return sendJson(res, 200, loadCalendars().map(publicCalendar));
    }

    // POST /api/calendars — 添加日历源（ics/caldav 订阅；feishu 需已 OAuth 授权）
    if (method === 'POST' && segments.length === 1) {
      return readBody(req).then(async (body) => {
        const name = String(body.name || '').trim();
        const url = String(body.url || '').trim();
        const type = body.type === 'caldav' ? 'caldav' : (body.type === 'feishu' ? 'feishu' : 'ics');
        if (!name) return sendJson(res, 400, { error: '请输入日历名称' });
        if (type === 'feishu') {
          const fid = String(body.feishuCalendarId || '').trim();
          if (!fid) return sendJson(res, 400, { error: '缺少飞书日历（请先授权并选择要导入的日历）' });
          const fcfg = loadFeishu();
          if (!fcfg.accessToken) return sendJson(res, 400, { error: '尚未授权飞书账号，请先在弹窗中完成授权' });
          const cal = {
            id: crypto.randomUUID(),
            name,
            type: 'feishu',
            feishuCalendarId: fid,
            feishuSummary: String(body.feishuSummary || body.name || '').trim(),
            feishuRole: String(body.feishuRole || '').trim(),
            color: body.color || 'purple',
            lastSync: '',
            lastError: '',
            eventCount: 0,
          };
          await syncCalendar(cal); // 失败不阻塞入库（lastError 红字提示可重试）
          const list = loadCalendars();
          list.push(cal);
          saveCalendars(list);
          return sendJson(res, 200, publicCalendar(cal));
        }
        if (!/^https?:\/\/|^webcal:\/\//i.test(url)) {
          return sendJson(res, 400, { error: '请输入有效的 http(s)/webcal URL' });
        }
        if (type === 'caldav' && body.username && !body.password) {
          // 允许无密码，仅提示性校验
        }
        const cal = {
          id: crypto.randomUUID(),
          name,
          url,
          type,
          username: String(body.username || '').trim(),
          password: String(body.password || ''),
          color: body.color || 'purple',
          lastSync: '',
          lastError: '',
          eventCount: 0,
        };
        // 尝试首次同步；失败不阻塞添加（lastError 红字提示，可稍后点 ⟳ 重试）
        await syncCalendar(cal);
        const list = loadCalendars();
        list.push(cal);
        saveCalendars(list);
        return sendJson(res, 200, publicCalendar(cal));
      }).catch((e) => sendJson(res, 400, { error: e.message }));
    }

    // POST /api/calendars/sync — 同步全部日历源
    if (method === 'POST' && segments[1] === 'sync') {
      const list = loadCalendars();
      return Promise.all(list.map(syncCalendar)).then(() => {
        saveCalendars(list);
        return sendJson(res, 200, list.map(publicCalendar));
      }).catch((e) => sendJson(res, 500, { error: e.message }));
    }

    // GET /api/calendars/events?start=&end= — 合并全部远程日历的缓存事件
    if (method === 'GET' && segments[1] === 'events') {
      const params = new URL(req.url, 'http://x').searchParams;
      const start = params.get('start');
      const end = params.get('end');
      const all = [];
      for (const cal of loadCalendars()) {
        for (const ev of loadCache(cal.id)) {
          all.push(Object.assign({ remote: true, calendarId: cal.id, calendarName: cal.name, calendarColor: cal.color }, ev));
        }
      }
      let result = all;
      if (start && end) {
        const s = parseDate(start);
        const e = parseDate(end);
        if (s && e) {
          const eEnd = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1);
          result = all.filter((ev) => {
            const es = ev.allDay ? parseDate(ev.start) : new Date(ev.start);
            const ee = ev.allDay ? parseDate(ev.end) : new Date(ev.end);
            if (!es || !ee) return false;
            const endDt = ev.allDay ? new Date(ee.getFullYear(), ee.getMonth(), ee.getDate() + 1) : ee;
            return es < eEnd && endDt > s;
          });
        }
      }
      return sendJson(res, 200, result.sort((a, b) => String(a.start).localeCompare(String(b.start))));
    }

    // PUT /api/calendars/:id — 修改日历源信息。
    // ics/caldav：名称/颜色仅展示不重同步；地址/账号/密码变化清缓存并重同步。
    // feishu：仅允许名称/颜色（展示性字段），授权/日历绑定不可通过 PUT 变更。
    if (method === 'PUT' && segments.length === 2) {
      const id = segments[1];
      return readBody(req).then(async (body) => {
        const list = loadCalendars();
        const idx = list.findIndex((c) => c.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'calendar not found' });
        const cal = list[idx];

        // 飞书日历源：只更新展示字段
        if (cal.type === 'feishu') {
          if (body.name !== undefined) {
            const n = String(body.name || '').trim();
            if (!n) return sendJson(res, 400, { error: '请输入日历名称' });
            cal.name = n;
          }
          if (body.color) cal.color = body.color;
          saveCalendars(list);
          return sendJson(res, 200, Object.assign({}, publicCalendar(cal), { resynced: false }));
        }

        const next = {
          name: body.name !== undefined ? String(body.name || '').trim() : cal.name,
          url: body.url !== undefined ? String(body.url || '').trim() : cal.url,
          type: (body.type === 'caldav' || body.type === 'ics') ? body.type : cal.type,
          username: body.username !== undefined ? String(body.username || '').trim() : (cal.username || ''),
          // password：请求体未携带该字段则保留原密码；携带空串则清除
          password: ('password' in body) ? String(body.password || '') : (cal.password || ''),
          color: body.color || cal.color || 'purple',
        };
        if (!next.name) return sendJson(res, 400, { error: '请输入日历名称' });
        if (!/^https?:\/\/|^webcal:\/\//i.test(next.url)) {
          return sendJson(res, 400, { error: '请输入有效的 http(s)/webcal URL' });
        }

        const fetchChanged = next.url !== cal.url || next.type !== cal.type
          || next.username !== (cal.username || '') || next.password !== (cal.password || '');

        Object.assign(cal, next);
        if (fetchChanged) {
          try { fs.unlinkSync(cacheFile(cal.id)); } catch (e) { /* 缓存可能不存在 */ }
          cal.eventCount = 0;
          cal.lastSync = '';
          await syncCalendar(cal); // 失败在 syncCalendar 内部置 lastError，不抛出
        }
        saveCalendars(list);
        return sendJson(res, 200, Object.assign({}, publicCalendar(cal), { resynced: fetchChanged }));
      }).catch((e) => sendJson(res, 400, { error: e.message }));
    }

    // DELETE /api/calendars/:id — 删除日历源及缓存
    if (method === 'DELETE' && segments.length === 2) {
      const id = segments[1];
      const list = loadCalendars();
      const idx = list.findIndex((c) => c.id === id);
      if (idx < 0) return sendJson(res, 404, { error: 'calendar not found' });
      list.splice(idx, 1);
      saveCalendars(list);
      try { fs.unlinkSync(cacheFile(id)); } catch (e) { /* 缓存可能不存在 */ }
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/calendars/:id/sync — 同步单个日历源
    if (method === 'POST' && segments.length === 3 && segments[2] === 'sync') {
      const id = segments[1];
      const list = loadCalendars();
      const cal = list.find((c) => c.id === id);
      if (!cal) return sendJson(res, 404, { error: 'calendar not found' });
      return syncCalendar(cal).then(() => {
        saveCalendars(list);
        return sendJson(res, 200, publicCalendar(cal));
      }).catch((e) => sendJson(res, 500, { error: e.message }));
    }

    // POST /api/calendars/:id/events — 在可写日历源（飞书）上创建日程并即时同步回本地缓存
    if (method === 'POST' && segments.length === 3 && segments[2] === 'events') {
      const id = segments[1];
      return readBody(req).then(async (body) => {
        const list = loadCalendars();
        const cal = list.find((c) => c.id === id);
        if (!cal) return sendJson(res, 404, { error: 'calendar not found' });
        if (!isWritableCalendar(cal)) {
          return sendJson(res, 400, { error: '该日历为只读订阅，不支持在此新建日程' });
        }
        const err = validateEvent(body, false);
        if (err) return sendJson(res, 400, { error: err });
        const feEvent = await feishuCreateEvent(cal, body);
        // 写回成功：转换内部事件并入缓存（避免整窗重拉，读取端会按 start 排序）
        const intl = feishuEventToInternal(feEvent, cal.id, cal.name, cal.color);
        const cached = loadCache(cal.id);
        if (!cached.some((e) => e.id === intl.id)) cached.push(intl);
        saveCache(cal.id, cached);
        cal.eventCount = cached.length;
        cal.lastSync = new Date().toISOString();
        saveCalendars(list);
        return sendJson(res, 200, { event: intl });
      }).catch((e) => sendJson(res, 400, { error: e.message }));
    }

    // PUT /api/calendars/:id/events/:eid — 修改可写日历（飞书）上的日程并同步本地缓存
    if (method === 'PUT' && segments.length === 4 && segments[2] === 'events') {
      const id = segments[1];
      const eid = decodeURIComponent(segments[3]);
      return readBody(req).then(async (body) => {
        const list = loadCalendars();
        const cal = list.find((c) => c.id === id);
        if (!cal) return sendJson(res, 404, { error: 'calendar not found' });
        if (!isWritableCalendar(cal)) {
          return sendJson(res, 400, { error: '该日历为只读订阅，不支持修改日程' });
        }
        const cached = loadCache(cal.id);
        const cachedEv = cached.find((e) => e.id === eid);
        if (!cachedEv) return sendJson(res, 404, { error: '缓存中未找到该日程，请先同步日历' });
        await feishuUpdateEvent(cal, eid, body);
        const seriesId = feishuSeriesId(eid);
        if (seriesId) {
          // 整体系列文本更新：同步该系列全部缓存实例（各自时间保留）
          const title = body.title !== undefined ? String(body.title).trim() : undefined;
          const description = body.notes !== undefined ? String(body.notes || '') : undefined;
          for (const e of cached) {
            if (e.id === seriesId || String(e.id).indexOf(seriesId + '#') === 0) {
              if (title !== undefined) e.title = title;
              if (description !== undefined) e.description = description;
            }
          }
        } else {
          const updated = Object.assign({}, cachedEv);
          if (body.title !== undefined) updated.title = String(body.title).trim();
          if (body.notes !== undefined) updated.description = String(body.notes || '');
          if (body.start !== undefined) updated.start = body.start;
          if (body.end !== undefined) updated.end = body.end;
          if (body.allDay !== undefined) updated.allDay = !!body.allDay;
          const i = cached.findIndex((e) => e.id === eid);
          if (i >= 0) cached[i] = updated;
        }
        saveCache(cal.id, cached);
        cal.eventCount = cached.length;
        cal.lastSync = new Date().toISOString();
        saveCalendars(list);
        const updated = cached.find((e) => e.id === eid) || cachedEv;
        return sendJson(res, 200, { event: updated });
      }).catch((e) => sendJson(res, 400, { error: e.message }));
    }

    // DELETE /api/calendars/:id/events/:eid — 删除可写日历（飞书）上的日程并同步本地缓存
    if (method === 'DELETE' && segments.length === 4 && segments[2] === 'events') {
      const id = segments[1];
      const eid = decodeURIComponent(segments[3]);
      return Promise.resolve().then(async () => {
        const list = loadCalendars();
        const cal = list.find((c) => c.id === id);
        if (!cal) return sendJson(res, 404, { error: 'calendar not found' });
        if (!isWritableCalendar(cal)) {
          return sendJson(res, 400, { error: '该日历为只读订阅，不支持删除日程' });
        }
        const cached = loadCache(cal.id);
        // 命中条件：精确 id，或系列主 id（删除整个系列时需连带全部展开实例）
        const hit = cached.some((e) => e.id === eid || String(e.id).indexOf(eid + '#') === 0);
        if (!hit) {
          return sendJson(res, 404, { error: '缓存中未找到该日程，请先同步日历' });
        }
        await feishuDeleteEvent(cal, eid);
        const rest = cached.filter((e) => e.id !== eid && String(e.id).indexOf(eid + '#') !== 0);
        saveCache(cal.id, rest);
        cal.eventCount = rest.length;
        cal.lastSync = new Date().toISOString();
        saveCalendars(list);
        return sendJson(res, 200, { ok: true });
      }).catch((e) => sendJson(res, 400, { error: e.message }));
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  /* -------- 飞书 OAuth 连接与日历管理 -------- */

  if (segments[0] === 'feishu') {
    // GET /api/feishu/status — 应用配置 / 授权状态 / 日历列表缓存
    if (method === 'GET' && segments[1] === 'status') {
      const cfg = loadFeishu();
      return sendJson(res, 200, {
        configured: !!(cfg.appId && cfg.appSecret),
        authorized: !!cfg.accessToken,
        userName: cfg.userName || '',
        calendars: Array.isArray(cfg.calendars) ? cfg.calendars : [],
        scopeHint: FEISHU_SCOPE_HINT,
      });
    }

    // POST /api/feishu/app — 保存飞书开放平台应用凭证（App ID / App Secret）
    if (method === 'POST' && segments[1] === 'app') {
      return readBody(req).then((body) => {
        const appId = String(body.appId || '').trim();
        const appSecret = String(body.appSecret || '').trim();
        if (!/^cli_[A-Za-z0-9]+$/.test(appId)) return sendJson(res, 400, { error: 'App ID 格式不正确（应以 cli_ 开头）' });
        if (appSecret.length < 8) return sendJson(res, 400, { error: 'App Secret 长度不正确' });
        const cfg = loadFeishu();
        const appChanged = cfg.appId !== appId || cfg.appSecret !== appSecret;
        cfg.appId = appId;
        cfg.appSecret = appSecret;
        // 应用换绑后旧授权失效，清除 token 要求重新授权
        if (appChanged) {
          cfg.accessToken = '';
          cfg.refreshToken = '';
          cfg.tokenExpiresAt = 0;
          cfg.userName = '';
          cfg.calendars = [];
        }
        saveFeishu(cfg);
        return sendJson(res, 200, { ok: true, configured: true, authorized: !!cfg.accessToken });
      }).catch((e) => sendJson(res, 400, { error: e.message }));
    }

    // GET /api/feishu/auth-url — 构造授权链接（需先在飞书开放平台登记回调地址）
    if (method === 'GET' && segments[1] === 'auth-url') {
      const cfg = loadFeishu();
      if (!cfg.appId || !cfg.appSecret) return sendJson(res, 400, { error: '请先填写飞书应用凭证' });
      return sendJson(res, 200, feishuAuthUrl(cfg, req));
    }

    // POST /api/feishu/refresh — 重新拉取授权账号可见的飞书日历列表
    if (method === 'POST' && segments[1] === 'refresh') {
      const cfg = loadFeishu();
      if (!cfg.accessToken) return sendJson(res, 400, { error: '尚未授权飞书账号' });
      return feishuListCalendars().then((cals) => {
        cfg.calendars = cals;
        cfg.lastCalRefresh = new Date().toISOString();
        saveFeishu(cfg);
        return sendJson(res, 200, { calendars: cals });
      }).catch((e) => sendJson(res, 400, { error: e.message }));
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  return sendJson(res, 404, { error: 'not found' });
}

function validateEvent(body, isUpdate) {
  if (!isUpdate || body.title !== undefined) {
    if (!body.title || !String(body.title).trim()) return '日程标题不能为空';
  }
  if (body.start === undefined && body.end === undefined) return null;
  const start = body.allDay ? parseDate(body.start) : body.start ? new Date(body.start) : null;
  const end = body.allDay ? parseDate(body.end) : body.end ? new Date(body.end) : null;
  if (!start || isNaN(start.getTime())) return '开始时间无效';
  if (!end || isNaN(end.getTime())) return '结束时间无效';
  if (start >= end && !body.allDay) return '结束时间必须晚于开始时间';
  if (body.allDay && start > end) return '结束日期不能早于开始日期';
  return null;
}

/** 渲染简单的 HTML 结果页（授权回调用） */
function sendHtml(res, code, title, bodyHtml) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#f5f5f7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#333}
.card{background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.08);padding:36px 44px;max-width:520px;text-align:center}
h2{margin:0 0 12px;font-size:20px} p{font-size:14px;line-height:1.7;color:#666}
.ok{color:#2e9e44} .err{color:#d93025}
</style></head>
<body><div class="card">${bodyHtml}</div></body></html>`;
  const data = Buffer.from(html, 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

/** 飞书 OAuth 授权回调：code 换 user token → 落盘 → 预热用户信息与日历列表 */
async function handleFeishuOAuthCallback(req, res) {
  const params = new URL(req.url, 'http://x').searchParams;
  const code = params.get('code') || '';
  const state = params.get('state') || '';
  const error = params.get('error') || '';
  const cfg = loadFeishu();

  if (error || !code) {
    return sendHtml(res, 200, '授权未完成',
      `<h2 class="err">授权未完成</h2><p>${error ? '飞书返回：' + error : '未收到授权码'}。请返回日历页面重试。</p>
      <p><button onclick="window.close()" style="padding:8px 18px;border:0;border-radius:8px;background:#1e88e5;color:#fff;cursor:pointer">关闭窗口</button></p>`);
  }
  // state 防 CSRF：不匹配时拒绝（仅在本地存在待授权 state 时校验）
  if (cfg.pendingState && state !== cfg.pendingState) {
    return sendHtml(res, 200, '授权失败', '<h2 class="err">授权校验失败</h2><p>state 不匹配，请返回日历页面重新发起授权。</p>');
  }
  cfg.pendingState = '';

  try {
    // 1) app_access_token
    const appTok = await feishuAppToken();
    // 2) 用授权码换 user_access_token
    const data = await feishuReq('/open-apis/authen/v1/oidc/access_token', {
      method: 'POST',
      auth: 'app',
      body: { grant_type: 'authorization_code', code },
    });
    cfg.accessToken = data.access_token;
    cfg.refreshToken = data.refresh_token;
    cfg.tokenExpiresAt = Date.now() + (data.expires_in || 7200) * 1000;
    // 先落盘 token：预热接口（user_info/日历列表）内部通过文件读取 token
    saveFeishu(cfg);
    // 3) 预热：用户信息 + 日历列表（失败不影响授权完成）
    try {
      const info = await feishuUserInfo();
      cfg.userOpenId = info.openId;
      cfg.userName = info.name;
    } catch (e) { /* 忽略 */ }
    try {
      cfg.calendars = await feishuListCalendars();
      cfg.lastCalRefresh = new Date().toISOString();
    } catch (e) { /* 忽略 */ }
    saveFeishu(cfg);

    return sendHtml(res, 200, '授权成功',
      `<h2 class="ok">✅ 飞书授权成功</h2><p>账号：${escapeHtml(cfg.userName || '')}</p>
      <p id="tip">正在跳转回日历页面…</p>
      <script>
        try { if (window.opener) { window.opener.postMessage({source:'fn-calendar', type:'feishu-oauth-success'}, '*'); document.getElementById('tip').textContent='请回到日历页面继续操作，可关闭本窗口。'; } else { document.getElementById('tip').textContent='本窗口由日历页面打开。请手动关闭并刷新日历页面。'; } } catch(e){}
      <\/script>`);
  } catch (e) {
    return sendHtml(res, 200, '授权失败',
      `<h2 class="err">授权失败</h2><p>${escapeHtml(e.message)}</p>
      <p>授权码仅可使用一次，请返回日历页面重新发起授权。</p>`);
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // 去掉网关前缀（统一网关模式下请求路径包含 /app/fn-calendar）
    let basePath = '';
    if (urlPath === GATEWAY_PREFIX) {
      basePath = GATEWAY_PREFIX;
      urlPath = '/';
    } else if (urlPath.startsWith(GATEWAY_PREFIX + '/')) {
      basePath = GATEWAY_PREFIX;
      urlPath = urlPath.slice(GATEWAY_PREFIX.length);
    }
    if (!urlPath.startsWith('/')) urlPath = '/' + urlPath;

    const segments = urlPath.split('/').filter(Boolean);

    if (urlPath === '/' || urlPath === '/index.html') {
      return serveIndex(res, basePath);
    }
    if (urlPath === '/health') {
      return sendText(res, 200, 'OK');
    }
    // 飞书 OAuth 授权回调（用户在飞书授权后跳转回本页）
    if (urlPath === '/feishu/oauth/callback') {
      return handleFeishuOAuthCallback(req, res);
    }
    if (segments[0] === 'api') {
      return handleApi(req.method, segments.slice(1), req, res);
    }
    // 静态资源
    return serveStatic(res, urlPath);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function shutdown() {
  try {
    if (GATEWAY_SOCKET) {
      server.close(() => {
        fs.unlinkSync(GATEWAY_SOCKET);
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 2000);
    } else {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000);
    }
  } catch (e) {
    process.exit(0);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (GATEWAY_SOCKET) {
  // 统一网关模式：监听 Unix Socket
  fs.mkdirSync(path.dirname(GATEWAY_SOCKET), { recursive: true });
  server.listen(GATEWAY_SOCKET, () => {
    try {
      fs.chmodSync(GATEWAY_SOCKET, 0o660);
    } catch (e) { /* 忽略权限设置失败 */ }
    console.log(`[fn-calendar] listening on unix socket ${GATEWAY_SOCKET}, prefix=${GATEWAY_PREFIX}`);
  });
  server.on('error', (e) => {
    console.error('[fn-calendar] socket listen error:', e);
    process.exit(1);
  });
} else {
  // 本地调试模式：监听 TCP 端口
  server.listen(PORT, () => {
    console.log(`[fn-calendar] dev mode: http://localhost:${PORT} (prefix=${GATEWAY_PREFIX})`);
  });
}
