// Single source of truth for the pricing model, so paystack-initialize.js
// and create-batch.js can never drift apart on the rate.
//
//   ₦1 topped up  = 1 token credited to the wallet
//   1 certificate = 50 tokens (₦50 equivalent)
//
// This makes the 500-token trial grant equal to exactly 10 free
// certificates (500 / 50), matching the BRD's own "500 free trial tokens
// (10 free certificates)" language.
const TOKENS_PER_CERTIFICATE = 50;
const MIN_TOPUP_NAIRA = 800;

function nairaToTokens(amountNaira) {
  return Math.floor(Number(amountNaira));
}

module.exports = { TOKENS_PER_CERTIFICATE, MIN_TOPUP_NAIRA, nairaToTokens };
