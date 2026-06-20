const fs = require('fs');
const path = require('path');

const pyTrades = JSON.parse(fs.readFileSync(path.join(__dirname, 'python_trades.json'), 'utf8'));
const tsTrades = JSON.parse(fs.readFileSync(path.join(__dirname, 'ts_trades.json'), 'utf8'));

console.log(`Loaded ${pyTrades.length} Python trades and ${tsTrades.length} TS trades.`);

const pyMap = new Map(pyTrades.map(t => [t.Date, t]));
const tsMap = new Map(tsTrades.map(t => [t.Date, t]));

console.log("\n--- Missing Trades ---");
for (const py of pyTrades) {
  if (!tsMap.has(py.Date)) {
    console.log(`Date in Python but missing in TS: ${py.Date} (${py.Type} at ${py.EntryTime})`);
  }
}
for (const ts of tsTrades) {
  if (!pyMap.has(ts.Date)) {
    console.log(`Date in TS but missing in Python: ${ts.Date} (${ts.Type} at ${ts.EntryTime})`);
  }
}

console.log("\n--- Discrepancies ---");
let matchedCount = 0;
let discrepancyCount = 0;

for (const py of pyTrades) {
  const ts = tsMap.get(py.Date);
  if (!ts) continue;

  let hasDiscrepancy = false;
  const reasons = [];

  // Check Entry Time (tolerate 1-2 min difference or format differences)
  if (py.EntryTime.substring(0, 5) !== ts.EntryTime.substring(0, 5)) {
    hasDiscrepancy = true;
    reasons.push(`Entry Time: Py=${py.EntryTime}, TS=${ts.EntryTime}`);
  }

  // Check Entry Price
  if (Math.abs(py.EntryPrice - ts.EntryPrice) > 0.01) {
    hasDiscrepancy = true;
    reasons.push(`Entry Price: Py=${py.EntryPrice}, TS=${ts.EntryPrice}`);
  }

  // Check Exit Time
  if (!py.ExitTime || !ts.ExitTime || py.ExitTime.substring(0, 5) !== ts.ExitTime.substring(0, 5)) {
    hasDiscrepancy = true;
    reasons.push(`Exit Time: Py=${py.ExitTime}, TS=${ts.ExitTime}`);
  }

  // Check Exit Price
  if (Math.abs(py.ExitPrice - ts.ExitPrice) > 0.01) {
    hasDiscrepancy = true;
    reasons.push(`Exit Price: Py=${py.ExitPrice}, TS=${ts.ExitPrice}`);
  }

  // Check PnL
  if (Math.abs(py.PnL - ts.PnL) > 0.01) {
    hasDiscrepancy = true;
    reasons.push(`PnL: Py=${py.PnL.toFixed(2)}, TS=${ts.PnL.toFixed(2)}`);
  }

  if (hasDiscrepancy) {
    discrepancyCount++;
    console.log(`Discrepancy on ${py.Date}:`);
    for (const r of reasons) {
      console.log(`  - ${r}`);
    }
  } else {
    matchedCount++;
  }
}

console.log(`\nMatched Trades: ${matchedCount}`);
console.log(`Discrepant Trades: ${discrepancyCount}`);
