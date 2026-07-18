/**
 * inspect_spot_rounding.js
 * 
 * Inspects 11:00 AM Spot Open, High, Low, Close prices in local market dataset
 * and compares strike selection against AlgoTest CSV.
 */

const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', '11AM Selling Naked.csv');
const dataDir = path.join(__dirname, '..', 'public', 'data', 'nifty_1min');

function getAllJsonFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllJsonFiles(fullPath));
    } else if (file.endsWith('.json') && file !== 'index.json') {
      results.push(fullPath);
    }
  });
  return results.sort();
}

// 1. Parse CSV
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('\n').filter(l => l.trim().length > 0);

const csvDailyMap = {};
for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(',').map(c => c.replace(/"/g, '').trim());
  const index = cols[0];
  const date = cols[1];
  if (index.includes('.')) {
    if (!csvDailyMap[date]) csvDailyMap[date] = cols[6]; // AlgoTest Strike
  }
}

// 2. Load Local Data
const filePaths = getAllJsonFiles(dataDir);
let marketData = [];
for (const filePath of filePaths) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    marketData = marketData.concat(raw);
  } catch (err) {}
}

const daysMap = {};
marketData.forEach(c => {
  const date = c.timestamp.split('T')[0];
  if (!daysMap[date]) daysMap[date] = [];
  daysMap[date].push(c);
});

console.log('========================================================================');
console.log('  INSPECTING SPOT PRICES & STRIKE SELECTION AT 11:00 AM');
console.log('========================================================================\n');

const sampleDates = ['2024-10-04', '2025-05-15', '2025-03-06', '2026-03-16', '2025-05-02', '2025-02-13'];

sampleDates.forEach(d => {
  const candles = daysMap[d];
  const csvStrike = csvDailyMap[d];
  if (candles) {
    const c1100 = candles.find(c => c.timestamp.split('T')[1].substring(0, 5) === '11:00');
    if (c1100) {
      const openSpot = c1100.open;
      const closeSpot = c1100.close;
      const atmOpen = Math.round(openSpot / 50) * 50;
      const atmClose = Math.round(closeSpot / 50) * 50;
      const storedAtm = c1100.atmStrike;

      console.log(`Date: ${d} | AlgoTest Strike: ${csvStrike}`);
      console.log(`  11:00 Spot Open: ${openSpot} -> Rounded: ${atmOpen}`);
      console.log(`  11:00 Spot Close: ${closeSpot} -> Rounded: ${atmClose}`);
      console.log(`  Stored atmStrike: ${storedAtm}`);
      console.log(`------------------------------------------------------------------------`);
    }
  }
});
