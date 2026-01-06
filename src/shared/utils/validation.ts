import { APPROVED_SYMBOLS, ApprovedSymbol } from '../types/weex';

export function isApprovedSymbol(symbol: string): symbol is ApprovedSymbol {
    return APPROVED_SYMBOLS.includes(symbol.toLowerCase() as ApprovedSymbol);
}
