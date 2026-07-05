/**
 * patch_banknifty_futures.js
 * 
 * Fetches official 1-minute BankNifty Futures OHLC, Volume, and Open Interest
 * from Upstox API for all months (2024-11 through 2026-06)
 * and attaches `future` data to every daily file in public/data/banknifty_1min/
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const tokenFilePath = path.join(__dirname, '..', 'access_token.txt');
const ACCESS_TOKEN = fs.readFileSync(tokenFilePath, 'utf8').trim();

const BANKNIFTY_DIR = path.join(__dirname, '..', 'public', 'data', 'banknifty_1min');
const INDEX_KEY = 'NSE_INDEX|Nifty Bank';
const INDEX_KEY_ENC = encodeURIComponent(INDEX_KEY);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${ACCESS_TOKEN}`
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
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function fetchExpiredExpiries() {
  const url = `https://api.upstox.com/v2/expired-instruments/expiries?instrument_key=${INDEX_KEY_ENC}`;
  const res = await httpsGet(url);
  if (res && res.status === 'success' && Array.isArray(res.data)) {
    return res.data.sort();
  }
  return [];
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
  const res = await httpsGet(url);
  if (res && res.status === 'success' && Array.isArray(res.data) && res.data.length > 0) {
    return res.data[0].instrument_key;
  }
  return null;
}

async function fetchFutureCandles(futKey, fromDate, toDate) {
  const url = `https://api.upstox.com/v2/expired-instruments/historical-candle/${encodeURIComponent(futKey)}/1minute/${toDate}/${fromDate}`;
  const res = await httpsGet(url);
  const map = {};
  if (res && res.status === 'success' && res.data && res.data.candles) {
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

async function run() {
  console.log('===================================================');
  console.log('  Patching Official Upstox BankNifty Futures Data');
  console.log('===================================================\n');

  if (!fs.existsSync(BANKNIFTY_DIR)) {
    console.error('BankNifty directory does not exist:', BANKNIFTY_DIR);
    return;
  }

  const expiries = await fetchExpiredExpiries();
  if (expiries.length === 0) {
    console.error('Failed to fetch BankNifty expiries from Upstox.');
    return;
  }

  const monthlyExpiries = getMonthlyFutureExpiries(expiries);
  console.log(`Found ${monthlyExpiries.length} monthly futures expiries.\n`);

  const monthFolders = fs.readdirSync(BANKNIFTY_DIR).filter(f => {
    const p = path.join(BANKNIFTY_DIR, f);
    return fs.statSync(p).isDirectory();
  }).sort();

  console.log(`Processing ${monthFolders.length} BankNifty month folders...`);

  let totalPatchedDays = 0;

  for (let i = 0; i < monthFolders.length; i++) {
    const monthStr = monthFolders[i];
    const monthDir = path.join(BANKNIFTY_DIR, monthStr);
    
    // Find closest monthly expiry on or after this month
    const matchingExpiry = monthlyExpiries.find(e => e.startsWith(monthStr)) || monthlyExpiries.find(e => e >= monthStr);
    if (!matchingExpiry) {
      console.warn(`[${monthStr}] No matching futures expiry found.`);
      continue;
    }

    console.log(`\n[${i + 1}/${monthFolders.length}] Processing ${monthStr} (Expiry: ${matchingExpiry})...`);
    
    // Fetch contract key
    await sleep(400);
    const futKey = await fetchFutureContract(matchingExpiry);
    if (!futKey) {
      console.warn(`  Could not find BankNifty Future contract key for ${matchingExpiry}`);
      continue;
    }
    console.log(`  Future Key: ${futKey}`);

    // Calculate month start and end dates
    const fromDate = `${monthStr}-01`;
    const toDate = matchingExpiry;

    await sleep(500);
    const futCandlesMap = await fetchFutureCandles(futKey, fromDate, toDate);
    const futCount = Object.keys(futCandlesMap).length;
    console.log(`  Fetched ${futCount} 1-min futures candles from Upstox.`);

    // Patch each daily file in monthDir
    const dayFiles = fs.readdirSync(monthDir).filter(f => f.endsWith('.json')).sort();
    dayFiles.forEach(df => {
      const filePath = path.join(monthDir, df);
      try {
        const candles = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let patchedCount = 0;

        candles.forEach(c => {
          if (futCandlesMap[c.timestamp]) {
            c.future = futCandlesMap[c.timestamp];
            patchedCount++;
          }
        });

        fs.writeFileSync(filePath, JSON.stringify(candles));
        totalPatchedDays++;
      } catch (e) {
        console.error(`  Error patching ${df}: ${e.message}`);
      }
    });

    console.log(`  Patched futures data across ${dayFiles.length} daily files.`);
  }

  // Update index.json summary
  const indexFile = path.join(BANKNIFTY_DIR, 'index.json');
  if (fs.existsSync(indexFile)) {
    try {
      const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      monthFolders.forEach(monthStr => {
        const monthDir = path.join(BANKNIFTY_DIR, monthStr);
        const dayFiles = fs.readdirSync(monthDir).filter(f => f.endsWith('.json')).sort();
        dayFiles.forEach(df => {
          const dayStr = df.replace('.json', '');
          const candles = JSON.parse(fs.readFileSync(path.join(monthDir, df)));
          if (candles.length > 0) {
            const last = candles[candles.length - 1];
            let maxOi = 0;
            candles.forEach(c => {
              if (c.future && c.future.openInterest > maxOi) maxOi = c.future.openInterest;
            });
            if (index.summaryByDay[dayStr]) {
              index.summaryByDay[dayStr].futClose = last.future ? last.future.close : last.close;
              index.summaryByDay[dayStr].maxOI = maxOi;
            }
          }
        });
      });
      fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
      console.log('\nUpdated banknifty_1min/index.json summary.');
    } catch (e) {}
  }

  console.log('\n===================================================');
  console.log('  BANKNIFTY FUTURES PATCH COMPLETED SUCCESSFULLY!');
  console.log(`  Total Daily Files Patched: ${totalPatchedDays}`);
  console.log('===================================================');
}

run();
