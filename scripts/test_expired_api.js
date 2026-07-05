const axios = require('axios');

const ACCESS_TOKEN = 'eyJ0eXAiOiJKV1QiLCJrZXlfaWQiOiJza192MS4wIiwiYWxnIjoiSFMyNTYifQ.eyJzdWIiOiIzOUM0QlEiLCJqdGkiOiI2YTM3YTc3ZTM1MTRiNTQ0YjU5OGNkZDEiLCJpc011bHRpQ2xpZW50IjpmYWxzZSwiaXNQbHVzUGxhbiI6dHJ1ZSwiaWF0IjoxNzgyMDMyMjU0LCJpc3MiOiJ1ZGFwaS1nYXRld2F5LXNlcnZpY2UiLCJleHAiOjE3ODIwNzkyMDB9.UD_FSfrmnvSU-_q5TgIYsrfSemdX5nGvvmLPrj6RT5s';

async function runTest() {
  try {
    const candleUrl = `https://api.upstox.com/v2/expired-instruments/historical-candle/NSE_FO%7C38529%7C27-11-2024/1minute/2024-11-14/2024-11-14`;
    console.log(`Fetching historical candles for NSE_FO|38529|27-11-2024...`);
    const candleRes = await axios.get(candleUrl, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${ACCESS_TOKEN}`
      }
    });
    console.log('Success! Data fetched:', candleRes.data.status);
    if (candleRes.data.data && candleRes.data.data.candles) {
      console.log('Candles count:', candleRes.data.data.candles.length);
      console.log('Sample candle:', candleRes.data.data.candles[0]);
    } else {
      console.log('No candles data:', candleRes.data);
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

runTest();
