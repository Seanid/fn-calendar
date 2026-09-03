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
  return {
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

    // POST /api/calendars — 添加日历源（先试同步，失败则报错不入库）
    if (method === 'POST' && segments.length === 1) {
      return readBody(req).then(async (body) => {
        const name = String(body.name || '').trim();
        const url = String(body.url || '').trim();
        const type = body.type === 'caldav' ? 'caldav' : 'ics';
        if (!name) return sendJson(res, 400, { error: '请输入日历名称' });
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

    // PUT /api/calendars/:id — 修改日历源信息（名称/地址/账号/密码/颜色）。
    // 名称/颜色仅影响展示，不触发同步；地址/类型/账号/密码变化时清掉旧缓存并重新同步，
    // 失败不抛出（lastError 红字提示，可稍后重试），避免修改后仍展示旧地址的过期数据。
    if (method === 'PUT' && segments.length === 2) {
      const id = segments[1];
      return readBody(req).then(async (body) => {
        const list = loadCalendars();
        const idx = list.findIndex((c) => c.id === id);
        if (idx < 0) return sendJson(res, 404, { error: 'calendar not found' });
        const cal = list[idx];

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
