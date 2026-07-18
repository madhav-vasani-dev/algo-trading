/**
 * fetch-nifty-all.js
 * 
 * Comprehensive 1-minute historical data fetcher for Nifty 50:
 * - Spot Data
 * - Futures Data (near-month futures)
 * - Weekly Options Data (Weekly expiries matching exact trading day)
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

const OUT_DIR = path.join(__dirname, '..', 'public', 'data', 'nifty_1min');
const CHECKPOINT_DIR = path.join(__dirname, '..', 'public', 'data', '_checkpoint');
const CHECKPOINT_FILE = path.join(CHECKPOINT_DIR, 'fetch_all_progress.json');

const STRIKE_STEP = 50;
const STRIKE_RANGE = 800; // ATM +/- 800
const INDEX_KEY = 'NSE_INDEX|Nifty 50';
const INDEX_KEY_ENC = encodeURIComponent(INDEX_KEY);

if (!ACCESS_TOKEN) {
  console.error('ERROR: Upstox Access Token is required.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function apiRequest(urlStr) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'User-Agent': 'Mozilla/5.0'
      }
    };
    https.get(urlStr, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

async function run() {
  console.log('===================================================');
  console.log('  Nifty 50 Weekly Options & Spot Data Fetcher');
  console.log('===================================================\n');

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  // 1. Fetch Expired Expiries List
  console.log('Fetching expired expiries list from Upstox...');
  const expUrl = `https://api.upstox.com/v2/expired-instruments/expiries?instrument_key=${INDEX_KEY_ENC}`;
  const expRes = await apiRequest(expUrl);
  if (!expRes || !Array.isArray(expRes.data) || expRes.data.length === 0) {
    console.error('Failed to fetch expiries list.');
    process.exit(1);
  }

  const allExpiries = expRes.data.sort();
  console.log(`Loaded ${allExpiries.length} total option expiries (Weekly & Monthly).\n`);

  // Helper: find closest weekly expiry for a date
  function getWeeklyExpiry(dateStr) {
    for (let i = 0; i < allExpiries.length; i++) {
      if (allExpiries[i] >= dateStr) return allExpiries[i];
    }
    return dateStr;
  }

  // Group trading dates by month
  // We will process month by month
  const monthsToProcess = [];
  let d = new Date(START_DATE_STR);
  const end = new Date(END_DATE_STR);

  while (d <= end) {
    const yyyyMm = formatDate(d).slice(0, 7);
    if (!monthsToProcess.includes(yyyyMm)) {
      monthsToProcess.push(yyyyMm);
    }
    d.setDate(d.getDate() + 1);
  }

  console.log(`Target Months: ${monthsToProcess.join(', ')}\n`);

  for (const monthStr of monthsToProcess) {
    console.log(`\n===================================================`);
    console.log(`Processing Month ${monthStr}...`);
    console.log(`===================================================`);

    const year = parseInt(monthStr.split('-')[0], 10);
    const mon = parseInt(monthStr.split('-')[1], 10);
    const lastDay = new Date(year, mon, 0).getDate();
    const fromDate = `${monthStr}-01`;
    const toDate = `${monthStr}-${lastDay.toString().padStart(2, '0')}`;

    // Fetch Spot candles for month
    console.log(`[Spot] Fetching Spot candles for ${fromDate} to ${toDate}...`);
    const spotUrl = `https://api.upstox.com/v3/historical-candle/${INDEX_KEY_ENC}/minutes/1/${toDate}/${fromDate}`;
    const spotRes = await apiRequest(spotUrl);

    if (!spotRes || !spotRes.data || !spotRes.data.candles || spotRes.data.candles.length === 0) {
      console.log(`[Spot] No spot candles for ${monthStr}. Skipping.`);
      continue;
    }

    const rawSpotCandles = spotRes.data.candles.reverse();
    console.log(`[Spot] Loaded ${rawSpotCandles.length} spot candles.`);

    // Group spot candles by trading day
    const dayMap = {};
    rawSpotCandles.forEach(r => {
      const ts = r[0];
      const dateStr = ts.split('T')[0];
      if (!dayMap[dateStr]) dayMap[dateStr] = [];
      dayMap[dateStr].push(r);
    });

    const tradingDays = Object.keys(dayMap).sort();
    console.log(`Found ${tradingDays.length} trading days in ${monthStr}.`);

    const monthMergedCandles = [];

    for (const dateStr of tradingDays) {
      const daySpotRows = dayMap[dateStr];
      const weeklyExp = getWeeklyExpiry(dateStr);
      console.log(`  Day ${dateStr} -> Weekly Expiry: ${weeklyExp}`);

      // Fetch weekly option contracts
      await sleep(150);
      const contractUrl = `https://api.upstox.com/v2/expired-instruments/option/contract?instrument_key=${INDEX_KEY_ENC}&expiry_date=${weeklyExp}`;
      const contractRes = await apiRequest(contractUrl);

      const contracts = (contractRes && Array.isArray(contractRes.data)) ? contractRes.data : [];

      // Determine median spot for ATM range
      const sampleClose = parseFloat(daySpotRows[Math.floor(daySpotRows.length / 2)][4]);
      const centerAtm = Math.round(sampleClose / 50) * 50;

      const strikesToFetch = [];
      for (let s = centerAtm - STRIKE_RANGE; s <= centerAtm + STRIKE_RANGE; s += STRIKE_STEP) {
        strikesToFetch.push(s);
      }

      // Map contracts by strike and type
      const optKeyMap = {};
      contracts.forEach(c => {
        const strike = c.strike_price || c.strike;
        const type = c.option_type || c.instrument_type;
        if (!optKeyMap[strike]) optKeyMap[strike] = {};
        optKeyMap[strike][type] = c.instrument_key;
      });

      const dayOptionsMap = {};

      for (const strike of strikesToFetch) {
        if (optKeyMap[strike]) {
          for (const type of ['CE', 'PE']) {
            const key = optKeyMap[strike][type];
            if (key) {
              await sleep(100);
              const candleUrl = `https://api.upstox.com/v2/expired-instruments/historical-candle/${encodeURIComponent(key)}/1minute/${dateStr}/${dateStr}`;
              const candleRes = await apiRequest(candleUrl);

              if (candleRes && candleRes.data && candleRes.data.candles) {
                candleRes.data.candles.forEach(r => {
                  const ts = r[0];
                  if (!dayOptionsMap[ts]) dayOptionsMap[ts] = {};
                  if (!dayOptionsMap[ts][strike]) dayOptionsMap[ts][strike] = {};
                  dayOptionsMap[ts][strike][type] = {
                    open: parseFloat(r[1]),
                    high: parseFloat(r[2]),
                    low: parseFloat(r[3]),
                    close: parseFloat(r[4]),
                    volume: parseInt(r[5], 10)
                  };
                });
              }
            }
          }
        }
      }

      // Merge day spot + weekly options
      daySpotRows.forEach(row => {
        const ts = row[0];
        const close = parseFloat(row[4]);
        const atm = Math.round(close / 50) * 50;
        const optAtTs = dayOptionsMap[ts] || {};
        const atmOpt = optAtTs[atm] || {};

        monthMergedCandles.push({
          timestamp: ts,
          open: parseFloat(row[1]),
          high: parseFloat(row[2]),
          low: parseFloat(row[3]),
          close: close,
          volume: parseInt(row[5], 10),
          atmStrike: atm,
          callClose: atmOpt.CE ? atmOpt.CE.close : 0,
          putClose: atmOpt.PE ? atmOpt.PE.close : 0,
          options: optAtTs
        });
      });
    }

    const monthFile = path.join(OUT_DIR, `${monthStr}.json`);
    fs.writeFileSync(monthFile, JSON.stringify(monthMergedCandles));
    console.log(`✅ Wrote ${monthStr}.json (${monthMergedCandles.length} candles with Weekly Options!).`);
  }

  console.log('\n===================================================');
  console.log('  WEEKLY OPTIONS FETCH COMPLETED!');
  console.log('===================================================');
}

run();
