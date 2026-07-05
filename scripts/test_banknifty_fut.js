const fs = require('fs');
const path = require('path');
const https = require('https');

const tokenFilePath = path.join(__dirname, '..', 'access_token.txt');
const ACCESS_TOKEN = fs.readFileSync(tokenFilePath, 'utf8').trim();

const INDEX_KEY = 'NSE_INDEX|Nifty Bank';
const INDEX_KEY_ENC = encodeURIComponent(INDEX_KEY);

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

async function run() {
  console.log('Testing BankNifty Monthly Futures Fetching...\n');

  const expUrl = `https://api.upstox.com/v2/expired-instruments/expiries?instrument_key=${INDEX_KEY_ENC}`;
  const expRes = await httpsGet(expUrl);
  
  if (expRes.status === 'success' && Array.isArray(expRes.data)) {
    const monthlyExpiries = getMonthlyFutureExpiries(expRes.data);
    console.log('Monthly Futures Expiries:', monthlyExpiries);

    const targetExpiry = '2024-11-27';
    console.log(`\nFetching Future Contract Key for Monthly Expiry ${targetExpiry}...`);
    const contractUrl = `https://api.upstox.com/v2/expired-instruments/future/contract?instrument_key=${INDEX_KEY_ENC}&expiry_date=${targetExpiry}`;
    const contractRes = await httpsGet(contractUrl);
    
    if (contractRes.status === 'success' && Array.isArray(contractRes.data) && contractRes.data.length > 0) {
      const futKey = contractRes.data[0].instrument_key;
      console.log(`\n✅ BankNifty Future Instrument Key for Nov 2024: ${futKey}`);

      const candlesUrl = `https://api.upstox.com/v2/expired-instruments/historical-candle/${encodeURIComponent(futKey)}/1minute/2024-11-27/2024-11-01`;
      console.log(`Fetching Futures 1-min Candles for ${futKey}...`);
      const candleRes = await httpsGet(candlesUrl);

      if (candleRes.status === 'success' && candleRes.data && candleRes.data.candles) {
        console.log(`\n🎉 SUCCESS! Fetched ${candleRes.data.candles.length} official 1-minute BankNifty Futures candles!`);
        console.log('Sample Candle [timestamp, open, high, low, close, volume, openInterest]:');
        console.log(candleRes.data.candles[0]);
      } else {
        console.error('❌ Candle fetch failed:', candleRes);
      }
    } else {
      console.error('❌ Contract fetch failed:', contractRes);
    }
  } else {
    console.error('❌ Expiries fetch failed:', expRes);
  }
}

run();
