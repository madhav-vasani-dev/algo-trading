/**
 * split_nifty_by_day.js
 * 
 * Splits monthly files under public/data/nifty_1min/ AND public/data/banknifty_1min/
 * into lightweight daily files:
 * public/data/<dataset>/<YYYY-MM>/<YYYY-MM-DD>.json (~1.5 MB per day)
 * and generates fast index.json files for both datasets (~30-100 KB).
 */

const fs = require('fs');
const path = require('path');

const DATA_BASE = path.join(__dirname, '..', 'public', 'data');
const DATASETS = ['nifty_1min', 'banknifty_1min'];

function processDataset(folderName) {
  const dataDir = path.join(DATA_BASE, folderName);
  console.log(`\n===================================================`);
  console.log(`  Processing Dataset: ${folderName}`);
  console.log(`===================================================\n`);

  if (!fs.existsSync(dataDir)) {
    console.warn(`Data directory does not exist: ${dataDir}. Skipping.`);
    return;
  }

  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json') && f !== 'index.json').sort();
  if (files.length === 0) {
    console.log(`No monthly JSON files found in ${folderName} (already split or empty).`);
    return;
  }

  console.log(`Found ${files.length} monthly JSON files in ${folderName}.\n`);

  let index = {
    months: [],
    daysByMonth: {},
    summaryByDay: {}
  };

  const existingIndexFile = path.join(dataDir, 'index.json');
  if (fs.existsSync(existingIndexFile)) {
    try {
      index = JSON.parse(fs.readFileSync(existingIndexFile, 'utf8'));
    } catch (e) {}
  }

  let totalDailyFiles = 0;

  files.forEach((f, idx) => {
    const monthStr = f.replace('.json', ''); // e.g. "2024-10"
    const filePath = path.join(dataDir, f);
    
    console.log(`[${idx + 1}/${files.length}] Processing ${f}...`);
    let monthCandles = [];
    try {
      monthCandles = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`  Error reading ${f}: ${e.message}`);
      return;
    }

    const dayMap = {};
    monthCandles.forEach(c => {
      const dateStr = c.timestamp.split('T')[0];
      if (!dayMap[dateStr]) dayMap[dateStr] = [];
      dayMap[dateStr].push(c);
    });

    const monthDir = path.join(dataDir, monthStr);
    if (!fs.existsSync(monthDir)) {
      fs.mkdirSync(monthDir, { recursive: true });
    }

    const tradingDays = Object.keys(dayMap).sort();
    if (!index.months.includes(monthStr)) {
      index.months.push(monthStr);
    }
    index.months.sort();
    index.daysByMonth[monthStr] = tradingDays;

    tradingDays.forEach(dayStr => {
      const dayCandles = dayMap[dayStr];
      const dayFile = path.join(monthDir, `${dayStr}.json`);
      fs.writeFileSync(dayFile, JSON.stringify(dayCandles));
      totalDailyFiles++;

      const first = dayCandles[0];
      const last = dayCandles[dayCandles.length - 1];
      let maxHigh = first.high;
      let minLow = first.low;
      let totVol = 0;
      let maxOi = 0;

      dayCandles.forEach(c => {
        if (c.high > maxHigh) maxHigh = c.high;
        if (c.low < minLow) minLow = c.low;
        totVol += c.volume || 0;
        if (c.future && c.future.openInterest > maxOi) maxOi = c.future.openInterest;
      });

      index.summaryByDay[dayStr] = {
        open: first.open,
        high: maxHigh,
        low: minLow,
        close: last.close,
        volume: totVol,
        atmStrike: last.atmStrike || Math.round(last.close / 100) * 100,
        callClose: last.callClose || 0,
        putClose: last.putClose || 0,
        futClose: last.future ? last.future.close : last.close,
        maxOI: maxOi
      };
    });

    // Remove original monolithic file to free space
    fs.unlinkSync(filePath);
    console.log(`  Split into ${tradingDays.length} daily files under /${monthStr}/`);
  });

  const indexFile = path.join(dataDir, 'index.json');
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  console.log(`\nWrote ${folderName}/index.json (${(fs.statSync(indexFile).size / 1024).toFixed(1)} KB)`);
  console.log(`Total Daily Files Created for ${folderName}: ${totalDailyFiles}`);
}

function run() {
  DATASETS.forEach(processDataset);
  console.log('\n===================================================');
  console.log('  ALL DATASETS PROCESSED SUCCESSFULLY!');
  console.log('===================================================');
}

run();
