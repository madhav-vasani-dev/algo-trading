/**
 * Mapping of index display names → Upstox instrument keys.
 */
export const INDEX_MAPPING: Record<string, string> = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'NIFTY BANK': 'NSE_INDEX|Nifty Bank',
  'NIFTY IT': 'NSE_INDEX|Nifty IT',
  'NIFTY MIDCAP 100': 'NSE_INDEX|NIFTY MIDCAP 100',
  'NIFTY NEXT 50': 'NSE_INDEX|Nifty Next 50',
  'SENSEX': 'BSE_INDEX|SENSEX',
  'NIFTY FINANCIAL SERVICES': 'NSE_INDEX|Nifty Financial Services',
  'NIFTY AUTO': 'NSE_INDEX|Nifty Auto',
  'NIFTY PHARMA': 'NSE_INDEX|Nifty Pharma',
  'NIFTY METAL': 'NSE_INDEX|Nifty Metal',
  'NIFTY REALTY': 'NSE_INDEX|Nifty Realty',
  'NIFTY ENERGY': 'NSE_INDEX|Nifty Energy',
  'NIFTY MEDIA': 'NSE_INDEX|Nifty Media',
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
  'Healthcare': 'NIFTY PHARMA',
};
