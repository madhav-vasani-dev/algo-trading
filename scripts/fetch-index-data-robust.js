/**
 * fetch-index-data-robust.js
 * 
 * A rate-limit-safe, incremental, self-healing historical data fetcher
 * for both NIFTY and BANKNIFTY spot and options data from Upstox.
 * 
 * Usage:
 *   node scripts/fetch-index-data-robust.js <NIFTY|BANKNIFTY> <access_token> [start_date] [end_date]
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const INDEX = process.argv[2];
let ACCESS_TOKEN = process.argv[3] || process.env.UPSTOX_ACCESS_TOKEN;

const tokenFilePath = path.join(__dirname, '..', 'access_token.txt');
if (fs.existsSync(tokenFilePath)) {
  ACCESS_TOKEN = fs.readFileSync(tokenFilePath, 'utf8').trim();
}

const START_DATE_STR = process.argv[4] || '2024-09-27';
const END_DATE_STR = process.argv[5] || '2026-06-18';

if (!INDEX || (INDEX !== 'NIFTY' && INDEX !== 'BANKNIFTY')) {
  console.error('ERROR: Index name is required. Must be NIFTY or BANKNIFTY.');
  console.log('Usage: node scripts/fetch-index-data-robust.js <NIFTY|BANKNIFTY> <access_token> [start_date] [end_date]');
  process.exit(1);
}

if (!ACCESS_TOKEN) {
  console.error('ERROR: Upstox Access Token is required.');
  process.exit(1);
}

const config = {
  NIFTY: {
    instrumentKey: 'NSE_INDEX|Nifty 50',
    strikeStep: 50,
    outDir: path.join(__dirname, '..', 'public', 'data', 'nifty_1min')
  },
  BANKNIFTY: {
    instrumentKey: 'NSE_INDEX|Nifty Bank',
    strikeStep: 100,
    outDir: path.join(__dirname, '..', 'public', 'data', 'banknifty_1min')
  }
}[INDEX];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let currentDelay = 1200; // Start at 1200ms sleep between requests

async function throttledRequest(url, headers = {}, retries = 15) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await sleep(currentDelay);
    try {
      const response = await axios.get(url, { headers });
      // Slowly decrease sleep interval if requests are succeeding
      if (currentDelay > 1200) currentDelay -= 5;
      return response.data;
    } catch (error) {
      const status = error.response ? error.response.status : null;
      if ((status === 429 || status === 503) && attempt < retries) {
        // Increase sleep delay on rate limit
        currentDelay = Math.min(2000, currentDelay + 200);
        const delay = Math.min(10, Math.pow(2, attempt + 1)) * 1000;
        console.warn(`[Upstox API] Rate limited (${status}). Increasing delay to ${currentDelay}ms. Retrying in ${delay / 1000}s...`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
}


function formatDate(date) {
  return date.toISOString().split('T')[0];
}

async function fetchSpot(fromDate, toDate) {
  let allCandles = [];
  let currentEnd = new Date(toDate);
  const startLimit = new Date(fromDate);

  console.log(`[Spot] Fetching ${config.instrumentKey} candles from ${fromDate} to ${toDate}...`);

  while (currentEnd >= startLimit) {
    let currentStart = new Date(currentEnd);
    currentStart.setDate(currentStart.getDate() - 28);
    if (currentStart < startLimit) currentStart = new Date(startLimit);

    const fromStr = formatDate(currentStart);
    const toStr = formatDate(currentEnd);

    const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(config.instrumentKey)}/minutes/1/${toStr}/${fromStr}`;
    try {
      console.log(`  Fetching Spot chunk: ${fromStr} to ${toStr}...`);
      const res = await throttledRequest(url, {
        'Accept': 'application/json',
        'Authorization': `Bearer ${ACCESS_TOKEN}`
      });

      if (res && res.status === 'success' && res.data && res.data.candles) {
        const parsed = res.data.candles.map(row => ({
          timestamp: row[0],
          open: parseFloat(row[1]),
          high: parseFloat(row[2]),
          low: parseFloat(row[3]),
          close: parseFloat(row[4]),
          volume: parseInt(row[5], 10)
        }));
        allCandles = allCandles.concat(parsed);
      }
    } catch (err) {
      console.error(`  Error fetching Spot chunk ${fromStr} to ${toStr}:`, err.message);
      break;
    }

    currentEnd = new Date(currentStart);
    currentEnd.setDate(currentEnd.getDate() - 1);
  }

  allCandles.reverse();
  return allCandles;
}

async function fetchExpiredExpiries() {
  const url = `https://api.upstox.com/v2/expired-instruments/expiries?instrument_key=${encodeURIComponent(config.instrumentKey)}`;
  try {
    const res = await throttledRequest(url, {
      'Accept': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`
    });
    if (res && res.status === 'success' && Array.isArray(res.data)) {
      return res.data.sort();
    }
  } catch (err) {
    console.error('Error fetching expired expiries:', err.message);
    const status = err.response ? err.response.status : null;
    if (status === 429 || status === 401) {
      throw err;
    }
  }
  return [];
}

const expiryContractsCache = new Map();

async function getContractsForExpiry(expiryDate) {
  if (expiryContractsCache.has(expiryDate)) {
    return expiryContractsCache.get(expiryDate);
  }
  const url = `https://api.upstox.com/v2/expired-instruments/option/contract?instrument_key=${encodeURIComponent(config.instrumentKey)}&expiry_date=${expiryDate}`;
  try {
    const res = await throttledRequest(url, {
      'Accept': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`
    });
    if (res && res.status === 'success' && Array.isArray(res.data)) {
      expiryContractsCache.set(expiryDate, res.data);
      return res.data;
    }
  } catch (err) {
    console.error(`  Error fetching contracts for expiry ${expiryDate}:`, err.message);
    const status = err.response ? err.response.status : null;
    if (status === 429 || status === 401) {
      throw err;
    }
  }
  return null;
}

async function getExpiredOptionKeys(expiryDate, strikePrice) {
  const contracts = await getContractsForExpiry(expiryDate);
  if (!contracts) return { ceKey: null, peKey: null };
  const ceContract = contracts.find(c => parseFloat(c.strike_price) === strikePrice && c.instrument_type === 'CE');
  const peContract = contracts.find(c => parseFloat(c.strike_price) === strikePrice && c.instrument_type === 'PE');
  return {
    ceKey: ceContract ? ceContract.instrument_key : null,
    peKey: peContract ? peContract.instrument_key : null
  };
}

async function fetchExpiredOptionCandles(expiredKey, dateStr) {
  const url = `https://api.upstox.com/v2/expired-instruments/historical-candle/${encodeURIComponent(expiredKey)}/1minute/${dateStr}/${dateStr}`;
  try {
    const res = await throttledRequest(url, {
      'Accept': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`
    });
    if (res && res.status === 'success' && res.data && res.data.candles) {
      const map = new Map();
      res.data.candles.forEach(row => {
        map.set(row[0], {
          open: parseFloat(row[1]),
          high: parseFloat(row[2]),
          low: parseFloat(row[3]),
          close: parseFloat(row[4]),
          volume: parseInt(row[5], 10)
        });
      });
      return map;
    }
  } catch (err) {
    const status = err.response ? err.response.status : null;
    if (status === 429 || status === 401) {
      throw err;
    }
    // silently ignore and return empty
  }
  return new Map();
}

function getMonthlyExpiryForMonth(year, month, expiries) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const monthExpiries = expiries.filter(exp => exp.startsWith(prefix));
  if (monthExpiries.length === 0) {
    return null;
  }
  monthExpiries.sort();
  return monthExpiries[monthExpiries.length - 1];
}

function findClosestExpiry(dateStr, expiries) {
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  
  const currentMonthlyExpiry = getMonthlyExpiryForMonth(year, month, expiries);
  if (currentMonthlyExpiry && dateStr < currentMonthlyExpiry) {
    return currentMonthlyExpiry;
  }
  
  let nextMonth = month + 1;
  let nextYear = year;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  
  const nextMonthlyExpiry = getMonthlyExpiryForMonth(nextYear, nextMonth, expiries);
  if (nextMonthlyExpiry) {
    return nextMonthlyExpiry;
  }
  
  for (const exp of expiries) {
    if (exp >= dateStr) return exp;
  }
  return dateStr;
}

function aggregateSpotCandles(oneMinCandles, K) {
  if (K === 1) {
    return oneMinCandles.map(c => ({
      timestamp: c.timestamp,
      timeStr: c.timestamp.substring(11, 16),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }));
  }
  
  const blocks = new Map();
  oneMinCandles.forEach(c => {
    const parts = c.timestamp.substring(11, 16).split(':');
    const hour = parseInt(parts[0], 10);
    const minute = parseInt(parts[1], 10);
    const mins = hour * 60 + minute;
    const minsSinceOpen = mins - (9 * 60 + 15);
    
    if (minsSinceOpen < 0) return;
    
    const blockId = Math.floor(minsSinceOpen / K);
    if (!blocks.has(blockId)) {
      blocks.set(blockId, []);
    }
    blocks.get(blockId).push(c);
  });
  
  const aggregated = [];
  const sortedIds = Array.from(blocks.keys()).sort((a, b) => a - b);
  for (const blockId of sortedIds) {
    const list = blocks.get(blockId);
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const first = list[0];
    const last = list[list.length - 1];
    let high = -Infinity;
    let low = Infinity;
    list.forEach(c => {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
    });
    aggregated.push({
      timestamp: first.timestamp,
      timeStr: first.timestamp.substring(11, 16),
      open: first.open,
      high,
      low,
      close: last.close
    });
  }
  return aggregated;
}

function getPotentialStrikesForDay(oneMinCandles, strikeStep) {
  const strikes = new Set();
  
  const openPrice = oneMinCandles[0].open;
  const openStrike = Math.round(openPrice / strikeStep) * strikeStep;
  strikes.add(openStrike);
  strikes.add(openStrike - strikeStep);
  strikes.add(openStrike + strikeStep);
  
  const timeframes = [1, 3, 5, 10, 15];
  for (const K of timeframes) {
    const aggCandles = aggregateSpotCandles(oneMinCandles, K);
    
    for (let m = 2; m < aggCandles.length - 1; m++) {
      const C1 = aggCandles[m-2];
      const C2 = aggCandles[m-1];
      const C3 = aggCandles[m];
      
      const isGreen = C1.close > C1.open && C2.close > C2.open && C3.close > C3.open;
      const isRed = C1.close < C1.open && C2.close < C2.open && C3.close < C3.open;
      if (!isGreen && !isRed) continue;
      
      if (!(C3.high > C1.high && C3.high > C2.high)) continue;
      if (!(C1.low < C2.low && C1.low < C3.low)) continue;
      if ((C1.high - C3.low) <= 0) continue;
      
      const triggerSpot = C3.open;
      const direction = isGreen ? 'LONG' : 'SHORT';
      
      const nextBlock = aggCandles[m+1];
      if (!nextBlock) continue;
      
      const startIdx = oneMinCandles.findIndex(c => c.timestamp >= nextBlock.timestamp);
      if (startIdx === -1) continue;
      
      for (let i = startIdx; i < oneMinCandles.length; i++) {
        const c1 = oneMinCandles[i];
        const time = c1.timestamp.substring(11, 16);
        if (time <= '09:30' || time > '13:00') continue;
        
        let touch = false;
        if (direction === 'LONG') {
          if (c1.low <= triggerSpot) touch = true;
        } else {
          if (c1.high >= triggerSpot) touch = true;
        }
        
        if (touch) {
          const strike = Math.round(triggerSpot / strikeStep) * strikeStep;
          strikes.add(strike);
          strikes.add(strike - strikeStep);
          strikes.add(strike + strikeStep);
          break;
        }
      }
    }
  }
  return strikes;
}

async function run() {
  console.log('===================================================');
  console.log(`  Robust Data Fetcher: ${INDEX}`);
  console.log('===================================================');

  // Ensure output directory exists
  if (!fs.existsSync(config.outDir)) {
    fs.mkdirSync(config.outDir, { recursive: true });
  }

  // 1. Load existing cache from disk
  const existingFiles = fs.readdirSync(config.outDir).filter(f => f.endsWith('.json')).sort();
  const dayCache = new Map(); // key: dateStr, value: candles array with options

  for (const file of existingFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(config.outDir, file), 'utf8'));
      const daysMap = new Map();
      data.forEach(c => {
        const d = c.timestamp.substring(0, 10);
        if (!daysMap.has(d)) daysMap.set(d, []);
        daysMap.get(d).push(c);
      });

      for (const [dateStr, candles] of daysMap.entries()) {
        // Verify if options data has volume
        let totalOptVol = 0;
        candles.forEach(c => {
          if (c.options) {
            Object.values(c.options).forEach(opt => {
              if (opt.CE) totalOptVol += opt.CE.volume || 0;
              if (opt.PE) totalOptVol += opt.PE.volume || 0;
            });
          }
        });

        if (totalOptVol > 0) {
          dayCache.set(dateStr, candles);
        }
      }
    } catch (e) {
      console.warn(`Error reading cache file ${file}:`, e.message);
    }
  }
  console.log(`Loaded cache: ${dayCache.size} valid days already fetched.`);

  // 2. Fetch valid expiries list
  const expiries = await fetchExpiredExpiries();
  console.log(`Loaded ${expiries.length} expiries from Upstox.`);

  // 3. Fetch Spot candles
  const spotCandles = await fetchSpot(START_DATE_STR, END_DATE_STR);
  if (spotCandles.length === 0) {
    console.error('ERROR: No Spot data fetched.');
    process.exit(1);
  }
  console.log(`Fetched ${spotCandles.length} spot candles.`);

  // Group spot by day
  const spotDaysMap = new Map();
  spotCandles.forEach(c => {
    const d = c.timestamp.split('T')[0];
    if (!spotDaysMap.has(d)) spotDaysMap.set(d, []);
    spotDaysMap.get(d).push(c);
  });
  const tradingDays = Array.from(spotDaysMap.keys()).sort();
  console.log(`Found ${tradingDays.length} trading days in Spot data.`);

  let patchedCount = 0;
  let skippedCount = 0;

  // Process day by day
  for (let i = 0; i < tradingDays.length; i++) {
    const dateStr = tradingDays[i];
    const dayCandles = spotDaysMap.get(dateStr);
    dayCandles.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (dayCache.has(dateStr)) {
      skippedCount++;
      continue; // Skip already valid days
    }

    patchedCount++;
    console.log(`\n[Day ${i + 1}/${tradingDays.length}] Fetching ${INDEX} options for ${dateStr}...`);

    const openPrice = dayCandles[0].open;
    const openStrike = Math.round(openPrice / config.strikeStep) * config.strikeStep;
    const expiryDate = findClosestExpiry(dateStr, expiries);

    const targetStrikes = getPotentialStrikesForDay(dayCandles, config.strikeStep);
    const strikeRange = Array.from(targetStrikes).sort((a, b) => a - b);
    console.log(`  Spot Open: ${openPrice.toFixed(1)} | Expiry: ${expiryDate} | Strikes: ${strikeRange.join(', ')}`);

    const optionsDataMaps = {};

    for (const strike of strikeRange) {
      const keys = await getExpiredOptionKeys(expiryDate, strike);
      if (keys.ceKey && keys.peKey) {
        console.log(`  Fetching ${strike} CE/PE candles...`);
        const ceMap = await fetchExpiredOptionCandles(keys.ceKey, dateStr);
        const peMap = await fetchExpiredOptionCandles(keys.peKey, dateStr);

        if (ceMap.size > 0 && peMap.size > 0) {
          optionsDataMaps[strike] = { ceMap, peMap };
        }
      }
    }

    // Merge options data into each spot candle
    const mergedDayCandles = dayCandles.map(candle => {
      const optionsObj = {};

      strikeRange.forEach(strike => {
        let ceVal = null;
        let peVal = null;

        const maps = optionsDataMaps[strike];
        if (maps) {
          ceVal = maps.ceMap.get(candle.timestamp);
          peVal = maps.peMap.get(candle.timestamp);
        }

        // Fallback to intrinsic value if missing
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

      const openStrikeOptions = optionsObj[openStrike];
      const callClose = openStrikeOptions ? openStrikeOptions.CE.close : Math.max(0, candle.close - openStrike);
      const putClose = openStrikeOptions ? openStrikeOptions.PE.close : Math.max(0, openStrike - candle.close);

      return {
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        atmStrike: openStrike,
        callClose: parseFloat(callClose.toFixed(2)),
        putClose: parseFloat(putClose.toFixed(2)),
        options: optionsObj
      };
    });

    // Save this day to our memory cache
    dayCache.set(dateStr, mergedDayCandles);

    // Save the modified month file to disk immediately!
    const monthStr = dateStr.substring(0, 7);
    const monthFilePath = path.join(config.outDir, `${monthStr}.json`);

    // Collect all days in this month from the cache
    const monthCandles = [];
    for (const [dStr, candles] of dayCache.entries()) {
      if (dStr.startsWith(monthStr)) {
        monthCandles.push(...candles);
      }
    }

    monthCandles.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    fs.writeFileSync(monthFilePath, JSON.stringify(monthCandles, null, 2));
    console.log(`  [Incremental Save] Wrote month ${monthStr} to ${monthFilePath} (${monthCandles.length} candles)`);
  }

  console.log('\n===================================================');
  console.log(`  FETCH COMPLETE FOR ${INDEX}`);
  console.log(`  Skipped (Cached): ${skippedCount}`);
  console.log(`  Fetched (New/Patched): ${patchedCount}`);
  console.log('===================================================');
}

run().catch(err => {
  console.error('Fatal fetcher error:', err);
});
