/**
 * split_nifty_by_day.js
 * 
 * Splits monthly files under public/data/nifty_1min/, banknifty_1min/, and crudeoilm_1min/
 * into lightweight daily files:
 * public/data/<dataset>/<YYYY-MM>/<YYYY-MM-DD>.json (~1.5 MB per day)
 * and generates fast index.json files for all datasets (~30-120 KB).
 */

const fs = require('fs');
const path = require('path');

const DATA_BASE = path.join(__dirname, '..', 'public', 'data');
const DATASETS = ['nifty_1min', 'banknifty_1min', 'crudeoilm_1min'];

function processDataset(folderName) {
  const dataDir = path.join(DATA_BASE, folderName);
  console.log(`\n===================================================`);
  console.log(`  Processing Dataset: ${folderName}`);
  console.log(`===================================================\n`);

  if (!fs.existsSync(dataDir)) {
    console.warn(`Data directory does not exist: ${dataDir}. Skipping.`);
    return;
  }

  // Read index if exists
  let index = {
    months: [],
    daysByMonth: {},
    summaryByDay: {}
  };

  // Process any un-split monthly JSON files
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json') && f !== 'index.json').sort();

  files.forEach((f, idx) => {
    const monthStr = f.replace('.json', '');
    const filePath = path.join(dataDir, f);
    
    let monthCandles = [];
    try {
      monthCandles = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`  Error reading ${f}: ${e.message}`);
      return;
    }

    // Skip empty months
    if (!Array.isArray(monthCandles) || monthCandles.length === 0) {
      console.log(`Skipping empty monthly file ${f}`);
      fs.unlinkSync(filePath);
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
    if (tradingDays.length > 0) {
      tradingDays.forEach(dayStr => {
        const dayCandles = dayMap[dayStr];
        const dayFile = path.join(monthDir, `${dayStr}.json`);
        fs.writeFileSync(dayFile, JSON.stringify(dayCandles));
      });
    }

    // Remove original monthly JSON file
    fs.unlinkSync(filePath);
    console.log(`  Split ${f} into ${tradingDays.length} daily files under /${monthStr}/`);
  });

  // Re-scan all subdirectories under dataDir to build clean index.json
  const subDirs = fs.readdirSync(dataDir).filter(item => {
    const p = path.join(dataDir, item);
    return fs.statSync(p).isDirectory() && /^\d{4}-\d{2}$/.test(item);
  }).sort();

  index.months = [];
  index.daysByMonth = {};
  index.summaryByDay = {};

  subDirs.forEach(monthStr => {
    const monthDir = path.join(dataDir, monthStr);
    const dayFiles = fs.readdirSync(monthDir).filter(f => f.endsWith('.json')).sort();

    if (dayFiles.length > 0) {
      index.months.push(monthStr);
      index.daysByMonth[monthStr] = dayFiles.map(f => f.replace('.json', ''));

      dayFiles.forEach(f => {
        const dayStr = f.replace('.json', '');
        try {
          const dayCandles = JSON.parse(fs.readFileSync(path.join(monthDir, f), 'utf8'));
          if (Array.isArray(dayCandles) && dayCandles.length > 0) {
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
              atmStrike: last.atmStrike || Math.round(last.close / 50) * 50,
              callClose: last.callClose || 0,
              putClose: last.putClose || 0,
              futClose: last.future ? last.future.close : last.close,
              maxOI: maxOi
            };
          }
        } catch (e) {}
      });
    } else {
      // Remove empty month folder if no daily files
      try { fs.rmdirSync(monthDir); } catch (e) {}
    }
  });

  const indexFile = path.join(dataDir, 'index.json');
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  console.log(`Wrote ${folderName}/index.json (${(fs.statSync(indexFile).size / 1024).toFixed(1)} KB). Active Months: ${index.months.join(', ')}`);
}

function run() {
  DATASETS.forEach(processDataset);
  console.log('\n===================================================');
  console.log('  INDEX CLEANUP COMPLETED!');
  console.log('===================================================');
}

run();
