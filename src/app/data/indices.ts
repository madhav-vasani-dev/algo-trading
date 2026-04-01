/**
 * Mapping of index display names → Upstox instrument keys.
 */
export const INDEX_MAPPING: Record<string, string> = {
  // Broad Market
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'NIFTY NEXT 50': 'NSE_INDEX|Nifty Next 50',
  'NIFTY MIDCAP 100': 'NSE_INDEX|NIFTY MIDCAP 100',
  'NIFTY MIDCAP 50': 'NSE_INDEX|NIFTY MIDCAP 50',

  // Sectoral
  'NIFTY BANK': 'NSE_INDEX|Nifty Bank',
  'NIFTY FINANCIAL SERVICES': 'NSE_INDEX|Nifty Financial Services',
  'NIFTY IT': 'NSE_INDEX|Nifty IT',
  'NIFTY AUTO': 'NSE_INDEX|Nifty Auto',
  'NIFTY PHARMA': 'NSE_INDEX|Nifty Pharma',
  'NIFTY METAL': 'NSE_INDEX|Nifty Metal',
  'NIFTY REALTY': 'NSE_INDEX|Nifty Realty',
  'NIFTY ENERGY': 'NSE_INDEX|Nifty Energy',
  'NIFTY MEDIA': 'NSE_INDEX|Nifty Media',
  'NIFTY FMCG': 'NSE_INDEX|Nifty FMCG',
  'NIFTY HEALTHCARE': 'NSE_INDEX|Nifty Healthcare Index',
  'NIFTY PSE': 'NSE_INDEX|Nifty PSE',
  'NIFTY PSU BANK': 'NSE_INDEX|Nifty PSU Bank',
  'NIFTY PRIVATE BANK': 'NSE_INDEX|Nifty Private Bank',
  'NIFTY INFRASTRUCTURE': 'NSE_INDEX|Nifty Infrastructure',
  'NIFTY CONSUMPTION': 'NSE_INDEX|Nifty India Consumption',
  'NIFTY COMMODITIES': 'NSE_INDEX|Nifty Commodities',
  'NIFTY CPSE': 'NSE_INDEX|Nifty CPSE',
  'NIFTY DEFENCE': 'NSE_INDEX|Nifty India Defence',

  // BSE
  'SENSEX': 'BSE_INDEX|SENSEX',
};

export const INDEX_NAMES = Object.keys(INDEX_MAPPING);

/**
 * Maps sector names (from sectors.ts) to their closest stock-market index.
 * Used to auto-select an index when user picks a sector.
 */
export const SECTOR_TO_INDEX: Record<string, string> = {
  'IT': 'NIFTY IT',
  'Software services': 'NIFTY IT',
  'Financial services': 'NIFTY FINANCIAL SERVICES',
  'NBFC': 'NIFTY FINANCIAL SERVICES',
  'Auto ancillary': 'NIFTY AUTO',
  'Metals': 'NIFTY METAL',
  'Real estate': 'NIFTY REALTY',
  'Energy': 'NIFTY ENERGY',
  'Media & entertainment': 'NIFTY MEDIA',
  'Healthcare': 'NIFTY HEALTHCARE',
  'FMCG': 'NIFTY FMCG',
  'Defence': 'NIFTY DEFENCE',
  'Chemicals': 'NIFTY COMMODITIES',
  'Building materials': 'NIFTY INFRASTRUCTURE',
  'Telecom': 'NIFTY INFRASTRUCTURE',
  'Engineering & capital goods': 'NIFTY INFRASTRUCTURE',
  'Consumer durables': 'NIFTY CONSUMPTION',
  'Retail': 'NIFTY CONSUMPTION',
  'Tourism & hospitality': 'NIFTY CONSUMPTION',
};
