const fs = require('fs');
const path = require('path');

const march6File = path.join(__dirname, '..', 'public', 'data', 'nifty_1min', '2025-03', '2025-03-06.json');
const may2File = path.join(__dirname, '..', 'public', 'data', 'nifty_1min', '2025-05', '2025-05-02.json');

console.log('========================================================================');
console.log('  INSPECTING DATA FIELDS IN 2025-03-06.json AND 2025-05-02.json');
console.log('========================================================================\n');

if (fs.existsSync(march6File)) {
  const data = JSON.parse(fs.readFileSync(march6File, 'utf8'));
  const c1100 = data.find(c => c.timestamp.includes('11:00'));
  console.log('2025-03-06 at 11:00 AM candle:');
  console.log(JSON.stringify(c1100, null, 2));
} else {
  console.log('2025-03-06 file missing!');
}

console.log('\n------------------------------------------------------------------------\n');

if (fs.existsSync(may2File)) {
  const data = JSON.parse(fs.readFileSync(may2File, 'utf8'));
  const c1100 = data.find(c => c.timestamp.includes('11:00'));
  console.log('2025-05-02 at 11:00 AM candle:');
  console.log(JSON.stringify(c1100, null, 2));
} else {
  console.log('2025-05-02 file missing!');
}
