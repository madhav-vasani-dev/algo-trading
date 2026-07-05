const axios = require('axios');

const ACCESS_TOKEN = 'eyJ0eXAiOiJKV1QiLCJrZXlfaWQiOiJza192MS4wIiwiYWxnIjoiSFMyNTYifQ.eyJzdWIiOiIzOUM0QlEiLCJqdGkiOiI2YTM2ODc4MjI0ZWI2YzMyMTEyNWJlYTAiLCJpc011bHRpQ2xpZW50IjpmYWxzZSwiaXNQbHVzUGxhbiI6dHJ1ZSwiaWF0IjoxNzgxOTU4NTMwLCJpc3MiOiJ1ZGFwaS1nYXRld2F5LXNlcnZpY2UiLCJleHAiOjE3ODE5OTI4MDB9.ZVkct1kUdnbKNaI_d-TV93kOkDu4CWdDem_Fke0JyAw';

async function runTest() {
  try {
    // 1. Get contracts for 2024-10-03 expiry
    const expiryDate = '2024-10-03';
    const contractUrl = `https://api.upstox.com/v2/expired-instruments/option/contract?instrument_key=NSE_INDEX%7CNifty%2050&expiry_date=${expiryDate}`;
    console.log(`Fetching contracts for expiry ${expiryDate}...`);
    const contractRes = await axios.get(contractUrl, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${ACCESS_TOKEN}`
      }
    });
    
    console.log(`Contracts fetched. Total: ${contractRes.data.data.length}`);
    console.log('Contract Headers:', contractRes.headers);

    // Let's find one CE contract
    const contracts = contractRes.data.data;
    const ceContract = contracts.find(c => parseFloat(c.strike_price) === 26250 && c.instrument_type === 'CE');
    if (!ceContract) {
      console.log('No contract found for 26250 CE!');
      return;
    }

    console.log(`Found contract: ${ceContract.instrument_key}`);

    // 2. Fetch historical candle for this contract on 2024-09-27
    const dateStr = '2024-09-27';
    const candleUrl = `https://api.upstox.com/v2/expired-instruments/historical-candle/${encodeURIComponent(ceContract.instrument_key)}/1minute/${dateStr}/${dateStr}`;
    console.log(`Fetching historical candles for ${ceContract.instrument_key} on ${dateStr}...`);
    
    const candleRes = await axios.get(candleUrl, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${ACCESS_TOKEN}`
      }
    });

    console.log(`Candles fetched. Total: ${candleRes.data.data ? candleRes.data.data.candles.length : 'no candles'}`);
    console.log('Candle Headers:', candleRes.headers);

  } catch (err) {
    console.error('Error occurred:');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Headers:', err.response.headers);
      console.error('Data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(err.message);
    }
  }
}

runTest();

