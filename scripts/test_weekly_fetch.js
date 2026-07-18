const fs = require('fs');
const path = require('path');
const https = require('https');

const tokenFilePath = path.join(__dirname, '..', 'access_token.txt');
const ACCESS_TOKEN = fs.readFileSync(tokenFilePath, 'utf8').trim();

function httpsGet(urlStr) {
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
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  const indexKey = 'NSE_INDEX|Nifty 50';
  const indexEnc = encodeURIComponent(indexKey);
  const targetDate = '2025-05-02';
  const weeklyExp = '2025-05-08';

  const contractUrl = `https://api.upstox.com/v2/expired-instruments/option/contract?instrument_key=${indexEnc}&expiry_date=${weeklyExp}`;
  const contractsRes = await httpsGet(contractUrl);

  if (contractsRes && Array.isArray(contractsRes.data)) {
    const contracts = contractsRes.data;
    console.log('Sample contract object:');
    console.log(contracts[0]);

    const ce24450 = contracts.find(c => (c.strike_price === 24450 || c.strike === 24450) && (c.option_type === 'CE' || c.instrument_type === 'CE'));
    const pe24450 = contracts.find(c => (c.strike_price === 24450 || c.strike === 24450) && (c.option_type === 'PE' || c.instrument_type === 'PE'));

    console.log('Found CE 24450:', ce24450 ? ce24450.instrument_key : 'No');
    console.log('Found PE 24450:', pe24450 ? pe24450.instrument_key : 'No');

    if (ce24450 && pe24450) {
      const ceCandleUrl = `https://api.upstox.com/v2/expired-instruments/historical-candle/${encodeURIComponent(ce24450.instrument_key)}/1minute/${targetDate}/${targetDate}`;
      const peCandleUrl = `https://api.upstox.com/v2/expired-instruments/historical-candle/${encodeURIComponent(pe24450.instrument_key)}/1minute/${targetDate}/${targetDate}`;

      const ceCandlesRes = await httpsGet(ceCandleUrl);
      const peCandlesRes = await httpsGet(peCandleUrl);

      if (ceCandlesRes && ceCandlesRes.data && ceCandlesRes.data.candles) {
        const ce1100 = ceCandlesRes.data.candles.find(c => c[0].includes('11:00'));
        console.log(`\n🎉 Weekly 24450 CE 11:00 AM Open: ${ce1100 ? ce1100[1] : 'N/A'} (User CSV: 185.15)`);
      }

      if (peCandlesRes && peCandlesRes.data && peCandlesRes.data.candles) {
        const pe1100 = peCandlesRes.data.candles.find(c => c[0].includes('11:00'));
        console.log(`🎉 Weekly 24450 PE 11:00 AM Open: ${pe1100 ? pe1100[1] : 'N/A'} (User CSV: 181.00)`);
      }
    }
  }
}

run();
