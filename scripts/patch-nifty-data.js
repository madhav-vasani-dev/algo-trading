/**
 * patch-nifty-data.js
 * 
 * Re-fetches options data for days that fell back to simulated (intrinsic) options
 * due to rate limits in previous runs.
 * 
 * Usage:
 *   node scripts/patch-nifty-data.js <access_token>
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ACCESS_TOKEN = process.argv[2] || process.env.UPSTOX_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error('ERROR: Upstox Access Token is required.');
  console.log('Usage: node scripts/patch-nifty-data.js <access_token>');
  process.exit(1);
}

const config = {
  instrumentKey: 'NSE_INDEX|Nifty 50',
  strikeStep: 50,
  dataDir: path.join(__dirname, '..', 'public', 'data', 'nifty_1min')
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function throttledRequest(url, headers = {}, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    // 1200ms delay to stay well under any rate limits
    await sleep(1200); 
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
    console.warn(`  Failed to fetch candles for ${expiredKey}: ${err.message}`);
  }
  return new Map();
}

function findClosestExpiry(dateStr, expiries) {
  for (const exp of expiries) {
    if (exp >= dateStr) return exp;
  }
  return dateStr; // fallback
}

async function run() {
  console.log('===================================================');
  console.log('  Nifty Options Data Quality Patcher');
  console.log('===================================================');

  // 1. Fetch valid expiries
  const expiries = await fetchExpiredExpiries();
  console.log(`Loaded ${expiries.length} expiries from Upstox.`);

  // 2. Scan monthly files to find days needing patch
  const files = fs.readdirSync(config.dataDir).filter(f => f.endsWith('.json')).sort();
  const patches = []; // array of { file, dateStr }

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(config.dataDir, file), 'utf8'));
    const daysMap = new Map();
    data.forEach(c => {
      const date = c.timestamp.substring(0, 10);
      if (!daysMap.has(date)) daysMap.set(date, []);
      daysMap.get(date).push(c);
    });

    for (const [dateStr, candles] of daysMap.entries()) {
      let totalOptVol = 0;
      candles.forEach(c => {
        if (c.options) {
          Object.values(c.options).forEach(opt => {
            if (opt.CE) totalOptVol += opt.CE.volume || 0;
            if (opt.PE) totalOptVol += opt.PE.volume || 0;
          });
        }
      });

      if (totalOptVol === 0) {
        patches.push({ file, dateStr, candles });
      }
    }
  }

  console.log(`Found ${patches.length} simulated days to patch.`);
  if (patches.length === 0) {
    console.log('All days have real options data. No patching needed!');
    return;
  }

  // 3. Process patch day-by-day
  for (let p = 0; p < patches.length; p++) {
    const { file, dateStr, candles } = patches[p];
    console.log(`\n[Patch ${p+1}/${patches.length}] Patching Nifty options for ${dateStr} in ${file}...`);

    const openPrice = candles[0].open;
    const openStrike = Math.round(openPrice / config.strikeStep) * config.strikeStep;
    const expiryDate = findClosestExpiry(dateStr, expiries);

    const candidateTimes = ['09:20', '09:30', '09:45', '10:00', '10:30', '11:00', '12:00', '13:00'];
    const targetStrikes = new Set();
    targetStrikes.add(openStrike);
    targetStrikes.add(openStrike - config.strikeStep);
    targetStrikes.add(openStrike + config.strikeStep);

    candles.forEach(c => {
      const time = c.timestamp.substring(11, 16);
      if (candidateTimes.includes(time)) {
        const atm = Math.round(c.open / config.strikeStep) * config.strikeStep;
        targetStrikes.add(atm);
        targetStrikes.add(atm - config.strikeStep);
        targetStrikes.add(atm + config.strikeStep);
      }
    });

    const strikeRange = Array.from(targetStrikes).sort((a, b) => a - b);
    console.log(`  Spot open: ${openPrice.toFixed(1)} | Expiry: ${expiryDate} | Strikes: ${strikeRange.join(', ')}`);

    const optionsDataMaps = {};
    let successCount = 0;

    for (const strike of strikeRange) {
      const keys = await getExpiredOptionKeys(expiryDate, strike);
      if (keys.ceKey && keys.peKey) {
        console.log(`  Fetching candles for ${strike} CE/PE...`);
        const ceMap = await fetchExpiredOptionCandles(keys.ceKey, dateStr);
        const peMap = await fetchExpiredOptionCandles(keys.peKey, dateStr);

        if (ceMap.size > 0 && peMap.size > 0) {
          optionsDataMaps[strike] = { ceMap, peMap };
          successCount++;
        }
      }
    }

    if (successCount > 0) {
      console.log(`  Successfully fetched real options for ${successCount}/${strikeRange.length} strikes. Merging...`);
      
      // Update options block in each candle
      candles.forEach(candle => {
        if (!candle.options) candle.options = {};
        
        strikeRange.forEach(strike => {
          const maps = optionsDataMaps[strike];
          if (maps) {
            const ceVal = maps.ceMap.get(candle.timestamp);
            const peVal = maps.peMap.get(candle.timestamp);

            if (ceVal && peVal) {
              candle.options[strike] = {
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
            }
          }
        });

        // Update ATM callClose and putClose
        const atmOpts = candle.options[openStrike];
        if (atmOpts) {
          candle.callClose = atmOpts.CE.close;
          candle.putClose = atmOpts.PE.close;
        }
      });

      // Write this file back to disk immediately
      const filePath = path.join(config.dataDir, file);
      const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      // Replace the patched candles back in the file data array
      const candlesMap = new Map(candles.map(c => [c.timestamp, c]));
      const updatedFileData = fileData.map(c => candlesMap.has(c.timestamp) ? candlesMap.get(c.timestamp) : c);

      fs.writeFileSync(filePath, JSON.stringify(updatedFileData, null, 2));
      console.log(`  [Saved] Patched candles written back to ${file}`);
    } else {
      console.log(`  [Warning] No real options fetched for any strike on ${dateStr}. Skipping merge.`);
    }
  }

  console.log('\n===================================================');
  console.log('  PATCHING COMPLETED!');
  console.log('===================================================');
}

run().catch(err => {
  console.error('Fatal patch error:', err);
});
