/**
 * WEEX API Test Script
 * 
 * Run with: npx tsx packages/backend/src/scripts/test-weex.ts
 */

import { getWeexClient, resetWeexClient } from '../services/weex/WeexClient';
import { config } from '../config';

async function testPublicEndpoints() {
    console.log('\n🔌 Testing WEEX Public Endpoints...\n');

    const weex = getWeexClient();

    // Test 1: Server Time
    try {
        const time = await weex.getServerTime();
        console.log('✅ Server Time:', time.timestamp);
        console.log('   Local Time:', Date.now());
        console.log('   Offset:', time.timestamp - Date.now(), 'ms');
    } catch (error: any) {
        console.log('❌ Server Time:', error.message);
    }

    // Test 2: Get Ticker
    try {
        const ticker = await weex.getTicker('cmt_btcusdt');
        console.log('✅ BTC Ticker:', {
            last: ticker.last,
            bid: ticker.bestBid,
            ask: ticker.bestAsk,
        });
    } catch (error: any) {
        console.log('❌ BTC Ticker:', error.message);
    }

    // Test 3: Get Depth
    try {
        const depth = await weex.getDepth('cmt_btcusdt', 5);
        console.log('✅ Orderbook:', {
            bids: depth.bids?.length || 0,
            asks: depth.asks?.length || 0,
        });
    } catch (error: any) {
        console.log('❌ Orderbook:', error.message);
    }

    // Test 4: Get Candles
    try {
        const candles = await weex.getCandles('cmt_btcusdt', '1m', 5);
        console.log('✅ Candles:', candles.length, 'bars');
    } catch (error: any) {
        console.log('❌ Candles:', error.message);
    }

    // Test 5: Get Contracts
    try {
        const contracts = await weex.getContracts();
        console.log('✅ Contracts:', contracts.length, 'available');
    } catch (error: any) {
        console.log('❌ Contracts:', error.message);
    }
}

async function testPrivateEndpoints() {
    console.log('\n🔐 Testing WEEX Private Endpoints...\n');

    // Check if credentials are configured (all three are required)
    if (!config.weex.apiKey || !config.weex.secretKey || !config.weex.passphrase) {
        console.log('⚠️  WEEX credentials not configured in .env');
        console.log('   Set WEEX_API_KEY, WEEX_SECRET_KEY, WEEX_PASSPHRASE');
        console.log('   API Key:', config.weex.apiKey ? '[SET]' : '[MISSING]');
        console.log('   Secret Key:', config.weex.secretKey ? '[SET]' : '[MISSING]');
        console.log('   Passphrase:', config.weex.passphrase ? '[SET]' : '[MISSING]');
        return;
    }

    console.log('   API Key:', config.weex.apiKey ? '[CONFIGURED]' : '[NOT SET]');

    const weex = getWeexClient();

    // Test 1: Get Account
    try {
        const accounts = await weex.getAccount();
        console.log('✅ Account:', accounts.length, 'account(s)');
    } catch (error: any) {
        console.log('❌ Account:', error.message);
        if (error.code) console.log('   Code:', error.code);
    }

    // Test 2: Get Assets
    try {
        const assets = await weex.getAccountAssets();
        console.log('✅ Assets:', {
            equity: assets.equity,
            available: assets.available,
        });
    } catch (error: any) {
        console.log('❌ Assets:', error.message);
    }

    // Test 3: Get Positions
    try {
        const positions = await weex.getPositions();
        console.log('✅ Positions:', positions.length, 'open');
    } catch (error: any) {
        console.log('❌ Positions:', error.message);
    }

    // Test 4: Get Current Orders
    try {
        const orders = await weex.getCurrentOrders();
        console.log('✅ Current Orders:', orders.length, 'open');
    } catch (error: any) {
        console.log('❌ Current Orders:', error.message);
    }
}

async function main() {
    console.log('═══════════════════════════════════════');
    console.log('       WEEX API Connection Test        ');
    console.log('═══════════════════════════════════════');
    console.log('Base URL:', config.weex.baseUrl);

    await testPublicEndpoints();
    await testPrivateEndpoints();

    console.log('\n═══════════════════════════════════════');
    console.log('              Test Complete            ');
    console.log('═══════════════════════════════════════\n');
}

main().catch(console.error);
