const fs = require('fs');
const path = require('path');
const axios = require('axios');

const tokenFilePath = path.join(__dirname, '..', 'access_token.txt');
const ACCESS_TOKEN = fs.readFileSync(tokenFilePath, 'utf8').trim();

const url = `https://api.upstox.com/v2/option/contract?instrument_key=NSE_INDEX%7CNifty%20Bank`;

axios.get(url, {
  headers: {
    'Accept': 'application/json',
    'Authorization': `Bearer ${ACCESS_TOKEN}`
  }
}).then(res => {
  console.log('BANKNIFTY Active Contracts:');
  console.log('Sample active contract:', res.data.data[0]);
  const expiries = [...new Set(res.data.data.map(c => c.expiry))].sort();
  console.log('Unique active expiry dates:', expiries);
}).catch(err => {
  console.error('Failed:', err.message);
});
