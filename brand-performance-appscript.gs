// Brand Performance Dashboard - Google Apps Script
// Spreadsheet ID: 19EmpiQ6QrR3FYT5FlnmEns-bWilZCk9ffqgRoJVLg7g
//
// HOW TO DEPLOY:
// 1. Paste this entire file into script.google.com
// 2. Deploy > Manage deployments > (edit) > Version: New version > Deploy
//    - Execute as: Me
//    - Who has access: Anyone
//    IMPORTANT: editing this file does NOT update the live Web App. You must
//    push a NEW VERSION every time, or the old code keeps serving.
// 3. Copy the Web App URL > paste into dashboard HTML as API_URL
//
// FIRST-TIME SETUP:
//   1. Run checkSetup()          - confirms SHARED_SECRET is set and every
//                                  spreadsheet can be opened.
//   2. Run installEditTriggers() - makes sheet edits appear on the dashboard
//                                  immediately instead of waiting out the
//                                  cache. Only needs doing once.
//
// IF SHEET EDITS AREN'T SHOWING ON THE DASHBOARD:
//   First check the triggers are installed: run checkEditTriggers().
//   To force it right now:
//   - Click Refresh on the dashboard (it sends nocache=1), or
//   - Run resetCache() from the editor (Run > resetCache), or
//   - Hit the Web App URL with &action=clear_cache
//   Then run diagnose() to see which tabs the script is actually reading.

const SPREADSHEET_ID = '19EmpiQ6QrR3FYT5FlnmEns-bWilZCk9ffqgRoJVLg7g';
const SHEET_NAME     = ''; // leave blank to auto-pick the latest "MMM YYYY" tab

// Commission (affiliate) sources — one spreadsheet per brand.
//
// Every brand now has its own workbook, each laid out the same way: a raw
// network tab (e.g. "IMPACT MYSTIC LABS") plus one month tab per month
// ("JUNE 2026"). The old shared Monthly Affiliate Report
// (1umNx83eliMJqP_b3xdfTPthzrPt7PeO02h63wjXDRj4) is no longer read at all.
const GREENROADS_AFFILIATE_SPREADSHEET_ID = '1dkaw3PtYpsl2Vi5DYI53E62Q6jTbu4Oltk5hIAa62wI';
const HEMPBOMBS_AFFILIATE_SPREADSHEET_ID  = '1uKrvr7KgJNTP_dBQKX66FmoMmsUrd_p9JjqYU5Eey7Q';
const MYSTICLABS_AFFILIATE_SPREADSHEET_ID = '1yv_EpNwjj92_ZdIFpmQVsPpLMD7MgoYOWZe9nR6ulgg';

// Each source is read independently and the rows are concatenated.
//   onlyBrands      - keep only these brands from this source (after normalization)
//   excludeBrands   - drop these brands from this source
//   defaultBrand    - used when the sheet has no Brand column (single-brand sheet)
//   defaultPlatform - used when the tab name doesn't start with AWIN/Impact
//
// TO ADD A BRAND:
//   1. Add a const above with its spreadsheet id.
//   2. Add an entry here with onlyBrands/defaultBrand/defaultPlatform set.
//   3. Run installEditTriggers() again so the new workbook also clears the
//      cache when edited, and testCommissionSources() to check the row counts.
//
// Each brand is pinned to exactly one source via onlyBrands, so a brand can
// never be read from two workbooks and counted twice. A brand with no source
// shows as zero rows in testCommissionSources() rather than quietly merging
// into another.
const COMMISSION_SOURCES = [
  {
    id:              GREENROADS_AFFILIATE_SPREADSHEET_ID,
    onlyBrands:      ['Greenroads'],
    defaultBrand:    'Greenroads',
    defaultPlatform: 'AWIN'
  },
  {
    id:              HEMPBOMBS_AFFILIATE_SPREADSHEET_ID,
    onlyBrands:      ['HempBombs'],
    defaultBrand:    'HempBombs',
    defaultPlatform: 'Impact'
  },
  {
    id:              MYSTICLABS_AFFILIATE_SPREADSHEET_ID,
    onlyBrands:      ['Mystic Labs'],
    defaultBrand:    'Mystic Labs',
    defaultPlatform: 'Impact'
  }
];

// Platforms to exclude entirely from the feed (lowercase). Rows on these
// platforms are dropped before any aggregation, so revenueTrend/mtd/meta/allRows
// all exclude them.
const EXCLUDED_PLATFORMS = ['adroll', 'facebook'];

const GOALS_SHEET_NAME    = 'Goals';
const GOAL_HEADERS        = ['brand','monthly_revenue_target','monthly_spend_cap','target_roas','roas_floor'];
const DEFAULT_GOAL_BRANDS = ['Greenroads','Cannabis Life','HempBombs','Mystic Labs'];

// How many of the most recent "MMM YYYY" tabs to include in the historical
// trend/allRows feed. Without this cap, doGet() re-reads every month tab that
// has ever existed on every request, and it only gets slower as tabs pile up.
// NOTE: edits made to a month tab OLDER than the most recent MAX_HISTORY_MONTHS
// will never appear in revenueTrend / allRows. Raise this if you backfill.
const MAX_HISTORY_MONTHS = 12;

// Seconds to serve a cached copy of the built payload before recomputing.
// Cuts response time from ~seconds (cold read across two spreadsheets) down to
// milliseconds. The source sheets are updated weekly, so a 3-minute window meant
// nearly every visit paid full price; 30 minutes makes cache hits the norm
// without letting data go meaningfully stale.
//
// The cache is bypassed by nocache=1, cleared by action=clear_cache, cleared by
// resetCache() in the editor, and cleared automatically when goals are saved.
// While actively testing sheet edits, drop this to 60.
const CACHE_TTL_SECONDS = 1800;

const MONTHS = {
  jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
  jul:6, aug:7, sep:8, oct:9, nov:10, dec:11,
  january:0, february:1, march:2, april:3, june:5,
  july:6, august:7, september:8, october:9, november:10, december:11
};

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
    // Require a shared secret on every request, set as a Script Property (Project
    // Settings > Script Properties), never in this source file. Requests reach
    // here only through the Vercel proxy (api/data.js), which attaches the secret
    // server-side — the browser never sees this URL or the secret directly.
    var expectedSecret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    var providedSecret  = e && e.parameter && e.parameter.secret;

    // Three distinct causes used to collapse into one "Unauthorized", which made
    // a misconfigured deployment indistinguishable from a wrong secret. None of
    // these messages reveal the secret itself.
    if (!expectedSecret) {
      return json({ error: 'SHARED_SECRET is not set on this script. In the Apps Script editor: ' +
        'Project Settings (gear icon) > Script Properties > Add script property, name SHARED_SECRET, ' +
        'value = the same string as DASHBOARD_API_SECRET in Vercel. Then run checkSetup() to verify.' }, e);
    }
    if (!providedSecret) {
      return json({ error: 'Request arrived without a secret. Check APPS_SCRIPT_URL in Vercel points at ' +
        'this deployment\'s /exec URL.' }, e);
    }
    if (providedSecret !== expectedSecret) {
      return json({ error: 'Secret mismatch: SHARED_SECRET on this script does not equal ' +
        'DASHBOARD_API_SECRET in Vercel. Re-copy one into the other (no quotes, no trailing spaces).' }, e);
    }

    if (e && e.parameter && e.parameter.action === 'save_goals') {
      return json(saveGoals(e), e);
    }

    // Manual cache bust from the dashboard / proxy without rebuilding.
    if (e && e.parameter && e.parameter.action === 'clear_cache') {
      invalidatePayloadCache();
      return json({ ok: true, cleared: true, clearedAt: new Date().toISOString() }, e);
    }

    var noCache = e && e.parameter && e.parameter.nocache === '1';
    if (!noCache) {
      var cached = cacheGetPayload();
      if (cached) return jsonRaw(cached, e);
    }

    var str = buildFullPayloadString();
    cachePutPayload(str);
    return jsonRaw(str, e);

  } catch (err) {
    return json({ error: err.message, stack: err.stack }, e);
  }
}

// Builds the complete payload JSON string from live sheet data.
// Split out of doGet() so diagnose() and manual runs can exercise the exact
// same code path the Web App uses, without going through the cache.
function buildFullPayloadString() {
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

  // All month tabs for historical trend, capped to the most recent
  // MAX_HISTORY_MONTHS so this stays bounded as more tabs get added over time.
  var monthSheets = [];
  ss.getSheets().forEach(function(sh) {
    var m = sh.getName().trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (!m) return;
    var mIdx = MONTHS[m[1].toLowerCase()];
    if (mIdx === undefined) return;
    monthSheets.push({ sh: sh, key: parseInt(m[2], 10) * 12 + mIdx });
  });
  monthSheets.sort(function(a, b) { return a.key - b.key; });
  if (monthSheets.length > MAX_HISTORY_MONTHS) {
    monthSheets = monthSheets.slice(monthSheets.length - MAX_HISTORY_MONTHS);
  }

  var allRows = [];
  monthSheets.forEach(function(o) {
    readRows(o.sh).forEach(function(r) { allRows.push(r); });
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

  // Commission (affiliate) detail, read across every configured source.
  // Never let a problem here break the main feed — and a failure on one
  // source (permissions, renamed tabs) must not wipe out the others.
  try {
    var comm = readCommissionAll();
    payload.commission = comm.rows;
    if (comm.errors.length) payload.commissionError = comm.errors.join(' | ');
  } catch (cErr) {
    payload.commission = [];
    payload.commissionError = cErr.message;
  }

  payload.generatedAt = new Date().toISOString();
  return JSON.stringify(payload);
}

// Sheet picker

function pickLatestMonthSheet(ss) {
  var best = null, bestKey = -1;
  ss.getSheets().forEach(function(sh) {
    var m = sh.getName().trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (!m) return;
    var mIdx = MONTHS[m[1].toLowerCase()];
    if (mIdx === undefined) return;
    var key = parseInt(m[2], 10) * 12 + mIdx;
    if (key > bestKey) { bestKey = key; best = sh; }
  });
  return best;
}

// Row reader

function readRows(sh) {
  var values = sh.getDataRange().getValues();
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

  var numRows = values.length - 1;
  // Only these two columns ever need display-formatted text (dates/percents);
  // reading them as narrow single-column ranges instead of a second full-range
  // getDisplayValues() call roughly halves the sheet I/O for this function.
  var weekDisplay = idx.week >= 0 ? sh.getRange(2, idx.week + 1, numRows, 1).getDisplayValues() : null;
  var wowDisplay  = idx.wow  >= 0 ? sh.getRange(2, idx.wow  + 1, numRows, 1).getDisplayValues() : null;

  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var brand = row[idx.brand] ? String(row[idx.brand]).trim() : '';
    if (!brand) continue;

    var platform = idx.platform >= 0 ? String(row[idx.platform] || '').trim() : '';
    if (EXCLUDED_PLATFORMS.indexOf(platform.toLowerCase()) !== -1) continue; // drop excluded platforms

    var di = i - 1;
    out.push({
      week:        normalizeWeek(idx.week >= 0 ? (weekDisplay[di][0] || row[idx.week]) : ''),
      brand:       normalizeBrand(brand),
      platform:    platform,
      spend:       toNum(idx.spend   >= 0 ? row[idx.spend]   : null),
      revenue:     toNum(idx.revenue >= 0 ? row[idx.revenue] : null),
      clicks:      toNum(idx.clicks  >= 0 ? row[idx.clicks]  : null),
      roas:        toNum(idx.roas    >= 0 ? row[idx.roas]    : null),
      cpc:         toNum(idx.cpc     >= 0 ? row[idx.cpc]     : null),
      wow:         parsePct(idx.wow  >= 0 ? (wowDisplay[di][0] || row[idx.wow]) : null),
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

// Commission (affiliate) reader

// Reads per-publisher rows from every configured commission source and returns
// a flat array the dashboard's Commission tab consumes, plus any per-source
// errors so a single broken spreadsheet doesn't silently zero out the tab.
function readCommissionAll() {
  var rows = [], errors = [];

  COMMISSION_SOURCES.forEach(function(src) {
    if (!src || !src.id) return;
    try {
      readCommissionFromSource(src).forEach(function(r) { rows.push(r); });
    } catch (err) {
      errors.push(src.id + ': ' + err.message);
    }
  });

  return { rows: rows, errors: errors };
}

// Kept as a plain array-returning wrapper for manual runs / older callers.
function readCommission() {
  return readCommissionAll().rows;
}

// Recognises the two tab layouts in use, because the workbooks are not
// consistent:
//   "AWIN GREEN ROADS DATA (JUNE)"  shared Monthly Affiliate Report — the
//                                   leading word names the network
//   "JUNE 2026"                     per-brand client report — the network is
//                                   not in the tab name, so the source's
//                                   defaultPlatform supplies it
// Returns null for anything else (summary tabs, raw exports, "AWIN GREEN
// ROADS", etc.) so those are skipped rather than parsed as publisher data.
function classifyCommissionTab(name) {
  var dm = name.match(/\bDATA\b\s*\(([^)]*)\)/i);
  if (dm) {
    var pm = name.match(/^([A-Za-z.]+)\b/);
    return { tabMonth: dm[1].trim(), platformHint: pm ? pm[1] : '' };
  }
  var mm = name.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (mm && MONTHS[mm[1].toLowerCase()] !== undefined) {
    return { tabMonth: name, platformHint: '' };
  }
  return null;
}

// Reads every recognised month tab in one source spreadsheet.
function readCommissionFromSource(src) {
  var ss  = SpreadsheetApp.openById(src.id);
  var out = [];

  var only = (src.onlyBrands    || []).map(normalizeAffBrand);
  var excl = (src.excludeBrands || []).map(normalizeAffBrand);
  var fallbackBrand = src.defaultBrand ? normalizeAffBrand(src.defaultBrand) : '';

  ss.getSheets().forEach(function(sh) {
    var name = sh.getName().trim();
    var cls  = classifyCommissionTab(name);
    if (!cls) return; // not a publisher-detail tab
    var tabMonth = cls.tabMonth;

    var platform = cls.platformHint ? normalizeAffPlatform(cls.platformHint) : '';
    if (!platform || (platform !== 'AWIN' && platform !== 'Impact')) {
      platform = src.defaultPlatform || platform;
    }

    var values = sh.getDataRange().getValues();
    if (values.length < 2) return;

    var headers = values[0].map(function(h) { return String(h).trim(); });
    var idx = {
      date:     find(headers, /date/i),
      brand:    find(headers, /^brand$/i),
      pubId:    find(headers, /publisher\s*id|media\s*partner\s*id|partner\s*id|^publisher$/i),
      username: find(headers, /user\s*name|publisher\s*name/i),
      trans:    find(headers, /transaction/i),
      sales:    find(headers, /^sales$/i),
      comm:     find(headers, /commission/i)
    };

    var numRows = values.length - 1;
    var dateDisplay = idx.date >= 0 ? sh.getRange(2, idx.date + 1, numRows, 1).getDisplayValues() : null;

    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      var firstCell = String(row[0] || '').trim().toLowerCase();
      if (firstCell === 'total') continue; // skip footer total row

      var brandRaw = idx.brand >= 0 ? String(row[idx.brand] || '').trim() : '';
      var brand    = brandRaw ? normalizeAffBrand(brandRaw) : fallbackBrand;
      if (!brand) continue;

      // On single-brand sheets the brand cell can't be used to detect blank
      // rows, so check that the row actually carries data before keeping it.
      if (!brandRaw && !rowHasCommissionData(row, idx)) continue;

      if (only.length && only.indexOf(brand) === -1) continue;
      if (excl.length && excl.indexOf(brand) !== -1) continue;

      out.push({
        monthKey:     affMonthKey(idx.date >= 0 ? (dateDisplay[i - 1][0] || row[idx.date]) : '', tabMonth),
        platform:     platform,
        brand:        brand,
        publisherId:  idx.pubId    >= 0 ? String(row[idx.pubId] || '').trim() : '',
        username:     idx.username >= 0 ? String(row[idx.username] || '').trim() : '',
        transactions: toNum(idx.trans >= 0 ? row[idx.trans] : null) || 0,
        sales:        toNum(idx.sales >= 0 ? row[idx.sales] : null) || 0,
        commission:   toNum(idx.comm  >= 0 ? row[idx.comm]  : null) || 0
      });
    }
  });

  return out;
}

function rowHasCommissionData(row, idx) {
  if (idx.pubId    >= 0 && String(row[idx.pubId]    || '').trim()) return true;
  if (idx.username >= 0 && String(row[idx.username] || '').trim()) return true;
  if (idx.trans >= 0 && toNum(row[idx.trans])) return true;
  if (idx.sales >= 0 && toNum(row[idx.sales])) return true;
  if (idx.comm  >= 0 && toNum(row[idx.comm]))  return true;
  return false;
}

// Run from the editor to confirm each source is being read as expected.
// Logs tab names, row counts and brand totals per source.
function testCommissionSources() {
  COMMISSION_SOURCES.forEach(function(src) {
    Logger.log('--- source: ' + src.id);
    try {
      var ss = SpreadsheetApp.openById(src.id);
      var all  = ss.getSheets().map(function(sh) { return sh.getName(); });
      var tabs = all.filter(function(n) { return classifyCommissionTab(n.trim()); });
      var skip = all.filter(function(n) { return !classifyCommissionTab(n.trim()); });
      Logger.log('matching tabs: ' + (tabs.length ? tabs.join(', ') : 'NONE — check tab naming'));
      Logger.log('ignored tabs:  ' + (skip.length ? skip.join(', ') : 'none'));

      var rows = readCommissionFromSource(src);
      Logger.log('rows kept: ' + rows.length);

      var byBrand = {};
      rows.forEach(function(r) {
        if (!byBrand[r.brand]) byBrand[r.brand] = { rows: 0, sales: 0, commission: 0 };
        byBrand[r.brand].rows++;
        byBrand[r.brand].sales      += r.sales;
        byBrand[r.brand].commission += r.commission;
      });
      Logger.log(JSON.stringify(byBrand, null, 2));
    } catch (err) {
      Logger.log('ERROR: ' + err.message);
    }
  });
}

function normalizeAffPlatform(p) {
  var k = String(p).trim().toUpperCase();
  if (k === 'AWIN')   return 'AWIN';
  if (k === 'IMPACT') return 'Impact';
  return String(p).trim();
}

function normalizeAffBrand(name) {
  var k = String(name).trim().toLowerCase().replace(/\s+/g, ' ');
  var map = {
    'green roads':   'Greenroads',
    'greenroads':    'Greenroads',
    'hemp bombs':    'HempBombs',
    'hempbombs':     'HempBombs',
    'mystic labs':   'Mystic Labs',
    'cannabis life': 'Cannabis Life'
  };
  if (map[k]) return map[k];
  return k.replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

// Resolve a "Month YYYY" key from the DATE cell, else the tab's month + year.
function affMonthKey(dateVal, tabMonth) {
  if (dateVal instanceof Date) {
    return Utilities.formatDate(dateVal, Session.getScriptTimeZone(), 'MMMM yyyy');
  }
  var s = String(dateVal || '').trim();
  var m = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) return capitalize(m[1]) + ' ' + m[2];
  if (tabMonth) {
    // A tab may be "JUNE" (year implied) or "JUNE 2026" (year included).
    // Appending the year unconditionally would produce "June 2026 2026".
    var tm  = String(tabMonth).trim();
    var tmm = tm.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (tmm) return capitalize(tmm[1]) + ' ' + tmm[2];
    return capitalize(tm) + ' ' + (new Date()).getFullYear();
  }
  return s;
}

function capitalize(w) {
  w = String(w).toLowerCase();
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

function json(obj, e) {
  return jsonRaw(JSON.stringify(obj), e);
}

function jsonRaw(str, e) {
  var cb = e && e.parameter && e.parameter.callback;
  if (cb) {
    return ContentService
      .createTextOutput(cb + '(' + str + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(str)
    .setMimeType(ContentService.MimeType.JSON);
}

// Payload cache
//
// CacheService values are capped at 100KB each, so the built JSON string is
// split across multiple keys. A missing/expired chunk is treated as a full
// cache miss and falls back to a live rebuild.

var CACHE_CHUNK_SIZE = 90000;

function cacheGetPayload() {
  try {
    var cache = CacheService.getScriptCache();
    var meta  = cache.get('payload_meta');
    if (!meta) return null;
    var n = JSON.parse(meta).n;
    var chunks = [];
    for (var i = 0; i < n; i++) {
      var c = cache.get('payload_chunk_' + i);
      if (c === null) return null;
      chunks.push(c);
    }
    return chunks.join('');
  } catch (err) {
    return null;
  }
}

function invalidatePayloadCache() {
  try {
    var cache = CacheService.getScriptCache();
    var meta  = cache.get('payload_meta');
    if (!meta) return;
    var n = JSON.parse(meta).n;
    var keys = ['payload_meta'];
    for (var i = 0; i < n; i++) keys.push('payload_chunk_' + i);
    cache.removeAll(keys);
  } catch (err) {
    // best-effort — a stale cache entry will simply expire on its own via CACHE_TTL_SECONDS
  }
}

function cachePutPayload(str) {
  try {
    var n = Math.ceil(str.length / CACHE_CHUNK_SIZE);
    if (n > 20) return; // too large to cache sensibly — skip, don't fail the request
    var cache = CacheService.getScriptCache();
    for (var i = 0; i < n; i++) {
      cache.put('payload_chunk_' + i, str.substr(i * CACHE_CHUNK_SIZE, CACHE_CHUNK_SIZE), CACHE_TTL_SECONDS);
    }
    cache.put('payload_meta', JSON.stringify({ n: n }), CACHE_TTL_SECONDS);
  } catch (err) {
    // Cache failures shouldn't break the response — the payload was already returned live.
  }
}

// Maintenance / diagnostics
//
// Run these straight from the Apps Script editor (Run > pick function).

// START HERE if the dashboard shows "Unauthorized (sample data)".
// Reports what is configured without ever printing the secret, so the log is
// safe to screenshot.
function checkSetup() {
  var secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  var lines  = [];

  if (!secret) {
    lines.push('SHARED_SECRET: NOT SET  <-- this is why the dashboard shows "Unauthorized (sample data)"');
    lines.push('   Fix: Project Settings (gear icon, left sidebar) > Script Properties >');
    lines.push('        Add script property. Name: SHARED_SECRET');
    lines.push('        Value: the exact same string as DASHBOARD_API_SECRET in Vercel.');
    lines.push('        Then Deploy > Manage deployments > edit > New version > Deploy.');
  } else {
    // A fingerprint, not the value — enough to compare against Vercel safely.
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, secret);
    var fp = digest.slice(0, 4).map(function(b) {
      return ('0' + (b & 0xFF).toString(16)).slice(-2);
    }).join('');
    lines.push('SHARED_SECRET: set (' + secret.length + ' chars, fingerprint ' + fp + ')');
    if (secret !== secret.trim()) {
      lines.push('   WARNING: it has leading or trailing whitespace — that alone causes a mismatch.');
    }
    lines.push('   If the dashboard still says Unauthorized, this value differs from Vercel\'s,');
    lines.push('   or the Web App is still serving an older version (push a New version).');
  }

  lines.push('');
  lines.push('Spreadsheets this script can open:');

  var report = function(label, id) {
    if (!id) { lines.push('  ' + label + ': not configured'); return; }
    try {
      lines.push('  ' + label + ': OK — "' + SpreadsheetApp.openById(id).getName() + '"');
    } catch (err) {
      lines.push('  ' + label + ': CANNOT OPEN — ' + err.message);
      lines.push('     (wrong id, or this account lacks access)');
    }
  };

  report('performance', SPREADSHEET_ID);
  COMMISSION_SOURCES.forEach(function(src, i) {
    report('commission source ' + (i + 1), src.id);
  });

  var out = lines.join('\n');
  Logger.log(out);
  return out;
}

// Clear the cached payload so the very next dashboard load rebuilds from live
// sheet data. Run this after editing the source sheets if you don't want to
// wait out CACHE_TTL_SECONDS.
function resetCache() {
  invalidatePayloadCache();
  Logger.log('Payload cache cleared at ' + new Date().toISOString());
}

// ── Instant updates after a sheet edit ───────────────────────────────────────
//
// RUN installEditTriggers() ONCE from the editor.
//
// After that, editing any source spreadsheet clears the cached payload straight
// away, so the next dashboard load shows the change immediately instead of
// waiting out CACHE_TTL_SECONDS. The cache still does its job for everyone
// else's page loads, so this buys instant edits without giving up fast loads.
//
// Re-running installEditTriggers() is safe — it removes its own old triggers
// first, so you never end up with duplicates.
function installEditTriggers() {
  var removed = removeEditTriggers();

  // Every spreadsheet the payload is built from, de-duplicated.
  var ids = [SPREADSHEET_ID];
  COMMISSION_SOURCES.forEach(function(src) {
    if (src && src.id && ids.indexOf(src.id) === -1) ids.push(src.id);
  });

  var made = [], failed = [];
  ids.forEach(function(id) {
    try {
      ScriptApp.newTrigger('onSourceEdit').forSpreadsheet(id).onEdit().create();
      var name = '';
      try { name = ' ("' + SpreadsheetApp.openById(id).getName() + '")'; } catch (e) {}
      made.push(id + name);
    } catch (err) {
      failed.push(id + ' — ' + err.message);
    }
  });

  var lines = [];
  if (removed) lines.push('Removed ' + removed + ' existing trigger(s) first.');
  lines.push('Installed ' + made.length + ' edit trigger(s):');
  made.forEach(function(m) { lines.push('  OK  ' + m); });
  if (failed.length) {
    lines.push('FAILED — these will still wait for the cache to expire:');
    failed.forEach(function(f) { lines.push('  !!  ' + f); });
  }
  lines.push('');
  lines.push(made.length
    ? 'Edits to the spreadsheets above now clear the cache immediately.'
    : 'No triggers installed — edits will still wait out CACHE_TTL_SECONDS.');

  var out = lines.join('\n');
  Logger.log(out);
  return out;
}

// Deletes only this script's own edit triggers. Returns how many were removed.
function removeEditTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'onSourceEdit') {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  return n;
}

// Fired by the installed triggers on every edit to a source spreadsheet.
// Deliberately does almost nothing: this runs while someone is typing in the
// sheet, so anything expensive here would make editing feel sluggish. Clearing
// the cache is enough — the next dashboard request does the rebuild.
function onSourceEdit(e) {
  invalidatePayloadCache();
}

// Reports whether the instant-update triggers are actually installed.
function checkEditTriggers() {
  var mine = ScriptApp.getProjectTriggers().filter(function(t) {
    return t.getHandlerFunction() === 'onSourceEdit';
  });
  var out = mine.length
    ? mine.length + ' edit trigger(s) installed — sheet edits clear the cache immediately.'
    : 'No edit triggers installed. Run installEditTriggers() once to enable instant updates.';
  Logger.log(out);
  return out;
}

// Clear the cache, rebuild live, and log what the script actually saw.
// This is the fastest way to answer "why isn't my sheet edit showing up?"
function diagnose() {
  invalidatePayloadCache();

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  var allTabs = ss.getSheets().map(function(sh) { return sh.getName(); });
  Logger.log('ALL TABS: ' + allTabs.join(' | '));

  var monthTabs = allTabs.filter(function(n) {
    var m = n.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
    return m && MONTHS[m[1].toLowerCase()] !== undefined;
  });
  Logger.log('TABS MATCHING "MMM YYYY": ' + (monthTabs.length ? monthTabs.join(' | ') : 'NONE'));

  var skipped = allTabs.filter(function(n) { return monthTabs.indexOf(n) === -1; });
  Logger.log('TABS IGNORED BY THE MONTH PICKER: ' + (skipped.length ? skipped.join(' | ') : 'none'));

  var latestSh = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : pickLatestMonthSheet(ss);
  Logger.log('LATEST TAB PICKED: ' + (latestSh ? latestSh.getName() : 'NONE — nothing matched'));

  if (latestSh) {
    var rows = readRows(latestSh);
    Logger.log('ROWS KEPT FROM LATEST TAB: ' + rows.length +
      ' (rows with a blank Brand cell, or on ' + EXCLUDED_PLATFORMS.join('/') + ', are dropped)');
    if (rows.length) {
      Logger.log('FIRST ROW: ' + JSON.stringify(rows[0]));
      Logger.log('LAST ROW:  ' + JSON.stringify(rows[rows.length - 1]));
    }
  }

  var str = buildFullPayloadString();
  var p   = JSON.parse(str);
  Logger.log('--- REBUILT PAYLOAD ---');
  Logger.log('source_tab:   ' + (p.meta && p.meta.source_tab));
  Logger.log('week_range:   ' + (p.meta && p.meta.week_range));
  Logger.log('mtd_revenue:  ' + (p.meta && p.meta.mtd_revenue));
  Logger.log('mtd_spend:    ' + (p.meta && p.meta.mtd_spend));
  Logger.log('allRows:      ' + (p.allRows || []).length);
  Logger.log('commission:   ' + (p.commission || []).length);
  if (p.commissionError) Logger.log('commissionError: ' + p.commissionError);
  Logger.log('generatedAt:  ' + p.generatedAt);
  Logger.log('payload size: ' + str.length + ' chars');
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

    invalidatePayloadCache();
    return { ok: true, saved: rows.length, savedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
