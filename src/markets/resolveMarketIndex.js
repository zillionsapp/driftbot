export async function resolveMarketIndex(env, marketSymbol, PerpMarkets) {
  const tables = [
    PerpMarkets?.[env],
    PerpMarkets?.['mainnet-beta'],
    PerpMarkets?.['mainnet'],
  ].filter(Boolean);

  if (tables.length === 0) {
    throw new Error('PerpMarkets table not available in SDK build');
  }

  const baseSymbol = marketSymbol.replace(/-PERP$/i, '');
  for (const tbl of tables) {
    const m =
      tbl.find((x) => x.baseAssetSymbol === baseSymbol) ||
      tbl.find((x) => x.symbol === marketSymbol || x.marketName === marketSymbol);
    if (m && typeof m.marketIndex === 'number') return m.marketIndex;
  }
  throw new Error(`Perp market ${marketSymbol} not found in tables`);
}
