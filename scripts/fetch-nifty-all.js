/**
 * fetch-nifty-all.js
 * 
 * Comprehensive 1-minute historical data fetcher for Nifty 50:
 * - Spot Data (reused from existing files, missing range fetched from Upstox)
 * - Futures Data (near-month expired futures fetched for all months 2024-09 to 2026-06)
 * - Options Data (ATM +/- 800 strike range, step 50 for CE & PE)
 * 
 * Modular Per-Expiry Checkpoint System:
 * - Saves each expiry's option data in public/data/_checkpoint/options_<expiry>.json
 * - Avoids V8 string size limits and keeps memory usage low
 * - Auto-resumes from last incomplete expiry
 * - Saves monthly JSON files in public/data/nifty_1min/
 * 
 * Usage:
 *   node scripts/fetch-nifty-all.js [access_token] [start_date] [end_date]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

let ACCESS_TOKEN = process.argv[2] || process.env.UPSTOX_ACCESS_TOKEN;
const tokenFilePath = path.join(__dirname, '..', 'access_token.txt');
if (!ACCESS_TOKEN && fs.existsSync(tokenFilePath)) {
  ACCESS_TOKEN = fs.readFileSync(tokenFilePath, 'utf8').trim();
}

const START_DATE_STR = process.argv[3] || '2024-09-27';
const END_DATE_STR = process.argv[4] || '2026-06-30';
const FRESH_START = process.argv.indexOf('--fresh') >= 0;

const OUT_DIR = path.join(__dirname, '..', 'public', 'data', 'nifty_1min');
const CHECKPOINT_DIR = path.join(__dirname, '..', 'public', 'data', '_checkpoint');
const CHECKPOINT_FILE = path.join(CHECKPOINT_DIR, 'fetch_all_progress.json');

const STRIKE_STEP = 50;
const STRIKE_RANGE = 800; // ATM +/- 800
const INDEX_KEY = 'NSE_INDEX|Nifty 50';
const INDEX_KEY_ENC = encodeURIComponent(INDEX_KEY);

if (!ACCESS_TOKEN) {
  console.error('ERROR: Upstox Access Token is required.');
  console.log('Usage: node scripts/fetch-nifty-all.js [access_token] [start_date] [end_date]');
  process.exit(1);
}

// --- Helpers ---

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    const parsed = require('url').parse(urlStr);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.path,
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + ACCESS_TOKEN
      }
    };
    https.get(opts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    }).on('error', reject);
  });
}

// --- Rate Limiter & Scheduler ---

let apiCallCount = 0;
let throttleMs = 1250; // Base delay ~1250ms = 48 req/min = 1440 req/30min
const windowMs = 30 * 60 * 1000;
const maxRequestsPerWindow = 1850;
const requestTimestamps = [];
let authFailed = false;

async function apiRequest(url, retries = 20) {
  if (authFailed) return null;

  const now = Date.now();
  while (requestTimestamps.length > 0 && (now - requestTimestamps[0]) > windowMs) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= maxRequestsPerWindow) {
    const waitTime = windowMs - (now - requestTimestamps[0]) + 5000;
    console.warn(`\n[Rate Limiter] 30-min threshold reached (${requestTimestamps.length}/${maxRequestsPerWindow}). Pausing for ${(waitTime / 1000 / 60).toFixed(1)} minutes...`);
    await sleep(waitTime);
    return apiRequest(url, retries);
  }

  await sleep(throttleMs);
  requestTimestamps.push(Date.now());
  apiCallCount++;

  try {
    const res = await httpsGet(url);

    if (res.status === 401) {
      const errMsg = (res.body && res.body.errors && res.body.errors[0]) ? res.body.errors[0].message : 'Unauthorized';
      console.error('\n❌ AUTHENTICATION FAILED: ' + errMsg);
      console.error('   Your token is invalid or expired. Progress is saved in checkpoint.');
      authFailed = true;
      process.exit(1);
    }

    if (res.status === 429 || res.status === 503) {
      throttleMs = Math.min(throttleMs + 200, 2500);
      if (retries > 0) {
        const attemptNum = 20 - retries;
        const waitMs = attemptNum === 0 ? 120000 : 300000; // 2 min first time, 5 min subsequent
        console.warn(`  [Rate limited ${res.status}] Pausing for ${(waitMs / 1000 / 60).toFixed(1)} minutes to reset 30-min quota (Attempt ${attemptNum + 1})...`);
        await sleep(waitMs);
        return apiRequest(url, retries - 1);
      }
      console.error('\n⚠️ Rate limit retries exhausted. Exiting.');
      process.exit(1);
    }

    if (res.status === 200 && res.body && res.body.status === 'success') {
      throttleMs = Math.max(throttleMs - 1, 1250);
      return res.body;
    }

    if (res.status !== 200) {
      const apiErr = (res.body && res.body.errors && res.body.errors[0]) ? res.body.errors[0].message : ('HTTP ' + res.status);
      console.warn(`  [API Error ${res.status}] ${apiErr}`);
    }
    return null;
  } catch (err) {
    if (retries > 0) {
      await sleep(3000);
      return apiRequest(url, retries - 1);
    }
    console.error('  [Network Error] ' + err.message);
    process.exit(1);
  }
}

// --- Checkpoint ---

function ensureCheckpointDir() {
  if (!fs.existsSync(CHECKPOINT_DIR)) fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
}

function loadCheckpoint() {
  if (FRESH_START) {
    console.log('Fresh start requested. Ignoring checkpoint.\n');
    return { completedExpiries: {}, futuresData: {} };
  }
  if (fs.existsSync(CHECKPOINT_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
      const count = Object.keys(data.completedExpiries || {}).length;
      const futCount = Object.keys(data.futuresData || {}).length;
      console.log(`♻️ Resuming from checkpoint: ${count} expiries and ${futCount} futures candles loaded.\n`);
      return data;
    } catch (e) {
      console.warn('Checkpoint corrupt. Starting fresh.\n');
    }
  }
  return { completedExpiries: {}, futuresData: {} };
}

function saveProgressMeta(completedExpiries, futuresData) {
  ensureCheckpointDir();
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ completedExpiries, futuresData }));
}

function saveExpiryOptionsCheckpoint(expiry, expiryOptionData) {
  ensureCheckpointDir();
  const file = path.join(CHECKPOINT_DIR, `options_${expiry}.json`);
  fs.writeFileSync(file, JSON.stringify(expiryOptionData));
}

function loadExpiryOptionsCheckpoint(expiry) {
  const file = path.join(CHECKPOINT_DIR, `options_${expiry}.json`);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {}
  }
  return {};
}

function cleanupCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_DIR)) {
      const files = fs.readdirSync(CHECKPOINT_DIR);
      files.forEach(f => fs.unlinkSync(path.join(CHECKPOINT_DIR, f)));
      fs.rmdirSync(CHECKPOINT_DIR);
    }
  } catch (e) {}
}

// --- Spot Data ---

function loadExistingSpotCandles() {
  console.log('[Spot] Loading existing spot candles from public/data/nifty_1min/...');
  let spotCandles = [];
  if (fs.existsSync(OUT_DIR)) {
    const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json')).sort();
    files.forEach(f => {
      const filePath = path.join(OUT_DIR, f);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        data.forEach(c => {
          const dateStr = c.timestamp.split('T')[0];
          if (dateStr >= START_DATE_STR && dateStr <= END_DATE_STR) {
            spotCandles.push({
              timestamp: c.timestamp,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume
            });
          }
        });
      } catch (e) {}
    });
  }
  
  const map = new Map();
  spotCandles.forEach(c => map.set(c.timestamp, c));
  spotCandles = Array.from(map.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  console.log(`[Spot] Loaded ${spotCandles.length} candles from disk.`);
  return spotCandles;
}

async function fetchMissingSpot(fromDate, toDate) {
  let allCandles = [];
  let currentEnd = new Date(toDate);
  const startLimit = new Date(fromDate);

  console.log(`[Spot] Fetching missing Spot candles from ${fromDate} to ${toDate}...`);

  while (currentEnd >= startLimit) {
    let currentStart = new Date(currentEnd);
    currentStart.setDate(currentStart.getDate() - 28);
    if (currentStart < startLimit) currentStart = new Date(startLimit);

    const fromStr = formatDate(currentStart);
    const toStr = formatDate(currentEnd);

    const url = `https://api.upstox.com/v3/historical-candle/${INDEX_KEY_ENC}/minutes/1/${toStr}/${fromStr}`;
    const res = await apiRequest(url);
    if (res && res.data && res.data.candles) {
      res.data.candles.forEach(row => {
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
  }

  allCandles.reverse();
  return allCandles;
}

// --- Expiries & Futures ---

async function fetchExpiredExpiries() {
  const url = `https://api.upstox.com/v2/expired-instruments/expiries?instrument_key=${INDEX_KEY_ENC}`;
  const res = await apiRequest(url);
  if (res && Array.isArray(res.data)) return res.data.sort();
  return [];
}

function findClosestExpiry(dateStr, expiries) {
  for (let i = 0; i < expiries.length; i++) {
    if (expiries[i] >= dateStr) return expiries[i];
  }
  return dateStr;
}

function getMonthlyFutureExpiries(expiriesList) {
  const monthMap = {};
  expiriesList.forEach(exp => {
    const yyyyMm = exp.slice(0, 7);
    if (!monthMap[yyyyMm] || exp > monthMap[yyyyMm]) {
      monthMap[yyyyMm] = exp;
    }
  });
  return Object.values(monthMap).sort();
}

async function fetchFutureContract(expiryDate) {
  const url = `https://api.upstox.com/v2/expired-instruments/future/contract?instrument_key=${INDEX_KEY_ENC}&expiry_date=${expiryDate}`;
  const res = await apiRequest(url);
  if (res && Array.isArray(res.data) && res.data.length > 0) {
    return res.data[0].instrument_key;
  }
  return null;
}

async function fetchFutureCandles(futKey, fromDate, toDate) {
  const url = `https://api.upstox.com/v2/expired-instruments/historical-candle/${encodeURIComponent(futKey)}/1minute/${toDate}/${fromDate}`;
  const res = await apiRequest(url);
  const map = {};
  if (res && res.data && res.data.candles) {
    res.data.candles.forEach(row => {
      map[row[0]] = {
        open: parseFloat(row[1]),
        high: parseFloat(row[2]),
        low: parseFloat(row[3]),
        close: parseFloat(row[4]),
        volume: parseInt(row[5], 10),
        openInterest: parseInt(row[6] || 0, 10)
      };
    });
  }
  return map;
}

// --- Options ---

const contractsCache = {};

async function fetchContractsForExpiry(expiry) {
  if (contractsCache[expiry]) return contractsCache[expiry];
  const url = `https://api.upstox.com/v2/expired-instruments/option/contract?instrument_key=${INDEX_KEY_ENC}&expiry_date=${expiry}`;
  const res = await apiRequest(url);
  if (res && Array.isArray(res.data)) {
    contractsCache[expiry] = res.data;
    return res.data;
  }
  contractsCache[expiry] = [];
  return [];
}

function findContractKey(contracts, strike, optionType) {
  for (let i = 0; i < contracts.length; i++) {
    if (parseFloat(contracts[i].strike_price) === strike && contracts[i].instrument_type === optionType) {
      return contracts[i].instrument_key;
    }
  }
  return null;
}

async function fetchOptionCandles(instrumentKey, fromDate, toDate) {
  const url = `https://api.upstox.com/v2/expired-instruments/historical-candle/${encodeURIComponent(instrumentKey)}/1minute/${toDate}/${fromDate}`;
  const res = await apiRequest(url);
  const map = {};
  if (res && res.data && res.data.candles) {
    res.data.candles.forEach(row => {
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
}

// --- Main Execution ---

async function run() {
  const startTime = Date.now();
  console.log('===================================================');
  console.log('  Nifty All Data Fetcher (Spot + Futures + Options)');
  console.log(`  Target Date Range: ${START_DATE_STR} to ${END_DATE_STR}`);
  console.log(`  Option Strike Range: ATM +/- ${STRIKE_RANGE} (Step ${STRIKE_STEP})`);
  console.log('===================================================\n');

  // Step 0: Validate Access Token
  console.log('Validating Upstox Access Token...');
  const profileRes = await httpsGet('https://api.upstox.com/v2/user/profile');
  if (profileRes.status === 200 && profileRes.body && profileRes.body.status === 'success') {
    console.log(`✅ Token valid! User: ${profileRes.body.data.user_name}\n`);
  } else {
    console.error('❌ Token validation failed. Exiting.');
    process.exit(1);
  }

  // Load Checkpoint
  const checkpoint = loadCheckpoint();
  const completedExpiries = checkpoint.completedExpiries || {};
  const futuresData = checkpoint.futuresData || {};

  // Step 1: Load or fetch Spot candles
  let spotCandles = loadExistingSpotCandles();
  const maxSpotDate = spotCandles.length > 0 ? spotCandles[spotCandles.length - 1].timestamp.split('T')[0] : START_DATE_STR;

  if (maxSpotDate < END_DATE_STR) {
    const nextStart = formatDate(new Date(new Date(maxSpotDate).getTime() + 86400000));
    console.log(`Fetching missing Spot candles from ${nextStart} to ${END_DATE_STR}...`);
    const missingSpot = await fetchMissingSpot(nextStart, END_DATE_STR);
    console.log(`Fetched ${missingSpot.length} missing Spot candles.`);
    spotCandles = spotCandles.concat(missingSpot);
  }

  spotCandles = spotCandles.filter(c => {
    const d = c.timestamp.split('T')[0];
    return d >= START_DATE_STR && d <= END_DATE_STR;
  });

  const daysMap = {};
  spotCandles.forEach(c => {
    const dateStr = c.timestamp.split('T')[0];
    if (!daysMap[dateStr]) daysMap[dateStr] = [];
    daysMap[dateStr].push(c);
  });
  const tradingDays = Object.keys(daysMap).sort();
  console.log(`Total Spot candles: ${spotCandles.length} across ${tradingDays.length} trading days.\n`);

  // Step 2: Fetch Expiries list
  console.log('Fetching expired expiries list...');
  const expiriesList = await fetchExpiredExpiries();
  console.log(`Found ${expiriesList.length} total expiries.\n`);

  // Step 3: Futures Data fetching
  console.log('--- Fetching Futures Data ---');
  const monthlyExpiries = getMonthlyFutureExpiries(expiriesList);
  console.log(`Identified ${monthlyExpiries.length} monthly future expiries.`);

  const loadedFuturesCount = Object.keys(futuresData).length;
  if (loadedFuturesCount > 0) {
    console.log(`♻️ Futures data loaded from checkpoint (${loadedFuturesCount} candles). Skipping futures fetch.`);
  } else {
    for (let m = 0; m < monthlyExpiries.length; m++) {
      const monthlyExpiry = monthlyExpiries[m];
      if (monthlyExpiry < START_DATE_STR) continue;

      const prevMonthlyExpiry = (m > 0) ? monthlyExpiries[m - 1] : START_DATE_STR;
      const startDate = (prevMonthlyExpiry >= START_DATE_STR) ? prevMonthlyExpiry : START_DATE_STR;
      const endDate = (monthlyExpiry <= END_DATE_STR) ? monthlyExpiry : END_DATE_STR;

      if (startDate > END_DATE_STR || endDate < START_DATE_STR) continue;

      console.log(`[Futures ${m + 1}/${monthlyExpiries.length}] Expiry ${monthlyExpiry} (Fetch range: ${startDate} to ${endDate})...`);

      const futKey = await fetchFutureContract(monthlyExpiry);
      if (futKey) {
        const candlesMap = await fetchFutureCandles(futKey, startDate, endDate);
        const timestamps = Object.keys(candlesMap);
        timestamps.forEach(ts => {
          futuresData[ts] = candlesMap[ts];
        });
        console.log(`  Fetched ${timestamps.length} futures candles.`);
      } else {
        console.warn(`  No future contract key found for ${monthlyExpiry}`);
      }
    }
    saveProgressMeta(completedExpiries, futuresData);
  }
  console.log(`Total futures candles collected: ${Object.keys(futuresData).length}\n`);

  // Step 4: Build Expiry Plan for Options
  console.log('--- Fetching Options Data ---');
  const expiryPlan = {};

  tradingDays.forEach(dateStr => {
    const dayCandles = daysMap[dateStr];
    dayCandles.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const openPrice = dayCandles[0].open;
    const atmStrike = Math.round(openPrice / STRIKE_STEP) * STRIKE_STEP;
    const expiry = findClosestExpiry(dateStr, expiriesList);

    if (!expiryPlan[expiry]) {
      expiryPlan[expiry] = { dates: [], strikes: {}, minDate: dateStr, maxDate: dateStr, dateAtm: {} };
    }

    expiryPlan[expiry].dates.push(dateStr);
    expiryPlan[expiry].dateAtm[dateStr] = atmStrike;

    if (dateStr < expiryPlan[expiry].minDate) expiryPlan[expiry].minDate = dateStr;
    if (dateStr > expiryPlan[expiry].maxDate) expiryPlan[expiry].maxDate = dateStr;

    for (let off = -STRIKE_RANGE; off <= STRIKE_RANGE; off += STRIKE_STEP) {
      expiryPlan[expiry].strikes[atmStrike + off] = true;
    }
  });

  const expiriesToFetch = Object.keys(expiryPlan).sort().filter(e => e >= START_DATE_STR && e <= END_DATE_STR);
  let alreadyDoneCount = 0;
  expiriesToFetch.forEach(exp => {
    if (completedExpiries[exp]) alreadyDoneCount++;
  });

  console.log(`Options Expiries Total: ${expiriesToFetch.length} | Already Done: ${alreadyDoneCount} | Remaining: ${expiriesToFetch.length - alreadyDoneCount}\n`);

  const optionFetchStart = Date.now();
  let skippedCount = 0;

  for (let eIdx = 0; eIdx < expiriesToFetch.length; eIdx++) {
    const expiry = expiriesToFetch[eIdx];
    const plan = expiryPlan[expiry];
    const strikes = Object.keys(plan.strikes).map(Number).sort((a, b) => a - b);

    if (completedExpiries[expiry]) {
      skippedCount++;
      if (skippedCount <= 3 || skippedCount === alreadyDoneCount) {
        console.log(`[Expiry ${eIdx + 1}/${expiriesToFetch.length}] ${expiry} - SKIPPED (already in checkpoint)`);
      } else if (skippedCount === 4) {
        console.log(`  ... skipping ${alreadyDoneCount - 3} more finished expiries ...`);
      }
      continue;
    }

    const elapsedSec = ((Date.now() - optionFetchStart) / 1000).toFixed(0);
    const pct = (((eIdx + 1) / expiriesToFetch.length) * 100).toFixed(1);
    console.log(`[Expiry ${eIdx + 1}/${expiriesToFetch.length} | ${pct}% | ${elapsedSec}s] Expiry: ${expiry} | Days: ${plan.dates.length} | Strikes: ${strikes.length}`);

    const contracts = await fetchContractsForExpiry(expiry);
    let fetchedCandleCount = 0;
    const expiryOptionData = {};

    for (const strike of strikes) {
      const ceKey = findContractKey(contracts, strike, 'CE');
      const peKey = findContractKey(contracts, strike, 'PE');

      if (ceKey) {
        const ceMap = await fetchOptionCandles(ceKey, plan.minDate, expiry);
        Object.keys(ceMap).forEach(ts => {
          if (!expiryOptionData[ts]) expiryOptionData[ts] = {};
          if (!expiryOptionData[ts][strike]) expiryOptionData[ts][strike] = {};
          expiryOptionData[ts][strike].CE = ceMap[ts];
          fetchedCandleCount++;
        });
      }

      if (peKey) {
        const peMap = await fetchOptionCandles(peKey, plan.minDate, expiry);
        Object.keys(peMap).forEach(ts => {
          if (!expiryOptionData[ts]) expiryOptionData[ts] = {};
          if (!expiryOptionData[ts][strike]) expiryOptionData[ts][strike] = {};
          expiryOptionData[ts][strike].PE = peMap[ts];
          fetchedCandleCount++;
        });
      }
    }

    console.log(`  ✅ Expiry ${expiry} complete: ${fetchedCandleCount} option candle points.`);
    saveExpiryOptionsCheckpoint(expiry, expiryOptionData);
    completedExpiries[expiry] = { status: 'done', candles: fetchedCandleCount, timestamp: new Date().toISOString() };
    saveProgressMeta(completedExpiries, futuresData);
  }

  console.log('\n--- Option & Futures Fetching Finished ---');
  console.log(`Total API Calls Made: ${apiCallCount}\n`);

  // Step 5: Merge Spot, Futures, and Options Data into Monthly JSON Files
  console.log('Merging Spot, Futures, and Options data...');

  // Build combined optionData map by loading expiry checkpoint files
  const combinedOptionData = {};
  expiriesToFetch.forEach(expiry => {
    if (completedExpiries[expiry]) {
      const optMap = loadExpiryOptionsCheckpoint(expiry);
      Object.keys(optMap).forEach(ts => {
        combinedOptionData[ts] = optMap[ts];
      });
    }
  });

  const mergedData = [];
  tradingDays.forEach(dateStr => {
    const dayCandles = daysMap[dateStr];
    const expiry = findClosestExpiry(dateStr, expiriesList);
    const plan = expiryPlan[expiry];
    const atmStrike = plan ? plan.dateAtm[dateStr] : Math.round(dayCandles[0].open / STRIKE_STEP) * STRIKE_STEP;

    const strikeRange = [];
    for (let off = -STRIKE_RANGE; off <= STRIKE_RANGE; off += STRIKE_STEP) {
      strikeRange.push(atmStrike + off);
    }

    dayCandles.forEach(candle => {
      const optionsObj = {};

      strikeRange.forEach(strike => {
        let ceVal = null;
        let peVal = null;

        if (combinedOptionData[candle.timestamp] && combinedOptionData[candle.timestamp][strike]) {
          const opt = combinedOptionData[candle.timestamp][strike];
          if (opt.CE) ceVal = opt.CE;
          if (opt.PE) peVal = opt.PE;
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

      const atmOptions = optionsObj[atmStrike];
      const callClose = atmOptions ? atmOptions.CE.close : Math.max(0, candle.close - atmStrike);
      const putClose = atmOptions ? atmOptions.PE.close : Math.max(0, atmStrike - candle.close);

      const futVal = futuresData[candle.timestamp];
      const futureObj = futVal ? {
        open: parseFloat(futVal.open.toFixed(2)),
        high: parseFloat(futVal.high.toFixed(2)),
        low: parseFloat(futVal.low.toFixed(2)),
        close: parseFloat(futVal.close.toFixed(2)),
        volume: futVal.volume,
        openInterest: futVal.openInterest || 0
      } : {
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        openInterest: 0
      };

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
        future: futureObj,
        options: optionsObj
      });
    });
  });

  // Save monthly files
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const monthlyGroups = {};
  mergedData.forEach(candle => {
    const monthStr = candle.timestamp.slice(0, 7);
    if (!monthlyGroups[monthStr]) monthlyGroups[monthStr] = [];
    monthlyGroups[monthStr].push(candle);
  });

  console.log('\nWriting monthly files to: ' + OUT_DIR);
  const months = Object.keys(monthlyGroups).sort();
  months.forEach(month => {
    const candles = monthlyGroups[month];
    const file = path.join(OUT_DIR, month + '.json');
    fs.writeFileSync(file, JSON.stringify(candles, null, 2));
    const sizeMB = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
    console.log(`  ${month}.json: ${candles.length} candles (${sizeMB} MB)`);
  });

  cleanupCheckpoint();

  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n===================================================');
  console.log(`  FETCH COMPLETE IN ${totalSec}s`);
  console.log(`  Total Candles Merged: ${mergedData.length}`);
  console.log(`  Total API Calls Made: ${apiCallCount}`);
  console.log(`  Strikes Per Candle  : ${(STRIKE_RANGE * 2 / STRIKE_STEP) + 1}`);
  console.log('===================================================');
}

run().catch(err => {
  console.error('\nFATAL ERROR:', err);
  console.error('Progress saved in checkpoint. Re-run to resume.');
  process.exit(1);
});
