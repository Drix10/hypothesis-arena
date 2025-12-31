/**
 * Approved trading symbols for WEEX competition
 * These are the only symbols allowed for trading
 */

export const APPROVED_SYMBOLS = [
    'cmt_btcusdt',
    'cmt_ethusdt',
    'cmt_solusdt',
    'cmt_dogeusdt',
    'cmt_xrpusdt',
    'cmt_adausdt',
    'cmt_bnbusdt',
    'cmt_ltcusdt',
] as const;

export type ApprovedSymbol = typeof APPROVED_SYMBOLS[number];
