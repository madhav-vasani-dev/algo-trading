const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'public', 'data', 'nifty_1min');
if (!fs.existsSync(dataDir)) {
  console.log('No data directory found.');
  process.exit(0);
}

const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json')).sort();
console.log(`Checking data files in ${dataDir}...`);

let totalDays = 0;
let realDays = 0;
let simDays = 0;

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
  const daysMap = new Map();
  
  data.forEach(c => {
    const dateStr = c.timestamp.substring(0, 10);
    if (!daysMap.has(dateStr)) daysMap.set(dateStr, []);
    daysMap.get(dateStr).push(c);
  });
  
  for (const [dateStr, candles] of daysMap.entries()) {
    totalDays++;
    // Calculate total option volume
    let totalOptVol = 0;
    candles.forEach(c => {
      if (c.options) {
        Object.values(c.options).forEach(opt => {
          if (opt.CE) totalOptVol += opt.CE.volume || 0;
          if (opt.PE) totalOptVol += opt.PE.volume || 0;
        });
      }
    });
    
    if (totalOptVol > 0) {
      realDays++;
    } else {
      simDays++;
      if (simDays <= 15) {
        console.log(`  Simulated Day: ${dateStr} (Total Option Volume = 0)`);
      }
    }
  }
}

console.log(`\nData Quality Summary:`);
console.log(`Total Days      : ${totalDays}`);
console.log(`Real Option Days: ${realDays} (${((realDays/totalDays)*100).toFixed(1)}%)`);
console.log(`Simulated Days  : ${simDays} (${((simDays/totalDays)*100).toFixed(1)}%)`);
