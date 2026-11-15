export const indiaTradingIndices = {
  "Nifty 50": { file: "ind_nifty50list.csv", min: 45, max: 55 },
  "Nifty Next 50": { file: "ind_niftynext50list.csv", min: 45, max: 55 },
  "Nifty 100": { file: "ind_nifty100list.csv", min: 90, max: 110 },
  "Nifty 200": { file: "ind_nifty200list.csv", min: 180, max: 220 },
  "Nifty 500": { file: "ind_nifty500list.csv", min: 450, max: 550 },
  "Nifty Bank": { file: "ind_niftybanklist.csv", min: 10, max: 20 },
  "Nifty IT": { file: "ind_niftyitlist.csv", min: 8, max: 12 },
} as const;
export type IndiaTradingIndex = keyof typeof indiaTradingIndices;
export const indiaTradingIndexNames = Object.keys(indiaTradingIndices) as [
  IndiaTradingIndex,
  ...IndiaTradingIndex[],
];
