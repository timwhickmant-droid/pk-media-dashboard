// Brand Performance Dashboard - Google Apps Script
// Spreadsheet ID: 19EmpiQ6QrR3FYT5FlnmEns-bWilZCk9ffqgRoJVLg7g
//
// HOW TO DEPLOY:
// 1. Paste this entire file into script.google.com
// 2. Deploy > New Deployment > Web App
//    - Execute as: Me
//    - Who has access: Anyone
// 3. Copy the Web App URL > paste into dashboard HTML as API_URL

const SPREADSHEET_ID = '19EmpiQ6QrR3FYT5FlnmEns-bWilZCk9ffqgRoJVLg7g';
const SHEET_NAME     = ''; // leave blank to auto-pick the latest "MMM YYYY" tab

// Platforms to exclude entirely from the feed (lowercase). Rows on these
// platforms are dropped before any aggregation, so revenueTrend/mtd/meta/allRows
// all exclude them.
const EXCLUDED_PLATFORMS = ['adroll', 'facebook'];

const GOALS_SHEET_NAME    = 'Goals';
const GOAL_HEADERS        = ['brand','monthly_revenue_target','monthly_spend_cap','target_roas','roas_floor'];
const DEFAULT_GOAL_BRANDS = ['Greenroads','Cannabis Life','HempBombs','Mystic Labs'];

const BRAND_ALIAS = {
  'Hemp Bombs':    'HempBombs',
  'HempBombs':     'HempBombs',
  'Green Roads':   'Greenroads',
  'Greenroads':    'Greenroads',
  'Cannabis Life': 'Cannabis Life',
  'Mystic Labs':   'Mystic Labs'
};

// Entry point

function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.action === 'save_goals') {
      return json(saveGoals(e), e);
    }

    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    // Latest month tab
    var latestSh = SHEET_NAME
      ? ss.getSheetByName(SHEET_NAME)
      : pickLatestMonthSheet(ss);
    if (!latestSh) throw new Error('No matching sheet tab found' +
      (SHEET_NAME ? ': ' + SHEET_NAME : ' (looking for "MMM YYYY" pattern)'));

    var latestRows = readRows(latestSh);
    var payload    = buildPayload(latestRows);
    payload.meta.source_tab = latestSh.getName();

    // All month tabs for historical trend
    var allRows = [];
    ss.getSheets().forEach(function(sh) {
      var m = sh.getName().trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
      if (!m) return;
      readRows(sh).forEach(function(r) { allRows.push(r); });
    });

    // Group by week across all months
    var trendBy = {}, trendOrder = [];
    allRows.forEach(function(r) {
      if (!r.week) return;
      if (!trendBy[r.week]) {
        trendBy[r.week] = { revenue: 0, spend: 0, clicks: 0 };
        trendOrder.push(r.week);
      }
      trendBy[r.week].revenue += r.revenue || 0;
      trendBy[r.week].spend   += r.spend   || 0;
      trendBy[r.week].clicks  += r.clicks  || 0;
    });

    payload.revenueTrend = trendOrder.map(function(w, i) {
      var t = trendBy[w];
      return {
        week_label: 'W' + (i + 1),
        week_full:  w,
        revenue:    Math.round(t.revenue),
        spend:      Math.round(t.spend),
        roas:       t.spend ? Math.round((t.revenue / t.spend) * 100) / 100 : 0,
        clicks:     Math.round(t.clicks)
      };
    });

    payload.dailySpend = trendOrder.map(function(w, i) {
      return { date: 'W' + (i + 1), spend: Math.round(trendBy[w].spend) };
    });

    // Expose all rows with week_label for the campaigns/analytics tabs
    var weekToLabel = {};
    trendOrder.forEach(function(w, i) { weekToLabel[w] = 'W' + (i + 1); });
    payload.allRows = allRows.map(function(r) {
      return Object.assign({}, r, { week_label: weekToLabel[r.week] || r.week });
    });

    payload.goals = getGoals(ss);

    payload.generatedAt = new Date().toISOString();
    return json(payload, e);

  } catch (err) {
    return json({ error: err.message, stack: err.stack }, e);
  }
}

// Sheet picker

function pickLatestMonthSheet(ss) {
  var months = {
    jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
    jul:6, aug:7, sep:8, oct:9, nov:10, dec:11,
    january:0, february:1, march:2, april:3, june:5,
    july:6, august:7, september:8, october:9, november:10, december:11
  };
  var best = null, bestKey = -1;
  ss.getSheets().forEach(function(sh) {
    var m = sh.getName().trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (!m) return;
    var mIdx = months[m[1].toLowerCase()];
    if (mIdx === undefined) return;
    var key = parseInt(m[2], 10) * 12 + mIdx;
    if (key > bestKey) { bestKey = key; best = sh; }
  });
  return best;
}

// Row reader

function readRows(sh) {
  var range   = sh.getDataRange();
  var values  = range.getValues();
  var display = range.getDisplayValues();
  if (values.length < 2) return [];

  var headers = values[0].map(function(h) { return String(h).trim(); });
  var idx = {
    week:     find(headers, /^week$/i),
    brand:    find(headers, /^brand$/i),
    platform: find(headers, /^platform$/i),
    spend:    find(headers, /^spend$/i),
    revenue:  find(headers, /^revenue$/i),
    clicks:   find(headers, /clicks/i),
    wow:      find(headers, /wow/i),
    roas:     find(headers, /^roas$/i),
    cpc:      find(headers, /^cpc$/i),
    note:     find(headers, /^notes?$/i)
  };

  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var brand = row[idx.brand] ? String(row[idx.brand]).trim() : '';
    if (!brand) continue;

    var platform = idx.platform >= 0 ? String(row[idx.platform] || '').trim() : '';
    if (EXCLUDED_PLATFORMS.indexOf(platform.toLowerCase()) !== -1) continue; // drop excluded platforms

    out.push({
      week:        normalizeWeek(idx.week >= 0 ? (display[i][idx.week] || row[idx.week]) : ''),
      brand:       normalizeBrand(brand),
      platform:    platform,
      spend:       toNum(idx.spend   >= 0 ? row[idx.spend]   : null),
      revenue:     toNum(idx.revenue >= 0 ? row[idx.revenue] : null),
      clicks:      toNum(idx.clicks  >= 0 ? row[idx.clicks]  : null),
      roas:        toNum(idx.roas    >= 0 ? row[idx.roas]    : null),
      cpc:         toNum(idx.cpc     >= 0 ? row[idx.cpc]     : null),
      wow:         parsePct(idx.wow  >= 0 ? (display[i][idx.wow] || row[idx.wow]) : null),
      note:        idx.note >= 0 ? String(row[idx.note] || '').trim() : ''
    });
  }
  return out;
}

// Payload builder

function buildPayload(rows) {
  if (rows.length === 0) return empty();

  var weekOrder = [];
  var seen = {};
  rows.forEach(function(r) {
    if (r.week && !seen[r.week]) { seen[r.week] = true; weekOrder.push(r.week); }
  });
  var latestWeek = weekOrder[weekOrder.length - 1];

  var weeklyDetail = rows
    .filter(function(r) { return r.week === latestWeek; })
    .map(function(r) {
      return {
        brand:       r.brand,
        platform:    r.platform,
        spend:       r.spend,
        revenue:     r.revenue,
        clicks:      r.clicks,
        roas:        r.roas,
        wow_rev_pct: r.wow,
        cpc:         r.cpc,
        note:        r.note
      };
    });

  var mtdBy = {};
  rows.forEach(function(r) {
    if (!mtdBy[r.brand]) mtdBy[r.brand] = { brand: r.brand, mtd_spend: 0, mtd_revenue: 0, mtd_clicks: 0 };
    mtdBy[r.brand].mtd_spend   += r.spend   || 0;
    mtdBy[r.brand].mtd_revenue += r.revenue || 0;
    mtdBy[r.brand].mtd_clicks  += r.clicks  || 0;
  });
  var mtd = Object.keys(mtdBy).map(function(k) {
    var b = mtdBy[k];
    return {
      brand:       b.brand,
      mtd_spend:   Math.round(b.mtd_spend   * 100) / 100,
      mtd_revenue: Math.round(b.mtd_revenue * 100) / 100,
      mtd_clicks:  Math.round(b.mtd_clicks)
    };
  });

  var trendBy = {};
  rows.forEach(function(r) {
    if (!trendBy[r.week]) trendBy[r.week] = { revenue: 0, spend: 0, clicks: 0 };
    trendBy[r.week].revenue += r.revenue || 0;
    trendBy[r.week].spend   += r.spend   || 0;
    trendBy[r.week].clicks  += r.clicks  || 0;
  });
  var revenueTrend = weekOrder.map(function(w, i) {
    var t = trendBy[w];
    return {
      week_label: 'W' + (i + 1),
      week_full:  w,
      revenue:    Math.round(t.revenue),
      spend:      Math.round(t.spend),
      roas:       t.spend ? Math.round((t.revenue / t.spend) * 100) / 100 : 0,
      clicks:     Math.round(t.clicks)
    };
  });

  var dailySpend = weekOrder.map(function(w, i) {
    return { date: 'W' + (i + 1), spend: Math.round(trendBy[w].spend) };
  });

  var totals = rows.reduce(function(a, r) {
    return { spend: a.spend + (r.spend || 0), revenue: a.revenue + (r.revenue || 0), clicks: a.clicks + (r.clicks || 0) };
  }, { spend: 0, revenue: 0, clicks: 0 });

  var last  = revenueTrend[revenueTrend.length - 1] || { revenue:0, spend:0, clicks:0, roas:0 };
  var prior = revenueTrend[revenueTrend.length - 2] || { revenue:0, spend:0, clicks:0, roas:0 };
  var wow = function(curr, prev) { return prev ? Math.round(((curr - prev) / prev) * 1000) / 10 : 0; };

  var wkRows = weeklyDetail.filter(function(r) { return (r.spend || 0) > 0; });
  var prof = 0, brk = 0, loss = 0;
  wkRows.forEach(function(r) {
    if (!r.revenue || r.revenue === 0) { loss++; return; }
    var ro = r.revenue / r.spend;
    if (ro >= 1.5)       prof++;
    else if (ro >= 0.95) brk++;
    else                 loss++;
  });

  var winRate   = wkRows.length ? Math.round((prof / wkRows.length) * 100) : 0;
  var margin    = totals.revenue ? Math.round(((totals.revenue - totals.spend) / totals.revenue) * 100) : 0;
  var blendRoas = totals.spend   ? Math.round((totals.revenue / totals.spend) * 100) / 100 : 0;

  var meta = {
    period_label:         'Week of ' + shortWeek(latestWeek),
    week_range:           latestWeek,
    margin_pct:           margin,
    win_rate_pct:         winRate,
    platforms_profitable: prof,
    platforms_breakeven:  brk,
    platforms_loss:       loss,
    mtd_revenue:          Math.round(totals.revenue * 100) / 100,
    mtd_revenue_wow_pct:  wow(last.revenue, prior.revenue),
    mtd_spend:            Math.round(totals.spend * 100) / 100,
    mtd_spend_wow_pct:    wow(last.spend, prior.spend),
    blended_roas:         blendRoas,
    roas_wow_pct:         wow(last.roas, prior.roas),
    total_clicks:         Math.round(last.clicks),
    clicks_wow_pct:       wow(last.clicks, prior.clicks)
  };

  return { weeklyDetail: weeklyDetail, mtd: mtd, dailySpend: dailySpend, revenueTrend: revenueTrend, meta: meta };
}

// Helpers

function find(headers, pattern) {
  for (var i = 0; i < headers.length; i++) if (pattern.test(headers[i])) return i;
  return -1;
}

function normalizeBrand(name) {
  var k = String(name).trim();
  return BRAND_ALIAS[k] || k;
}

function normalizeWeek(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'MMM d yyyy');
  }
  return String(v).trim().replace(/,/g, '').replace(/\s+/g, ' ');
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  var cleaned = String(v).replace(/[$,%x\s]/g, '');
  var n = Number(cleaned);
  return isNaN(n) ? null : n;
}

function parsePct(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return s * (Math.abs(s) < 1 ? 100 : 1);
  var str = String(s).trim();
  if (str === '' || str === '-' || str === '—' || str === '–') return null;
  var cleaned = str.replace(/[%\s,]/g, '').replace(/[−–—]/g, '-');
  var n = Number(cleaned);
  return isNaN(n) ? null : n;
}

function shortWeek(w) {
  var m = String(w).match(/^([A-Za-z]+\s*\d+)/);
  return m ? m[1] : String(w);
}

function empty() {
  return { weeklyDetail: [], mtd: [], dailySpend: [], revenueTrend: [], allRows: [], meta: {}, generatedAt: new Date().toISOString() };
}

function json(obj, e) {
  var str = JSON.stringify(obj);
  var cb  = e && e.parameter && e.parameter.callback;
  if (cb) {
    return ContentService
      .createTextOutput(cb + '(' + str + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(str)
    .setMimeType(ContentService.MimeType.JSON);
}

// Goals

function getGoals(ss) {
  var sh = ss.getSheetByName(GOALS_SHEET_NAME);
  if (!sh) sh = createGoalsSheet(ss);

  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  var headers = values[0].map(function(h){ return String(h).trim().toLowerCase(); });
  var idx = {};
  GOAL_HEADERS.forEach(function(h){ idx[h] = headers.indexOf(h); });
  if (idx.brand < 0) return [];

  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var brand = row[idx.brand] ? String(row[idx.brand]).trim() : '';
    if (!brand) continue;
    out.push({
      brand:                  normalizeBrand(brand),
      monthly_revenue_target: idx.monthly_revenue_target >= 0 ? (toNum(row[idx.monthly_revenue_target]) || 0) : 0,
      monthly_spend_cap:      idx.monthly_spend_cap      >= 0 ? (toNum(row[idx.monthly_spend_cap])      || 0) : 0,
      target_roas:            idx.target_roas            >= 0 ? (toNum(row[idx.target_roas])            || 0) : 0,
      roas_floor:             idx.roas_floor             >= 0 ? (toNum(row[idx.roas_floor])             || 0) : 0
    });
  }
  return out;
}

function createGoalsSheet(ss) {
  var sh = ss.insertSheet(GOALS_SHEET_NAME);
  sh.getRange(1, 1, 1, GOAL_HEADERS.length).setValues([GOAL_HEADERS]).setFontWeight('bold');
  var seed = DEFAULT_GOAL_BRANDS.map(function(b){ return [b, 0, 0, 0, 0]; });
  sh.getRange(2, 1, seed.length, GOAL_HEADERS.length).setValues(seed);
  return sh;
}

function saveGoals(e) {
  try {
    var raw = e && e.parameter && e.parameter.payload;
    if (!raw) throw new Error('missing payload');
    var data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('payload must be an array');

    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sh = ss.getSheetByName(GOALS_SHEET_NAME) || createGoalsSheet(ss);

    var rows = data.map(function(g){
      return [
        String(g.brand || '').trim(),
        Number(g.monthly_revenue_target) || 0,
        Number(g.monthly_spend_cap)      || 0,
        Number(g.target_roas)            || 0,
        Number(g.roas_floor)             || 0
      ];
    }).filter(function(r){ return r[0]; });

    sh.clear();
    sh.getRange(1, 1, 1, GOAL_HEADERS.length).setValues([GOAL_HEADERS]).setFontWeight('bold');
    if (rows.length) sh.getRange(2, 1, rows.length, GOAL_HEADERS.length).setValues(rows);

    return { ok: true, saved: rows.length, savedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
