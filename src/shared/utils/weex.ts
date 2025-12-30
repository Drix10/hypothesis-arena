/**
 * WEEX API Utility Functions
 * Ensures compliance with WEEX trading specifications
 */

/**
 * Round order size to WEEX stepSize (0.0001 for most contracts)
 * Uses floor rounding to ensure we don't exceed available balance
 * 
 * @param size - Raw order size
 * @param stepSize - WEEX contract stepSize (default: 0.0001)
 * @returns Rounded size as string with 4 decimal places
 */
export function roundToStepSize(size: number, stepSize: number = 0.0001): string {
    if (!Number.isFinite(size) || size <= 0) {
        throw new Error(`Invalid size: ${size}`);
    }

    const rounded = Math.floor(size / stepSize) * stepSize;

    if (rounded < stepSize) {
        throw new Error(`Size ${size} too small after rounding to stepSize ${stepSize}`);
    }

    return rounded.toFixed(4);
}

/**
 * Round price to WEEX tick_size (1 for most contracts = 2 decimal places)
 * 
 * @param price - Raw price
 * @param tickSize - WEEX contract tick_size (default: 1 = 2 decimals)
 * @returns Rounded price as string
 */
export function roundToTickSize(price: number, tickSize: number = 1): string {
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Invalid price: ${price}`);
    }

    // tickSize=1 means 2 decimal places (priceEndStep=1)
    const decimals = tickSize === 1 ? 2 : Math.max(0, -Math.log10(tickSize));
    return price.toFixed(decimals);
}

/**
 * Validate WEEX order parameters before submission
 * Throws error if any parameter is invalid
 * 
 * @param order - Order parameters to validate
 */
export function validateWeexOrder(order: {
    symbol: string;
    size: string;
    price: string;
    type: '1' | '2' | '3' | '4';
    order_type: '0' | '1' | '2' | '3';
    match_price: '0' | '1';
    client_oid?: string;
}): void {
    // Validate symbol format
    if (!order.symbol || !order.symbol.startsWith('cmt_') || !order.symbol.endsWith('usdt')) {
        throw new Error(`Invalid symbol format: ${order.symbol} (must be cmt_xxxusdt)`);
    }

    // Validate size
    const size = parseFloat(order.size);
    if (!Number.isFinite(size) || size <= 0) {
        throw new Error(`Invalid size: ${order.size}`);
    }
    if (size < 0.0001) {
        throw new Error(`Size ${order.size} below minimum 0.0001`);
    }

    // Validate price
    const price = parseFloat(order.price);
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Invalid price: ${order.price}`);
    }

    // Validate order type
    if (!['1', '2', '3', '4'].includes(order.type)) {
        throw new Error(`Invalid order type: ${order.type}`);
    }

    // Validate order execution type
    if (!['0', '1', '2', '3'].includes(order.order_type)) {
        throw new Error(`Invalid order_type: ${order.order_type}`);
    }

    // Validate match_price
    if (!['0', '1'].includes(order.match_price)) {
        throw new Error(`Invalid match_price: ${order.match_price}`);
    }

    // Validate client_oid length if provided
    if (order.client_oid && order.client_oid.length > 40) {
        throw new Error(`client_oid exceeds 40 characters: ${order.client_oid.length}`);
    }
}

/**
 * Validate leverage is within WEEX limits
 * 
 * @param leverage - Requested leverage
 * @param maxLeverage - Maximum allowed leverage (default: 500 per WEEX docs)
 * @returns Clamped leverage value
 */
export function validateLeverage(leverage: number, maxLeverage: number = 500): number {
    if (!Number.isFinite(leverage) || leverage < 1) {
        throw new Error(`Invalid leverage: ${leverage} (must be >= 1)`);
    }

    if (leverage > maxLeverage) {
        return maxLeverage;
    }

    return Math.floor(leverage);
}
