/**
 * Generate currencies.json from CLDR via Intl API.
 * 
 * Run: bun packages/data/scripts/generate-currencies.ts
 */

const LOCALES = [
  "cs", "sk", "de", "en", "fr", "pl", "hu", "ro",
  "sv", "da", "no", "it", "es", "nl", "bg", "hr",
  "pt", "fi", "et", "lt", "lv", "sl", "el", "tr",
];

// ISO 4217 codes to include
const CODES = [
  "AED","ALL","AMD","ARS","AUD","AZN","BAM","BBD",
  "BGN","BHD","BRL","CAD","CHF","CLP","CNY","COP",
  "CRC","CZK","DKK","DOP","EGP","EUR","GBP","GEL",
  "GHS","GTQ","HKD","HNL","HRK","HUF","IDR","ILS",
  "INR","IQD","IRR","ISK","JMD","JOD","JPY","KES",
  "KRW","KWD","KZT","LBP","MAD","MDL","MXN","MYR",
  "NGN","NOK","NZD","OMR","PAB","PEN","PHP","PKR",
  "PLN","PYG","QAR","RON","RSD","RUB","SAR","SEK",
  "SGD","THB","TJS","TMT","TND","TRY","TWD","UAH",
  "UGX","USD","UYU","UZS","VES","VND","ZAR","ZMW",
];

const symbols = new Set<string>();
const localNames = new Set<string>();

for (const code of CODES) {
  for (const loc of LOCALES) {
    // Get symbols
    for (const amount of [1, 2, 5, 100]) {
      try {
        const parts = new Intl.NumberFormat(loc, {
          style: "currency", currency: code,
          currencyDisplay: "symbol",
        }).formatToParts(amount);
        const sym = parts.find(p => p.type === "currency")?.value;
        if (sym && sym !== code && sym.length <= 5) {
          symbols.add(sym);
        }
      } catch {}

      // Get written names (plural forms)
      try {
        const parts = new Intl.NumberFormat(loc, {
          style: "currency", currency: code,
          currencyDisplay: "name",
        }).formatToParts(amount);
        const name = parts.find(p => p.type === "currency")?.value;
        if (name && name.length >= 2 && name.length <= 30) {
          localNames.add(name.toLowerCase());
        }
      } catch {}
    }
  }
}

// Filter out names that are too short or too common
const filtered = [...localNames]
  .filter(n => n.length >= 3) // "kr" is a symbol, not a name
  .sort();

const result = {
  _comment: "Auto-generated from CLDR via Intl API. " +
    "Run: bun packages/data/scripts/generate-currencies.ts",
  codes: CODES.sort(),
  symbols: [...symbols].sort(),
  localNames: filtered,
};

const path = "packages/data/config/currencies.json";
await Bun.write(path, JSON.stringify(result, null, 2) + "\n");

console.log(`Written: ${path}`);
console.log(`  ${result.codes.length} codes`);
console.log(`  ${result.symbols.length} symbols`);
console.log(`  ${result.localNames.length} local names`);
