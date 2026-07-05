/**
 * fetch-nifty-data.js
 * 
 * Fetches historical 1-minute data for NIFTY 50 (Spot) and the corresponding At-The-Money (ATM)
 * Call and Put option contracts from the Upstox API.
 * 
 * Usage:
 *   node scripts/fetch-nifty-data.js <access_token> [start_date] [end_date]
 * 
 * Example:
 *   node scripts/fetch-nifty-data.js your_upstox_token_here 2024-09-27 2026-06-06
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ACCESS_TOKEN = process.argv[2] || process.env.UPSTOX_ACCESS_TOKEN;
const START_DATE_STR = process.argv[3] || '2024-09-27';
const END_DATE_STR = process.argv[4] || new Date().toISOString().split('T')[0];

const OUT_DIR = path.join(__dirname, '..', 'public', 'data', 'nifty_1min');

if (!ACCESS_TOKEN) {
  console.error('ERROR: Upstox Access Token is required.');
  console.log('Usage: node scripts/fetch-nifty-data.js <access_token> [start_date] [end_date]');
  process.exit(1);
}

// Helper to delay execution (throttle requests to respect Upstox API rate limits)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to format Date to YYYY-MM-DD
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

// Find next Thursday (expiry day in Indian Markets for Nifty)
function getNextThursday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day <= 4) ? (4 - day) : (11 - day); // 4 = Thursday
  d.setDate(d.getDate() + diff);
  return formatDate(d);
}

/**
 * Throttled API request helper with exponential backoff on 429
 */
async function throttledRequest(url, headers = {}, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await sleep(200); // 200ms throttle to stay under 5 req/sec
    try {
      const response = await axios.get(url, { headers });
      return response.data;
    } catch (error) {
      const status = error.response ? error.response.status : null;
      if ((status === 429 || status === 503) && attempt < retries) {
        const delay = Math.pow(2, attempt + 1) * 1000;
        console.warn(`[Upstox API] Rate limited (${status}). Retrying in ${delay / 1000}s...`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Fetch Nifty Spot 1-minute historical candles in 30-day chunks
 */
async function fetchNiftySpot(fromDate, toDate) {
  const instrumentKey = 'NSE_INDEX|Nifty 50';
  let allCandles = [];
  let currentEnd = new Date(toDate);
  const startLimit = new Date(fromDate);

  console.log(`[Spot] Fetching Nifty 50 Spot candles from ${fromDate} to ${toDate}...`);

  while (currentEnd >= startLimit) {
    let currentStart = new Date(currentEnd);
    currentStart.setDate(currentStart.getDate() - 28); // 28-day chunks (29 days inclusive, within Upstox limit)
    if (currentStart < startLimit) currentStart = new Date(startLimit);

    const fromStr = formatDate(currentStart);
    const toStr = formatDate(currentEnd);

    const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(instrumentKey)}/minutes/1/${toStr}/${fromStr}`;
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

  // Reverse to make it chronological (oldest to newest)
  allCandles.reverse();
  return allCandles;
}

/**
 * Fetch all valid expired expiries for Nifty 50
 */
async function fetchExpiredExpiries() {
  const url = `https://api.upstox.com/v2/expired-instruments/expiries?instrument_key=NSE_INDEX%7CNifty%2050`;
  try {
    const res = await throttledRequest(url, {
      'Accept': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`
    });
    if (res && res.status === 'success' && Array.isArray(res.data)) {
      // Sort expiries chronologically
      return res.data.sort();
    }
  } catch (err) {
    console.error('Error fetching expired expiries:', err.message);
  }
  return [];
}

/**
 * Find the closest expired expiry date for a given trading date
 */
function findClosestExpiry(dateStr, expiries) {
  for (const exp of expiries) {
    if (exp >= dateStr) {
      return exp;
    }
  }
  // Fallback to next Thursday if expiries list is empty or dateStr is beyond the list
  const fallbackThursday = getNextThursday(dateStr);
  if (expiries.length > 0) {
    const latestExpired = expiries[expiries.length - 1];
    const diffTime = new Date(fallbackThursday) - new Date(latestExpired);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    // If the calculated fallback Thursday is within 6 days of the latest expired expiry,
    // they belong to the same weekly cycle, so the next expiry must be the following week.
    if (diffDays <= 6) {
      const nextWeekThursday = new Date(fallbackThursday);
      nextWeekThursday.setDate(nextWeekThursday.getDate() + 7);
      return formatDate(nextWeekThursday);
    }
  }
  return fallbackThursday;
}

const expiryContractsCache = new Map();

/**
 * Fetch expired option contracts list for an expiry date, caching results.
 */
async function getContractsForExpiry(expiryDate) {
  if (expiryContractsCache.has(expiryDate)) {
    return expiryContractsCache.get(expiryDate);
  }
  const url = `https://api.upstox.com/v2/expired-instruments/option/contract?instrument_key=NSE_INDEX%7CNifty%2050&expiry_date=${expiryDate}`;
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
    console.error(`  [Upstox API] Error fetching contracts for expiry ${expiryDate}:`, err.message);
  }
  return null;
}

/**
 * Fetch expired option contract details (specifically strike price & keys)
 */
async function getExpiredOptionKeys(expiryDate, strikePrice) {
  const contracts = await getContractsForExpiry(expiryDate);
  if (!contracts) {
    return { ceKey: null, peKey: null };
  }
  const ceContract = contracts.find(c => parseFloat(c.strike_price) === strikePrice && c.instrument_type === 'CE');
  const peContract = contracts.find(c => parseFloat(c.strike_price) === strikePrice && c.instrument_type === 'PE');
  
  return {
    ceKey: ceContract ? ceContract.instrument_key : null,
    peKey: peContract ? peContract.instrument_key : null
  };
}

/**
 * Fetch 1-minute historical candles for an expired option contract for a single day
 */
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
        const timestamp = row[0];
        map.set(timestamp, {
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
    // Fail silently, fallback will be used
  }
  return new Map();
}

/**
 * Main Downloader Execution
 */
async function run() {
  const startTime = Date.now();
  console.log(`===================================================`);
  console.log(`  Upstox Nifty 1-Min Data Fetcher (Spot + ATM Options)`);
  console.log(`===================================================`);
  
  // 1. Fetch valid expired expiries
  console.log('Fetching list of valid expired expiries from Upstox...');
  const expiriesList = await fetchExpiredExpiries();
  console.log(`Found ${expiriesList.length} expired expiries.`);
  if (expiriesList.length === 0) {
    console.warn('Warning: Could not fetch expired expiries. Will fallback to Next Thursday calculation.');
  }

  // 2. Fetch Nifty Spot Candles
  const spotCandles = await fetchNiftySpot(START_DATE_STR, END_DATE_STR);
  if (spotCandles.length === 0) {
    console.error('ERROR: No Nifty Spot data fetched. Verify token or date range.');
    process.exit(1);
  }

  console.log(`\nSuccessfully fetched ${spotCandles.length} Spot candles.`);
  
  // 3. Group spot candles by trading day
  const daysMap = new Map();
  spotCandles.forEach(candle => {
    const dateStr = candle.timestamp.split('T')[0];
    if (!daysMap.has(dateStr)) daysMap.set(dateStr, []);
    daysMap.get(dateStr).push(candle);
  });

  const tradingDays = Array.from(daysMap.keys()).sort();
  console.log(`Found ${tradingDays.length} trading days in Spot data.\n`);
  
  console.log('Fetching options contract premiums for each trading day...');
  let totalOptionsFetched = 0;
  let totalOptionsSimulated = 0;
  
  const mergedData = [];

  for (let i = 0; i < tradingDays.length; i++) {
    const dateStr = tradingDays[i];
    const dayCandles = daysMap.get(dateStr);
    
    dayCandles.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    
    const openPrice = dayCandles[0].open;
    const openStrike = Math.round(openPrice / 50) * 50;
    const expiryDate = findClosestExpiry(dateStr, expiriesList);

    console.log(`[Day ${i + 1}/${tradingDays.length}] ${dateStr} | Open: ${openPrice.toFixed(1)} | Open Strike: ${openStrike} | Expiry: ${expiryDate}`);

    // Generate list of 33 strikes around openStrike: [openStrike-800, openStrike-750, ..., openStrike+800]
    // Wide range needed for hedged straddle testing (buying cheap OTM options)
    const strikeRange = [];
    for (let offset = -800; offset <= 800; offset += 50) {
      strikeRange.push(openStrike + offset);
    }

    const optionsDataMaps = {}; // key is strike, value is { ceMap, peMap }
    let hasAnyRealOptions = false;

    for (const strike of strikeRange) {
      let keys = { ceKey: null, peKey: null };
      try {
        keys = await getExpiredOptionKeys(expiryDate, strike);
      } catch (e) {
        // API call failed
      }

      let ceCandlesMap = new Map();
      let peCandlesMap = new Map();

      if (keys.ceKey && keys.peKey) {
        ceCandlesMap = await fetchExpiredOptionCandles(keys.ceKey, dateStr);
        peCandlesMap = await fetchExpiredOptionCandles(keys.peKey, dateStr);
      }

      if (ceCandlesMap.size > 0 && peCandlesMap.size > 0) {
        optionsDataMaps[strike] = { ceMap: ceCandlesMap, peMap: peCandlesMap };
        hasAnyRealOptions = true;
      }
    }

    if (hasAnyRealOptions) {
      totalOptionsFetched++;
      console.log(`  Fetched option data for strikes: ${Object.keys(optionsDataMaps).join(', ')}`);
    } else {
      totalOptionsSimulated++;
      console.log(`  Using Spot-based delta-1 premium replication (No Upstox option keys available).`);
    }

    // Merge options data into each spot candle of this day
    dayCandles.forEach(candle => {
      const optionsObj = {};

      strikeRange.forEach(strike => {
        let ceVal = null;
        let peVal = null;

        const maps = optionsDataMaps[strike];
        if (maps) {
          ceVal = maps.ceMap.get(candle.timestamp);
          peVal = maps.peMap.get(candle.timestamp);
        }

        // Fallback to intrinsic value if missing or illiquid
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

      // For backward compatibility, keep root-level atmStrike, callClose, putClose using openStrike
      const openStrikeOptions = optionsObj[openStrike];
      const callClose = openStrikeOptions ? openStrikeOptions.CE.close : Math.max(0, candle.close - openStrike);
      const putClose = openStrikeOptions ? openStrikeOptions.PE.close : Math.max(0, openStrike - candle.close);

      mergedData.push({
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
      });
    });
  }

  // 3. Save to monthly files under public/data/nifty_1min/
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const monthlyGroups = {};
  mergedData.forEach(candle => {
    const monthStr = candle.timestamp.slice(0, 7); // e.g. "2024-09"
    if (!monthlyGroups[monthStr]) monthlyGroups[monthStr] = [];
    monthlyGroups[monthStr].push(candle);
  });

  console.log(`\nWriting monthly files to: ${OUT_DIR}`);
  for (const [month, candles] of Object.entries(monthlyGroups)) {
    const file = path.join(OUT_DIR, `${month}.json`);
    fs.writeFileSync(file, JSON.stringify(candles, null, 2));
    console.log(`  Saved ${candles.length} candles to ${file}`);
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n===================================================`);
  console.log(`  FETCH COMPLETE IN ${durationSec}s`);
  console.log(`  Total Candles Merged  : ${mergedData.length}`);
  console.log(`  Days with Real Options: ${totalOptionsFetched}`);
  console.log(`  Days with Sim Options : ${totalOptionsSimulated}`);
  console.log(`===================================================`);
}

run().catch(err => {
  console.error('\nFATAL ERROR running fetcher script:', err);
  process.exit(1);
});
