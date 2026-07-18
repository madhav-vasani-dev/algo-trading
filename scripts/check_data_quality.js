const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'public', 'data', 'nifty_1min');
if (!fs.existsSync(dataDir)) {
  console.log('No data directory found.');
  process.exit(0);
}

console.log(`Checking data files in ${dataDir}...`);

let totalDays = 0;
let realDays = 0;
let simDays = 0;

// Read subdirectories (YYYY-MM)
const subdirs = fs.readdirSync(dataDir)
  .filter(d => fs.statSync(path.join(dataDir, d)).isDirectory() && /^\d{4}-\d{2}$/.test(d))
  .sort();

for (const subdir of subdirs) {
  const subdirPath = path.join(dataDir, subdir);
  const files = fs.readdirSync(subdirPath).filter(f => f.endsWith('.json')).sort();
  
  for (const file of files) {
    const filePath = path.join(subdirPath, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const dateStr = file.replace('.json', '');
    
    totalDays++;
    // Calculate total option volume
    let totalOptVol = 0;
    data.forEach(c => {
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
      console.log(`  Simulated Day: ${dateStr} (Total Option Volume = 0)`);
    }
  }
}

console.log(`\nData Quality Summary:`);
console.log(`Total Days      : ${totalDays}`);
console.log(`Real Option Days: ${realDays} (${((realDays/totalDays)*100).toFixed(1)}%)`);
console.log(`Simulated Days  : ${simDays} (${((simDays/totalDays)*100).toFixed(1)}%)`);

