import { Connection, Keypair } from '@solana/web3.js';
import pkg from '@drift-labs/sdk';

const {
  DriftClient,
  initialize,
  convertToNumber,
  PerpMarkets,
  calculateBidAskPrice,
  PRICE_PRECISION,
} = pkg;

export async function createDriftContext(cfg, log) {
  const commitmentOrConfig = {
    commitment: 'confirmed',
    ...(cfg.WS_URL ? { wsEndpoint: cfg.WS_URL } : {})
  };
  const connection = new Connection(cfg.RPC_URL, commitmentOrConfig);
  const dummy = Keypair.generate();

  const sdkConfig = await initialize({ connection, env: cfg.ENV_NETWORK });
  const env = sdkConfig.env;

  const drift = new DriftClient({
    connection,
    wallet: { publicKey: dummy.publicKey, payer: dummy },
    env,
    accountSubscription: { type: 'websocket' }
  });

  try {
    await drift.subscribe();
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg.includes('410') || msg.toLowerCase().includes('disabled')) {
      log.error(`FATAL RPC 410/disabled from ${cfg.RPC_URL}.`);
      log.error(`Use a mainnet provider that allows Drift account queries & websockets.`);
    }
    throw e;
  }

  async function getMarkPrice(marketIndex) {
    const market = drift.getPerpMarketAccount(marketIndex);
    if (!market) return null;

    const [bidBN, askBN] = calculateBidAskPrice(
      market.amm,
      drift.getOracleDataForPerpMarket(marketIndex)
    );
    const bid = convertToNumber(bidBN, PRICE_PRECISION);
    const ask = convertToNumber(askBN, PRICE_PRECISION);
    const mark = (bid + ask) / 2;
    return { bid, ask, mark };
  }

  async function close() {
    try { await drift.unsubscribe(); } catch {}
  }

  return { connection, env, drift, PerpMarkets, getMarkPrice, close };
}
