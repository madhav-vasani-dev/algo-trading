/**
 * merge_nifty_data.js
 * 
 * Memory-efficient, Month-by-Month merger for Spot, Futures, and Options data.
 * Merges option files from public/data/_checkpoint/ into public/data/nifty_1min/YYYY-MM.json.
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'data', 'nifty_1min');
const CHECKPOINT_DIR = path.join(__dirname, '..', 'public', 'data', '_checkpoint');
const CHECKPOINT_FILE = path.join(CHECKPOINT_DIR, 'fetch_all_progress.json');
const META_FILE = path.join(CHECKPOINT_DIR, 'progress_meta.json');

const START_DATE_STR = '2024-09-27';
const END_DATE_STR = '2026-06-30';
const STRIKE_STEP = 50;
const STRIKE_RANGE = 800;

function loadSpotCandles() {
  console.log('[Spot] Loading spot candles...');
  let spotCandles = [];
  if (fs.existsSync(OUT_DIR)) {
    const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json')).sort();
    files.forEach(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
        data.forEach(c => {
          const dateStr = c.timestamp.split('T')[0];
          if (dateStr >= START_DATE_STR && dateStr <= END_DATE_STR) {
            spotCandles.push({
              timestamp: c.timestamp,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume
            });
          }
        });
      } catch (e) {}
    });
  }

  const map = new Map();
  spotCandles.forEach(c => map.set(c.timestamp, c));
  spotCandles = Array.from(map.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  console.log(`[Spot] Total spot candles loaded: ${spotCandles.length}`);
  return spotCandles;
}

function loadFuturesData() {
  console.log('[Futures] Loading futures data...');
  let futuresData = {};
  if (fs.existsSync(META_FILE)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      if (meta.futuresData) futuresData = meta.futuresData;
    } catch (e) {}
  }
  if (Object.keys(futuresData).length === 0 && fs.existsSync(CHECKPOINT_FILE)) {
    try {
      const check = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
      if (check.futuresData) futuresData = check.futuresData;
    } catch (e) {}
  }
  console.log(`[Futures] Total futures candles loaded: ${Object.keys(futuresData).length}`);
  return futuresData;
}

function run() {
  console.log('===================================================');
  console.log('  Merging Nifty Spot, Futures, and Options Data');
  console.log('  (Month-by-Month Memory Efficient)');
  console.log('===================================================\n');

  const spotCandles = loadSpotCandles();
  const futuresData = loadFuturesData();

  // Find all checkpoint option files
  const optionFiles = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.startsWith('options_') && f.endsWith('.json')).sort();
  const optionExpiries = optionFiles.map(f => f.replace('options_', '').replace('.json', ''));
  console.log(`Found ${optionFiles.length} option checkpoint files.\n`);

  function findClosestExpiry(dateStr) {
    for (let i = 0; i < optionExpiries.length; i++) {
      if (optionExpiries[i] >= dateStr) return optionExpiries[i];
    }
    return dateStr;
  }

  // Group spot candles by calendar month YYYY-MM
  const monthMap = {};
  spotCandles.forEach(c => {
    const monthStr = c.timestamp.slice(0, 7);
    if (!monthMap[monthStr]) monthMap[monthStr] = [];
    monthMap[monthStr].push(c);
  });

  const months = Object.keys(monthMap).sort();
  console.log(`Processing ${months.length} calendar months...\n`);

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  let totalMergedCandles = 0;

  months.forEach((monthStr, mIdx) => {
    const monthCandles = monthMap[monthStr];
    console.log(`[Month ${mIdx + 1}/${months.length}] Merging ${monthStr} (${monthCandles.length} spot candles)...`);

    // Group month's candles by trading day
    const daysInMonth = {};
    monthCandles.forEach(c => {
      const d = c.timestamp.split('T')[0];
      if (!daysInMonth[d]) daysInMonth[d] = [];
      daysInMonth[d].push(c);
    });

    // Determine which option expiries are needed for this month
    const neededExpiries = new Set();
    Object.keys(daysInMonth).forEach(d => {
      neededExpiries.add(findClosestExpiry(d));
    });

    // Load ONLY the option files needed for this month
    const monthOptionData = {};
    neededExpiries.forEach(exp => {
      const file = path.join(CHECKPOINT_DIR, `options_${exp}.json`);
      if (fs.existsSync(file)) {
        try {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          Object.keys(data).forEach(ts => {
            monthOptionData[ts] = data[ts];
          });
        } catch (e) {}
      }
    });

    const mergedMonthData = [];
    const tradingDays = Object.keys(daysInMonth).sort();

    tradingDays.forEach(dateStr => {
      const dayCandles = daysInMonth[dateStr];
      dayCandles.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      const openPrice = dayCandles[0].open;
      const atmStrike = Math.round(openPrice / STRIKE_STEP) * STRIKE_STEP;

      const strikeRange = [];
      for (let off = -STRIKE_RANGE; off <= STRIKE_RANGE; off += STRIKE_STEP) {
        strikeRange.push(atmStrike + off);
      }

      dayCandles.forEach(candle => {
        const optionsObj = {};

        strikeRange.forEach(strike => {
          let ceVal = null;
          let peVal = null;

          if (monthOptionData[candle.timestamp] && monthOptionData[candle.timestamp][strike]) {
            const opt = monthOptionData[candle.timestamp][strike];
            if (opt.CE) ceVal = opt.CE;
            if (opt.PE) peVal = opt.PE;
          }

          if (!ceVal) {
            ceVal = {
              open: Math.max(0, candle.open - strike),
              high: Math.max(0, candle.high - strike),
              low: Math.max(0, candle.low - strike),
              close: Math.max(0, candle.close - strike),
              volume: 0
            };
          }

          if (!peVal) {
            peVal = {
              open: Math.max(0, strike - candle.open),
              high: Math.max(0, strike - candle.low),
              low: Math.max(0, strike - candle.high),
              close: Math.max(0, strike - candle.close),
              volume: 0
            };
          }

          optionsObj[strike] = {
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
        });

        const atmOptions = optionsObj[atmStrike];
        const callClose = atmOptions ? atmOptions.CE.close : Math.max(0, candle.close - atmStrike);
        const putClose = atmOptions ? atmOptions.PE.close : Math.max(0, atmStrike - candle.close);

        const futVal = futuresData[candle.timestamp];
        const futureObj = futVal ? {
          open: parseFloat(futVal.open.toFixed(2)),
          high: parseFloat(futVal.high.toFixed(2)),
          low: parseFloat(futVal.low.toFixed(2)),
          close: parseFloat(futVal.close.toFixed(2)),
          volume: futVal.volume,
          openInterest: futVal.openInterest || 0
        } : {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          openInterest: 0
        };

        mergedMonthData.push({
          timestamp: candle.timestamp,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          atmStrike: atmStrike,
          callClose: parseFloat(callClose.toFixed(2)),
          putClose: parseFloat(putClose.toFixed(2)),
          future: futureObj,
          options: optionsObj
        });
      });
    });

    const outFile = path.join(OUT_DIR, `${monthStr}.json`);
    fs.writeFileSync(outFile, JSON.stringify(mergedMonthData));
    const sizeMB = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
    console.log(`  Saved ${monthStr}.json: ${mergedMonthData.length} candles (${sizeMB} MB)`);
    totalMergedCandles += mergedMonthData.length;
  });

  // Cleanup checkpoint dir
  console.log('\nCleaning up checkpoint files...');
  try {
    const files = fs.readdirSync(CHECKPOINT_DIR);
    files.forEach(f => fs.unlinkSync(path.join(CHECKPOINT_DIR, f)));
    fs.rmdirSync(CHECKPOINT_DIR);
    console.log('Checkpoint directory cleaned up successfully!');
  } catch (e) {
    console.warn('Could not cleanup checkpoint dir:', e.message);
  }

  console.log('\n===================================================');
  console.log('  MERGE COMPLETED SUCCESSFULLY!');
  console.log(`  Total Candles Merged: ${totalMergedCandles}`);
  console.log('===================================================');
}

run();
