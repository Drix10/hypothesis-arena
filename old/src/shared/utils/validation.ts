import { APPROVED_SYMBOLS, ApprovedSymbol } from '../types/weex';

export function isApprovedSymbol(symbol: string): symbol is ApprovedSymbol {
    return APPROVED_SYMBOLS.includes(symbol.toLowerCase() as ApprovedSymbol);
}

/**
 * Normalizes a symbol string to the standard 'cmt_symbolusdt' format
 * and validates it against the approved symbols list.
 * 
 * @param symbol - The symbol string to normalize (e.g., 'BTC', 'btc-usdt', 'cmt_btcusdt')
 * @returns The normalized symbol or null if invalid/unapproved
 */
export function normalizeAndValidateSymbol(symbol: any): ApprovedSymbol | null {
    if (!symbol || typeof symbol !== 'string') return null;
    
    // Remove whitespace, lowercase, and remove common delimiters/prefixes
    const clean = symbol.toLowerCase().trim()
        .replace(/[-_/]/g, '')
        .replace(/^cmt/, '')
        .replace(/usdt$/, '');
    
    const normalized = `cmt_${clean}usdt`;
    
    return isApprovedSymbol(normalized) ? normalized : null;
}
