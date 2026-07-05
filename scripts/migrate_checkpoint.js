const fs = require('fs');
const path = require('path');

const CHECKPOINT_DIR = path.join(__dirname, '..', 'public', 'data', '_checkpoint');
const CHECKPOINT_FILE = path.join(CHECKPOINT_DIR, 'fetch_all_progress.json');
const INDEX_KEY_ENC = encodeURIComponent('NSE_INDEX|Nifty 50');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  if (!fs.existsSync(CHECKPOINT_FILE)) {
    console.log('No checkpoint file found.');
    return;
  }

  console.log('Reading 534MB checkpoint file...');
  const data = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
  const completedExpiries = data.completedExpiries || {};
  const futuresData = data.futuresData || {};
  const optionData = data.optionData || {};

  console.log(`Loaded ${Object.keys(completedExpiries).length} completed expiries and ${Object.keys(futuresData).length} futures candles.`);

  if (Object.keys(optionData).length === 0) {
    console.log('optionData is already split. No migration needed.');
    return;
  }

  console.log('Grouping option candles by timestamp date...');
  const expiries = Object.keys(completedExpiries).sort();
  const optionsPerExpiry = {};

  Object.keys(optionData).forEach(ts => {
    const dateStr = ts.split('T')[0];
    // Find closest expiry >= dateStr
    let exp = expiries.find(e => e >= dateStr) || expiries[expiries.length - 1];
    if (!optionsPerExpiry[exp]) optionsPerExpiry[exp] = {};
    optionsPerExpiry[exp][ts] = optionData[ts];
  });

  console.log('Writing per-expiry option checkpoint files...');
  Object.keys(optionsPerExpiry).forEach(exp => {
    const file = path.join(CHECKPOINT_DIR, `options_${exp}.json`);
    fs.writeFileSync(file, JSON.stringify(optionsPerExpiry[exp]));
    const sizeMB = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
    console.log(`  Saved options_${exp}.json (${sizeMB} MB)`);
  });

  console.log('Updating fetch_all_progress.json to compact format (removing monolithic optionData)...');
  const compactCheckpoint = {
    completedExpiries,
    futuresData
  };
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(compactCheckpoint));
  const newSizeMB = (fs.statSync(CHECKPOINT_FILE).size / 1024 / 1024).toFixed(1);
  console.log(`  fetch_all_progress.json updated (${newSizeMB} MB)`);

  console.log('Migration completed successfully!');
}

run().catch(err => console.error('Migration error:', err));
