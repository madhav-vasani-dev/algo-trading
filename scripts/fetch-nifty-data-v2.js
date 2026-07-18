/**
 * fetch-nifty-data-v2.js
 * 
 * OPTIMIZED Nifty 1-min data fetcher with WIDE strike range (ATM +/- 800).
 * 
 * Key features:
 * 1. Fetches entire expiry period at once (not day-by-day) -> ~5x fewer API calls
 * 2. Concurrent requests (3 parallel) -> ~3x faster
 * 3. Uses built-in https module (no axios dependency issues)
 * 4. CHECKPOINT/RESUME: Saves progress after each expiry, auto-resumes on restart
 * 5. Rate limit handling: Detects 429 and waits with exponential backoff
 * 6. Token validation upfront
 * 
 * Usage:
 *   node scripts/fetch-nifty-data-v2.js <access_token> [start_date] [end_date]
 * 
 * Resume after interruption (same command, progress is auto-detected):
 *   node scripts/fetch-nifty-data-v2.js <access_token>
 * 
 * Force fresh start (delete checkpoint):
 *   node scripts/fetch-nifty-data-v2.js <access_token> --fresh
 */

var fs = require('fs');
var path = require('path');
var https = require('https');

var ACCESS_TOKEN = process.argv[2] || process.env.UPSTOX_ACCESS_TOKEN;

// Determine if user passed a custom start and end date
var customStart = process.argv[3] && !process.argv[3].startsWith('-');
var customEnd = process.argv[4] && !process.argv[4].startsWith('-');

var START_DATE_STR = '2024-09-27';
var END_DATE_STR = new Date().toISOString().split('T')[0];
var isCustomRange = false;

if (customStart && customEnd) {
  START_DATE_STR = process.argv[3];
  END_DATE_STR = process.argv[4];
  isCustomRange = true;
}

// Check for manual chunk choice
var chunkArgIdx = process.argv.indexOf('--chunk');
var manualChunkIdx = -1;
if (chunkArgIdx >= 0 && chunkArgIdx + 1 < process.argv.length) {
  manualChunkIdx = parseInt(process.argv[chunkArgIdx + 1], 10) - 1;
}

var FRESH_START = process.argv.indexOf('--fresh') >= 0;

var OUT_DIR = path.join(__dirname, '..', 'public', 'data', 'nifty_1min');
var CHECKPOINT_DIR = path.join(__dirname, '..', 'public', 'data', '_checkpoint');
var CHECKPOINT_FILE = path.join(CHECKPOINT_DIR, 'fetch_progress_v3.json');
var SPOT_CACHE_FILE = path.join(CHECKPOINT_DIR, 'spot_candles_v3.json');

var CHUNKS = [
  { start: '2024-09-27', end: '2024-12-31', name: 'Sep-Dec 2024' },
  { start: '2025-01-01', end: '2025-03-31', name: 'Jan-Mar 2025' },
  { start: '2025-04-01', end: '2025-06-30', name: 'Apr-Jun 2025' },
  { start: '2025-07-01', end: '2025-09-30', name: 'Jul-Sep 2025' },
  { start: '2025-10-01', end: '2025-12-31', name: 'Oct-Dec 2025' },
  { start: '2026-01-01', end: '2026-03-31', name: 'Jan-Mar 2026' },
  { start: '2026-04-01', end: '2026-06-30', name: 'Apr-Jun 2026' },
  { start: '2026-07-01', end: new Date().toISOString().split('T')[0], name: 'Jul 2026' }
];

var STRIKE_STEP = 50;
var STRIKE_RANGE = 800;    // ATM +/- 800 points
var CONCURRENCY = 1;       // Parallel API requests
var throttleMs = 1000;     // ms between batches (dynamically adjusted)
var INDEX_KEY = 'NSE_INDEX|Nifty 50';
var INDEX_KEY_ENC = encodeURIComponent(INDEX_KEY);

if (!ACCESS_TOKEN) {
  console.error('ERROR: Upstox Access Token is required.');
  console.log('Usage: node scripts/fetch-nifty-data-v2.js <access_token> [start_date] [end_date]');
  console.log('Resume: node scripts/fetch-nifty-data-v2.js <new_token>  (auto-resumes)');
  console.log('Fresh:  node scripts/fetch-nifty-data-v2.js <token> --fresh');
  process.exit(1);
}

// --- Helpers ---

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function httpsGet(urlStr) {
  return new Promise(function (resolve, reject) {
    var parsed = require('url').parse(urlStr);
    var opts = {
      hostname: parsed.hostname,
      path: parsed.path,
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + ACCESS_TOKEN
      }
    };
    var req = https.get(opts, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', function (err) { reject(err); });
    req.setTimeout(15000, function () {
      req.destroy();
      reject(new Error('Request Timeout (15s)'));
    });
  });
}

var apiCallCount = 0;
var authFailed = false;

function apiRequest(url, retries) {
  if (retries === undefined) retries = 5;
  if (authFailed) return Promise.resolve(null);
  return sleep(throttleMs).then(function () {
    apiCallCount++;
    return httpsGet(url);
  }).then(function (res) {
    // Auth failure -> abort
    if (res.status === 401) {
      var errMsg = (res.body && res.body.errors && res.body.errors[0]) ? res.body.errors[0].message : 'Unauthorized';
      console.error('\n\u274c AUTHENTICATION FAILED: ' + errMsg);
      console.error('   Your token is invalid or expired. Get a new one and re-run.');
      console.error('   Progress is SAVED - it will resume from where it stopped.\n');
      authFailed = true;
      process.exit(1);
      return null;
    }
    // Rate limited -> wait and retry with long backoff
    if (res.status === 429 || res.status === 503) {
      throttleMs = Math.min(throttleMs + 1000, 5000); // Back off global throttle
      if (retries > 0) {
        var delay = Math.min(Math.pow(2, 6 - retries) * 2000, 30000) + Math.floor(Math.random() * 1000);
        console.warn('  [Rate limited ' + res.status + '] New throttle: ' + throttleMs + 'ms. Waiting ' + (delay / 1000).toFixed(1) + 's before retry...');
        return sleep(delay).then(function () {
          return apiRequest(url, retries - 1);
        });
      } else {
        console.error('\n\u26a0\ufe0f  Rate limit exhausted after retries. Exiting.');
        console.error('   Wait 30 minutes, then re-run with the SAME command to resume.\n');
        process.exit(1);
      }
    }
    if (res.status === 200 && res.body && res.body.status === 'success') {
      throttleMs = Math.max(throttleMs - 5, 1000); // Very slowly speed up on success (min 1000ms)
      return res.body;
    }
    if (res.status !== 200) {
      var apiErr = (res.body && res.body.errors && res.body.errors[0]) ? res.body.errors[0].message : ('HTTP ' + res.status);
      console.warn('  [API Error] ' + apiErr);
    }
    return null;
  }).catch(function (err) {
    if (retries > 0) {
      return sleep(1000).then(function () {
        return apiRequest(url, retries - 1);
      });
    }
    console.warn('  [Network Error] ' + err.message + '. Exiting.');
    process.exit(1);
  });
}

function runConcurrent(tasks, concurrency) {
  var results = [];
  var idx = 0;

  function next() {
    if (idx >= tasks.length) return Promise.resolve();
    var batch = tasks.slice(idx, idx + concurrency);
    idx += concurrency;
    return Promise.all(batch.map(function (t) { return t(); }))
      .then(function (batchRes) {
        results = results.concat(batchRes);
        return next();
      });
  }

  return next().then(function () { return results; });
}

// --- Checkpoint Functions ---

function ensureCheckpointDir() {
  if (!fs.existsSync(CHECKPOINT_DIR)) {
    fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  }
}

function loadCheckpoint() {
  var defaultCheckpoint = {
    completedChunks: {},
    currentChunkName: '',
    completedExpiries: {},
    optionData: {}
  };
  if (FRESH_START) {
    console.log('Fresh start requested. Ignoring any existing checkpoint.\n');
    return defaultCheckpoint;
  }
  if (fs.existsSync(CHECKPOINT_FILE)) {
    try {
      var data = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
      if (!data.completedChunks) data.completedChunks = {};
      if (!data.completedExpiries) data.completedExpiries = {};
      if (!data.optionData) data.optionData = {};
      if (!data.currentChunkName) data.currentChunkName = '';
      return data;
    } catch (e) {
      console.warn('Checkpoint file corrupt. Starting fresh.\n');
    }
  }
  return defaultCheckpoint;
}

function saveCheckpoint(checkpoint) {
  ensureCheckpointDir();
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint));
}

function saveSpotCache(spotCandles) {
  ensureCheckpointDir();
  fs.writeFileSync(SPOT_CACHE_FILE, JSON.stringify(spotCandles));
}

function loadSpotCache() {
  if (!FRESH_START && fs.existsSync(SPOT_CACHE_FILE)) {
    try {
      var data = JSON.parse(fs.readFileSync(SPOT_CACHE_FILE, 'utf8'));
      if (data.length > 0) {
        console.log('\u267b\ufe0f  Loaded ' + data.length + ' cached spot candles (skipping spot download).');
        return data;
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

function cleanupCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE);
    if (fs.existsSync(SPOT_CACHE_FILE)) fs.unlinkSync(SPOT_CACHE_FILE);
    if (fs.existsSync(CHECKPOINT_DIR)) fs.rmdirSync(CHECKPOINT_DIR);
  } catch (e) { /* ignore */ }
}

// --- Data Fetching ---

function fetchNiftySpot(fromDate, toDate) {
  var allCandles = [];
  var currentEnd = new Date(toDate);
  var startLimit = new Date(fromDate);

  console.log('[Spot] Fetching Nifty 50 Spot candles from ' + fromDate + ' to ' + toDate + '...');

  function fetchChunk() {
    if (currentEnd < startLimit) {
      allCandles.reverse();
      return Promise.resolve(allCandles);
    }

    var currentStart = new Date(currentEnd);
    currentStart.setDate(currentStart.getDate() - 28);
    if (currentStart < startLimit) currentStart = new Date(startLimit);

    var fromStr = formatDate(currentStart);
    var toStr = formatDate(currentEnd);

    var url = 'https://api.upstox.com/v3/historical-candle/' + INDEX_KEY_ENC + '/minutes/1/' + toStr + '/' + fromStr;
    console.log('  Fetching Spot: ' + fromStr + ' to ' + toStr + '...');

    return apiRequest(url).then(function (res) {
      if (res && res.data && res.data.candles) {
        res.data.candles.forEach(function (row) {
          allCandles.push({
            timestamp: row[0],
            open: parseFloat(row[1]),
            high: parseFloat(row[2]),
            low: parseFloat(row[3]),
            close: parseFloat(row[4]),
            volume: parseInt(row[5], 10)
          });
        });
      }
      currentEnd = new Date(currentStart);
      currentEnd.setDate(currentEnd.getDate() - 1);
      return fetchChunk();
    }).catch(function (err) {
      console.error('  Error fetching Spot: ' + err.message);
      allCandles.reverse();
      return allCandles;
    });
  }

  return fetchChunk();
}

function fetchExpiredExpiries() {
  var url = 'https://api.upstox.com/v2/expired-instruments/expiries?instrument_key=' + INDEX_KEY_ENC;
  return apiRequest(url).then(function (res) {
    if (res && Array.isArray(res.data)) return res.data.sort();
    return [];
  });
}

function findClosestExpiry(dateStr, expiries) {
  for (var i = 0; i < expiries.length; i++) {
    if (expiries[i] >= dateStr) return expiries[i];
  }
  var d = new Date(dateStr);
  var day = d.getDay();
  var diff = (day <= 4) ? (4 - day) : (11 - day);
  d.setDate(d.getDate() + diff);
  return formatDate(d);
}

var contractsCache = {};

function fetchContractsForExpiry(expiry) {
  if (contractsCache[expiry]) return Promise.resolve(contractsCache[expiry]);
  var url = 'https://api.upstox.com/v2/expired-instruments/option/contract?instrument_key=' + INDEX_KEY_ENC + '&expiry_date=' + expiry;
  return apiRequest(url).then(function (res) {
    if (res && Array.isArray(res.data)) {
      contractsCache[expiry] = res.data;
      return res.data;
    }
    contractsCache[expiry] = [];
    return [];
  });
}

function findContractKey(contracts, strike, optionType) {
  for (var i = 0; i < contracts.length; i++) {
    if (parseFloat(contracts[i].strike_price) === strike && contracts[i].instrument_type === optionType) {
      return contracts[i].instrument_key;
    }
  }
  return null;
}

function fetchOptionCandles(instrumentKey, fromDate, toDate) {
  var url = 'https://api.upstox.com/v2/expired-instruments/historical-candle/'
    + encodeURIComponent(instrumentKey) + '/1minute/' + toDate + '/' + fromDate;

  return apiRequest(url).then(function (res) {
    var map = {};
    if (res && res.data && res.data.candles) {
      res.data.candles.forEach(function (row) {
        map[row[0]] = {
          open: parseFloat(row[1]),
          high: parseFloat(row[2]),
          low: parseFloat(row[3]),
          close: parseFloat(row[4]),
          volume: parseInt(row[5], 10)
        };
      });
    }
    return map;
  });
}

// --- Token Validation ---

function validateToken() {
  console.log('Validating Upstox access token...');
  var url = 'https://api.upstox.com/v2/user/profile';
  return httpsGet(url).then(function (res) {
    if (res.status === 200 && res.body && res.body.status === 'success') {
      var name = (res.body.data && res.body.data.user_name) ? res.body.data.user_name : 'Unknown';
      console.log('\u2705 Token valid! User: ' + name + '\n');
      return true;
    }
    var errMsg = (res.body && res.body.errors && res.body.errors[0]) ? res.body.errors[0].message : ('HTTP ' + res.status);
    console.error('\n\u274c TOKEN INVALID: ' + errMsg);
    console.error('   Please generate a fresh access token from Upstox and try again.');
    console.error('   Tokens expire daily at midnight IST.\n');
    process.exit(1);
    return false;
  });
}

// --- Main Execution ---

function run() {
  var startTime = Date.now();
  console.log('===================================================');
  console.log('  Nifty Data Fetcher v2 (Optimized, ATM +/- ' + STRIKE_RANGE + ')');
  console.log('  With Checkpoint/Resume Support (Chunked Version)');
  console.log('===================================================');

  // Load checkpoint
  var checkpoint = loadCheckpoint();
  
  var activeChunk = null;
  if (isCustomRange) {
    console.log('Running manual custom range: ' + START_DATE_STR + ' to ' + END_DATE_STR);
  } else {
    // Determine active chunk
    if (manualChunkIdx >= 0) {
      if (manualChunkIdx >= CHUNKS.length) {
        console.error('ERROR: Invalid chunk index ' + (manualChunkIdx + 1) + '. Available chunks: 1 to ' + CHUNKS.length);
        process.exit(1);
      }
      activeChunk = CHUNKS[manualChunkIdx];
      console.log('Manual chunk selection: Chunk ' + (manualChunkIdx + 1) + ' (' + activeChunk.name + ')');
    } else {
      // Find first non-completed chunk
      for (var i = 0; i < CHUNKS.length; i++) {
        if (!checkpoint.completedChunks[CHUNKS[i].name]) {
          activeChunk = CHUNKS[i];
          console.log('Auto-detected next pending chunk: Chunk ' + (i + 1) + ' (' + activeChunk.name + ')');
          break;
        }
      }
      if (!activeChunk) {
        console.log('\n\u2705 ALL CHUNKS HAVE BEEN COMPLETED! No further data to fetch.');
        process.exit(0);
      }
    }

    // Set dates to active chunk
    START_DATE_STR = activeChunk.start;
    END_DATE_STR = activeChunk.end;

    // Check if transitioning to a new chunk
    if (checkpoint.currentChunkName !== activeChunk.name) {
      console.log('Transitioning to chunk: ' + activeChunk.name + '. Clearing current chunk progress.');
      checkpoint.currentChunkName = activeChunk.name;
      checkpoint.completedExpiries = {};
      checkpoint.optionData = {};
      // Delete spot cache if exists
      try { if (fs.existsSync(SPOT_CACHE_FILE)) fs.unlinkSync(SPOT_CACHE_FILE); } catch (e) {}
      saveCheckpoint(checkpoint);
    } else {
      var count = Object.keys(checkpoint.completedExpiries || {}).length;
      console.log('Resuming active chunk: ' + activeChunk.name + ' (' + count + ' expiries already completed).');
    }
  }

  console.log('Date range: ' + START_DATE_STR + ' to ' + END_DATE_STR);
  console.log('Strike range: ATM +/- ' + STRIKE_RANGE + ' (step ' + STRIKE_STEP + ')');
  console.log('Concurrency: ' + CONCURRENCY + ' parallel requests');
  console.log('');

  var optionData = checkpoint.optionData || {};
  var completedExpiries = checkpoint.completedExpiries || {};

  var spotCandles, expiriesList, tradingDays, daysMap;

  // Step 0: Validate token
  return validateToken().then(function () {
    // Step 1: Fetch or load cached spot candles
    var cached = loadSpotCache();
    if (cached) return cached;
    return fetchNiftySpot(START_DATE_STR, END_DATE_STR);
  }).then(function (candles) {
    spotCandles = candles;
    if (spotCandles.length === 0) {
      console.error('ERROR: No Spot data fetched.');
      process.exit(1);
    }
    console.log('Total spot candles: ' + spotCandles.length);

    // Cache spot data for resume
    if (!fs.existsSync(SPOT_CACHE_FILE)) {
      console.log('Caching spot data for future resumes...');
      saveSpotCache(spotCandles);
    }

    // Group by trading day
    daysMap = {};
    spotCandles.forEach(function (c) {
      var dateStr = c.timestamp.split('T')[0];
      if (!daysMap[dateStr]) daysMap[dateStr] = [];
      daysMap[dateStr].push(c);
    });
    tradingDays = Object.keys(daysMap).sort();
    console.log('Found ' + tradingDays.length + ' trading days.\n');

    // Step 2: Fetch expiry list
    console.log('Fetching expired expiries list...');
    return fetchExpiredExpiries();

  }).then(function (expiries) {
    expiriesList = expiries;
    console.log('Found ' + expiriesList.length + ' expired expiries.\n');

    // Step 3: Build expiry plan
    console.log('Computing strike requirements per expiry...');
    var expiryPlan = {};

    tradingDays.forEach(function (dateStr) {
      var dayCandles = daysMap[dateStr];
      dayCandles.sort(function (a, b) { return a.timestamp.localeCompare(b.timestamp); });

      var openPrice = dayCandles[0].open;
      var atmStrike = Math.round(openPrice / STRIKE_STEP) * STRIKE_STEP;
      var expiry = findClosestExpiry(dateStr, expiriesList);

      if (!expiryPlan[expiry]) {
        expiryPlan[expiry] = { dates: [], strikes: {}, minDate: dateStr, maxDate: dateStr, dateAtm: {} };
      }

      expiryPlan[expiry].dates.push(dateStr);
      expiryPlan[expiry].dateAtm[dateStr] = atmStrike;

      if (dateStr < expiryPlan[expiry].minDate) expiryPlan[expiry].minDate = dateStr;
      if (dateStr > expiryPlan[expiry].maxDate) expiryPlan[expiry].maxDate = dateStr;

      for (var off = -STRIKE_RANGE; off <= STRIKE_RANGE; off += STRIKE_STEP) {
        expiryPlan[expiry].strikes[atmStrike + off] = true;
      }
    });

    var expiries_list = Object.keys(expiryPlan).sort();
    var alreadyDone = 0;
    expiries_list.forEach(function (exp) {
      if (completedExpiries[exp]) alreadyDone++;
    });

    var totalStrikes = 0;
    var remainingStrikes = 0;
    expiries_list.forEach(function (exp) {
      var count = Object.keys(expiryPlan[exp].strikes).length;
      totalStrikes += count;
      if (!completedExpiries[exp]) remainingStrikes += count;
    });

    console.log('Expiries total: ' + expiries_list.length + ' | Already done: ' + alreadyDone + ' | Remaining: ' + (expiries_list.length - alreadyDone));
    console.log('Estimated remaining API calls: ~' + (remainingStrikes * 2 + (expiries_list.length - alreadyDone)));
    console.log('');

    // Step 4: Fetch option data expiry by expiry (with checkpointing)
    var expiryIdx = 0;
    var optionFetchStart = Date.now();
    var skippedCount = 0;

    function processNextExpiry() {
      if (expiryIdx >= expiries_list.length) return Promise.resolve();

      var expiry = expiries_list[expiryIdx];
      var plan = expiryPlan[expiry];
      var strikes = Object.keys(plan.strikes).map(Number).sort(function (a, b) { return a - b; });

      expiryIdx++;
      var elapsed = ((Date.now() - optionFetchStart) / 1000).toFixed(0);
      var pct = ((expiryIdx / expiries_list.length) * 100).toFixed(1);

      // Skip already completed expiries
      if (completedExpiries[expiry]) {
        skippedCount++;
        if (skippedCount <= 3 || skippedCount === alreadyDone) {
          console.log('[Expiry ' + expiryIdx + '/' + expiries_list.length + '] ' + expiry + ' - SKIPPED (already fetched)');
        } else if (skippedCount === 4) {
          console.log('  ... skipping ' + (alreadyDone - 3) + ' more already-fetched expiries ...');
        }
        return processNextExpiry();
      }

      console.log('[Expiry ' + expiryIdx + '/' + expiries_list.length + ' | ' + pct + '% | ' + elapsed + 's] '
        + expiry + ' | Days: ' + plan.dates.length + ' | Strikes: ' + strikes.length);

      return fetchContractsForExpiry(expiry).then(function (contracts) {
        if (contracts.length === 0) {
          console.log('  No contracts found. Using intrinsic value fallback.');
          // Still mark as completed
          completedExpiries[expiry] = { status: 'no_contracts', timestamp: new Date().toISOString() };
          saveCheckpoint({ completedExpiries: completedExpiries, optionData: optionData });
          return;
        }

        // Build fetch tasks
        var tasks = [];
        strikes.forEach(function (strike) {
          var ceKey = findContractKey(contracts, strike, 'CE');
          var peKey = findContractKey(contracts, strike, 'PE');

          if (ceKey) {
            tasks.push(function () {
              return fetchOptionCandles(ceKey, plan.minDate, expiry).then(function (map) {
                return { strike: strike, type: 'CE', data: map };
              });
            });
          }
          if (peKey) {
            tasks.push(function () {
              return fetchOptionCandles(peKey, plan.minDate, expiry).then(function (map) {
                return { strike: strike, type: 'PE', data: map };
              });
            });
          }
        });

        console.log('  Fetching ' + tasks.length + ' option contracts...');

        return runConcurrent(tasks, CONCURRENCY).then(function (results) {
          var fetchedCount = 0;
          results.forEach(function (r) {
            if (!r || !r.data) return;
            var timestamps = Object.keys(r.data);
            fetchedCount += timestamps.length;
            timestamps.forEach(function (ts) {
              if (!optionData[ts]) optionData[ts] = {};
              if (!optionData[ts][r.strike]) optionData[ts][r.strike] = {};
              optionData[ts][r.strike][r.type] = r.data[ts];
            });
          });
          console.log('  \u2705 Fetched ' + fetchedCount + ' candle data points.');

          // Save checkpoint after each expiry
          completedExpiries[expiry] = { status: 'done', candles: fetchedCount, timestamp: new Date().toISOString() };
          saveCheckpoint({ completedExpiries: completedExpiries, optionData: optionData });
        });
      }).then(function () {
        return processNextExpiry();
      });
    }

    return processNextExpiry().then(function () {
      console.log('\n\u2705 Option data fetching complete! API calls this session: ' + apiCallCount);
      console.log('');

      // Step 5: Merge and save
      console.log('Merging data and saving monthly files...');

      var mergedData = [];
      var totalWithRealOpts = 0;
      var totalWithFallback = 0;

      tradingDays.forEach(function (dateStr) {
        var dayCandles = daysMap[dateStr];
        var expiry = findClosestExpiry(dateStr, expiriesList);
        var plan = expiryPlan[expiry];
        var atmStrike = plan.dateAtm[dateStr];

        var strikeRange = [];
        for (var off = -STRIKE_RANGE; off <= STRIKE_RANGE; off += STRIKE_STEP) {
          strikeRange.push(atmStrike + off);
        }

        dayCandles.forEach(function (candle) {
          var optionsObj = {};
          var hasReal = false;

          strikeRange.forEach(function (strike) {
            var ceVal = null;
            var peVal = null;

            if (optionData[candle.timestamp] && optionData[candle.timestamp][strike]) {
              var opt = optionData[candle.timestamp][strike];
              if (opt.CE) { ceVal = opt.CE; hasReal = true; }
              if (opt.PE) { peVal = opt.PE; hasReal = true; }
            }

            if (!ceVal) {
              ceVal = {
                open: Math.max(0, candle.open - strike),
                high: Math.max(0, candle.high - strike),
                low: Math.max(0, candle.low - strike),
                close: Math.max(0, candle.close - strike),
                volume: 0
              };
            }
            if (!peVal) {
              peVal = {
                open: Math.max(0, strike - candle.open),
                high: Math.max(0, strike - candle.low),
                low: Math.max(0, strike - candle.high),
                close: Math.max(0, strike - candle.close),
                volume: 0
              };
            }

            optionsObj[strike] = {
              CE: {
                open: parseFloat(ceVal.open.toFixed(2)),
                high: parseFloat(ceVal.high.toFixed(2)),
                low: parseFloat(ceVal.low.toFixed(2)),
                close: parseFloat(ceVal.close.toFixed(2)),
                volume: ceVal.volume
              },
              PE: {
                open: parseFloat(peVal.open.toFixed(2)),
                high: parseFloat(peVal.high.toFixed(2)),
                low: parseFloat(peVal.low.toFixed(2)),
                close: parseFloat(peVal.close.toFixed(2)),
                volume: peVal.volume
              }
            };
          });

          if (hasReal) totalWithRealOpts++;
          else totalWithFallback++;

          var atmOptions = optionsObj[atmStrike];
          var callClose = atmOptions ? atmOptions.CE.close : Math.max(0, candle.close - atmStrike);
          var putClose = atmOptions ? atmOptions.PE.close : Math.max(0, atmStrike - candle.close);

          mergedData.push({
            timestamp: candle.timestamp,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            atmStrike: atmStrike,
            callClose: parseFloat(callClose.toFixed(2)),
            putClose: parseFloat(putClose.toFixed(2)),
            options: optionsObj
          });
        });
      });

      // Save monthly files
      if (!fs.existsSync(OUT_DIR)) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
      }

      var monthlyGroups = {};
      mergedData.forEach(function (candle) {
        var monthStr = candle.timestamp.slice(0, 7);
        if (!monthlyGroups[monthStr]) monthlyGroups[monthStr] = [];
        monthlyGroups[monthStr].push(candle);
      });

      console.log('\nWriting monthly files to: ' + OUT_DIR);
      var months = Object.keys(monthlyGroups).sort();
      months.forEach(function (month) {
        var candles = monthlyGroups[month];
        var file = path.join(OUT_DIR, month + '.json');
        fs.writeFileSync(file, JSON.stringify(candles));
        var sizeMB = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
        console.log('  ' + month + '.json: ' + candles.length + ' candles (' + sizeMB + ' MB)');
      });

      // Clean up checkpoint files on successful completion of chunk or custom range
      if (isCustomRange) {
        cleanupCheckpoint();
      } else {
        // Mark chunk as completed
        checkpoint.completedChunks[activeChunk.name] = true;
        checkpoint.currentChunkName = '';
        checkpoint.completedExpiries = {};
        checkpoint.optionData = {};
        saveCheckpoint(checkpoint);

        // Clean up spot cache
        try {
          if (fs.existsSync(SPOT_CACHE_FILE)) fs.unlinkSync(SPOT_CACHE_FILE);
        } catch (e) { /* ignore */ }
      }

      // Automatically run daily splitting script to process monthly files
      console.log('\nRunning split_nifty_by_day.js to split the new monthly files into daily files...');
      try {
        var execSync = require('child_process').execSync;
        execSync('node scripts/split_nifty_by_day.js', { stdio: 'inherit' });
        console.log('Daily files split successfully!');
      } catch (err) {
        console.error('Error running split_nifty_by_day.js:', err.message);
      }

      var durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log('\n===================================================');
      console.log('  FETCH COMPLETE IN ' + durationSec + 's');
      console.log('  Total Candles      : ' + mergedData.length);
      console.log('  With Real Options  : ' + totalWithRealOpts);
      console.log('  With Fallback Only : ' + totalWithFallback);
      console.log('  Total API Calls    : ' + apiCallCount);
      console.log('  Strikes Per Candle : ' + ((STRIKE_RANGE * 2 / STRIKE_STEP) + 1));
      console.log('===================================================');
      if (!isCustomRange && activeChunk) {
        console.log('Chunk ' + activeChunk.name + ' completed. Next run will automatically start the next chunk.');
      }
    });
  });
}

run().catch(function (err) {
  console.error('\nFATAL ERROR:', err);
  console.error('Progress has been saved. Re-run the same command to resume.');
  process.exit(1);
});
