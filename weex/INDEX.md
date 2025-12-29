# WEEX Trading API Documentation - Main Index

Complete documentation for the WEEX OpenAPI trading platform.

## Core Documentation

### Getting Started

- **[API_TYPES.md](API_TYPES.md)** - Overview of Public and Private APIs
- **[API_DOMAIN.md](API_DOMAIN.md)** - API endpoint domains and connection information
- **[STANDARD_SPECIFICATIONS.md](STANDARD_SPECIFICATIONS.md)** - Timestamp and request format specifications
- **[LIMITS.md](LIMITS.md)** - Rate limiting and connection limits
- **[SIGNATURE.md](SIGNATURE.md)** - Authentication and signature generation
- **[DEMO_CODE.md](DEMO_CODE.md)** - TypeScript and Python implementation examples
- **[API_PUBLIC_PARAMETERS.md](API_PUBLIC_PARAMETERS.md)** - Margin mode, separated mode, and position mode enums
- **[ERROR_CODES.md](ERROR_CODES.md)** - Complete error code reference
- **[TRADING_RULES.md](TRADING_RULES.md)** - Competition trading rules and requirements

## API Endpoints

### Market Data - [market/INDEX.md](market/INDEX.md)

Public endpoints for retrieving market information (no authentication required)

**15 Endpoints:**

- Get Server Time
- Get Futures Information
- Get OrderBook Depth
- Get All Ticker
- Get Single Ticker
- Get Trades
- Get Historical Candlestick
- Get Candlestick Data
- Get Cryptocurrency Index
- Get Open Interest
- Get Next Funding Time
- Get Historical Funding Rates
- Get Current Funding Rate

### Account Management - [account/INDEX.md](account/INDEX.md)

Private endpoints for managing account settings and positions (authentication required)

**11 Endpoints:**

- Get Account List
- Get Single Account
- Get Account Assets
- Get Contract Account Bills
- Get User Settings Of One Single Futures
- Change Leverage
- Adjust Position Margin
- Automatic Margin Top-Up
- Get All Positions
- Get Single Position
- Modify User Account Mode

### Trading - [trade/INDEX.md](trade/INDEX.md)

Private endpoints for order management and execution (authentication required)

**17 Endpoints:**

- Place Order
- Batch Orders
- Cancel Order
- Batch Cancel Orders
- Get Order Info
- Get History Orders
- Get Current Orders
- Get Fills
- Place Trigger Order
- Cancel Trigger Order
- Get Current Plan Orders
- Get History Plan Orders
- Close All Positions
- Cancel All Orders
- Place TP/SL Order
- Modify TP/SL Order
- Upload AI Log (Required for live trading)

## WebSocket API

### Public Channels - [websocket/public/INDEX.md](websocket/public/INDEX.md)

Real-time market data streams (no authentication required)

**4 Channels:**

- Market Channel - Real-time ticker data
- Candlestick Channel - K-line data with multiple intervals
- Depth Channel - Order book depth updates
- Public Trade Channel - Platform trade information

### Private Channels - [websocket/private/INDEX.md](websocket/private/INDEX.md)

Real-time account and trading data (authentication required)

**4 Channels:**

- Account Channel - Account balance and collateral updates
- Position Channel - Position updates and changes
- Fill Channel - Trade execution details
- Order Channel - Order status and updates

### WebSocket Info - [websocket/INFO.md](websocket/INFO.md)

Connection specifications, authentication, and subscription management

## Quick Navigation

| Category       | Location                             | Purpose                     |
| -------------- | ------------------------------------ | --------------------------- |
| Authentication | [SIGNATURE.md](SIGNATURE.md)         | Learn how to sign requests  |
| Rate Limits    | [LIMITS.md](LIMITS.md)               | Understand rate limiting    |
| Market Data    | [market/](market/)                   | Retrieve market information |
| Account Info   | [account/](account/)                 | Manage account settings     |
| Trading        | [trade/](trade/)                     | Place and manage orders     |
| Real-time Data | [websocket/](websocket/)             | Stream live data            |
| Error Handling | [ERROR_CODES.md](ERROR_CODES.md)     | Handle API errors           |
| Rules          | [TRADING_RULES.md](TRADING_RULES.md) | Competition requirements    |

## Key Features

- **REST API**: 42 endpoints across market, account, and trading operations
- **WebSocket API**: 8 real-time channels for market and account data
- **Authentication**: HMAC SHA256 signature-based authentication
- **Rate Limiting**: 1000 requests per 10 seconds per endpoint
- **Multiple Trading Pairs**: 8 approved futures pairs
- **Advanced Orders**: Limit, market, trigger, and TP/SL orders
- **Position Management**: Cross and isolated margin modes with leverage control

## Getting Started

1. Start with [API_TYPES.md](API_TYPES.md) to understand API categories
2. Review [SIGNATURE.md](SIGNATURE.md) for authentication
3. Check [DEMO_CODE.md](DEMO_CODE.md) for implementation examples
4. Explore specific endpoints in [market/](market/), [account/](account/), or [trade/](trade/)
5. Use [websocket/](websocket/) for real-time data
6. Reference [ERROR_CODES.md](ERROR_CODES.md) for error handling
