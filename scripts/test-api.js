const axios = require('axios');

const ACCESS_TOKEN = 'eyJ0eXAiOiJKV1QiLCJrZXlfaWQiOiJza192MS4wIiwiYWxnIjoiSFMyNTYifQ.eyJzdWIiOiIzOUM0QlEiLCJqdGkiOiI2YTI0MDA0YjA4MjAxMjE2ZjdmMDIyZTAiLCJpc011bHRpQ2xpZW50IjpmYWxzZSwiaXNQbHVzUGxhbiI6dHJ1ZSwiaWF0IjoxNzgwNzQ0MjY3LCJpc3MiOiJ1ZGFwaS1nYXRld2F5LXNlcnZpY2UiLCJleHAiOjE3ODA3ODMyMDB9.EEoHYAqBWlU_5sPeOWfV3H0j4y7eSwmrFf5ydedux5k';

async function testSpotCandles() {
  const instrumentKey = 'NSE_INDEX|Nifty 50';
  const fromStr = '2026-02-04';
  const toStr = '2026-03-05';
  const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(instrumentKey)}/minutes/1/${toStr}/${fromStr}`;
  try {
    console.log(`Querying Spot: ${url}`);
    const res = await axios.get(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${ACCESS_TOKEN}`
      }
    });
    console.log('Spot SUCCESS!', res.status);
  } catch (err) {
    console.error('Spot ERROR!');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(err.message);
    }
  }
}

testSpotCandles();
