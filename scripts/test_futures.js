const axios = require('axios');

const ACCESS_TOKEN = 'eyJ0eXAiOiJKV1QiLCJrZXlfaWQiOiJza192MS4wIiwiYWxnIjoiSFMyNTYifQ.eyJzdWIiOiIzOUM0QlEiLCJqdGkiOiI2YTQ4ZTBjYTBmNmFmNTdkNDY1ZmE4MzAiLCJpc011bHRpQ2xpZW50IjpmYWxzZSwiaXNQbHVzUGxhbiI6dHJ1ZSwiaWF0IjoxNzgzMTYxMDM0LCJpc3MiOiJ1ZGFwaS1nYXRld2F5LXNlcnZpY2UiLCJleHAiOjE3ODMyMDI0MDB9.EKkhmWI0CUve4yrd4aToT-75RIBzFdYLI1nFl83741I';

async function run() {
  try {
    const futKey = 'NSE_FO|61093'; // July 2026 Future
    console.log(`Fetching active future candles for ${futKey} on 2026-07-03...`);
    const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(futKey)}/minutes/1/2026-07-03/2026-07-03`;
    const res = await axios.get(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${ACCESS_TOKEN}`
      }
    });
    console.log('Candles Success! Status:', res.data.status);
    if (res.data.data && res.data.data.candles) {
      console.log('Candle count:', res.data.data.candles.length);
      console.log('Sample candle:', res.data.data.candles[0]);
    }
  } catch (err) {
    console.error('Error occurred:');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(err.message);
    }
  }
}

run();
