# Account Management API Endpoints

Private account management endpoints (authentication required). All endpoints use both IP and UID-based rate limiting.

## Endpoints

| Endpoint                                                       | Method | Weight (IP/UID) | Description                         |
| -------------------------------------------------------------- | ------ | --------------- | ----------------------------------- |
| [GET_ACCOUNT_LIST.md](GET_ACCOUNT_LIST.md)                     | GET    | 5/5             | Get all accounts with settings      |
| [GET_SINGLE_ACCOUNT.md](GET_SINGLE_ACCOUNT.md)                 | GET    | 1/1             | Get single account by coin          |
| [GET_ACCOUNT_ASSETS.md](GET_ACCOUNT_ASSETS.md)                 | GET    | 5/10            | Get account assets and balances     |
| [GET_CONTRACT_ACCOUNT_BILLS.md](GET_CONTRACT_ACCOUNT_BILLS.md) | POST   | 2/5             | Get account transaction history     |
| [GET_USER_SETTINGS.md](GET_USER_SETTINGS.md)                   | GET    | 1/1             | Get user leverage settings          |
| [CHANGE_LEVERAGE.md](CHANGE_LEVERAGE.md)                       | POST   | 10/20           | Change position leverage            |
| [ADJUST_POSITION_MARGIN.md](ADJUST_POSITION_MARGIN.md)         | POST   | 15/30           | Adjust isolated margin              |
| [AUTOMATIC_MARGIN_TOP_UP.md](AUTOMATIC_MARGIN_TOP_UP.md)       | POST   | 15/30           | Enable/disable auto margin top-up   |
| [GET_ALL_POSITIONS.md](GET_ALL_POSITIONS.md)                   | GET    | 10/15           | Get all open positions              |
| [GET_SINGLE_POSITION.md](GET_SINGLE_POSITION.md)               | GET    | 2/3             | Get single position by symbol       |
| [MODIFY_USER_ACCOUNT_MODE.md](MODIFY_USER_ACCOUNT_MODE.md)     | POST   | 20/50           | Change margin mode (cross/isolated) |

## Quick Links

- **Base URL**: `https://api-contract.weex.com/`
- **Rate Limit**: 1000 requests per 10 seconds (IP), 1000 per 10 seconds (UID)
- **Authentication**: Required (API Key, Signature, Timestamp, Passphrase)

## Authentication

All account endpoints require the following headers:

- `ACCESS-KEY`: Your API key
- `ACCESS-SIGN`: HMAC SHA256 signature
- `ACCESS-TIMESTAMP`: Unix millisecond timestamp
- `ACCESS-PASSPHRASE`: Your API passphrase

See [../SIGNATURE.md](../SIGNATURE.md) for signature generation details.

## Common Parameters

### Margin Modes

- `1` - Cross Mode (shared collateral)
- `3` - Isolated Mode (separate collateral per position)

### Position Sides

- `LONG` - Long position
- `SHORT` - Short position

### Business Types (for bills)

- `deposit` - Deposit
- `withdraw` - Withdrawal
- `transfer_in` - Transfer in
- `transfer_out` - Transfer out
- `margin_move_in` - Margin increase
- `margin_move_out` - Margin decrease
- `position_open_long` - Open long position
- `position_open_short` - Open short position
- `position_close_long` - Close long position
- `position_close_short` - Close short position
- `position_funding` - Funding fee settlement

## Usage Examples

### Get Account Assets

```bash
curl "https://api-contract.weex.com/capi/v2/account/assets" \
  -H "ACCESS-KEY: your_key" \
  -H "ACCESS-SIGN: signature" \
  -H "ACCESS-TIMESTAMP: timestamp" \
  -H "ACCESS-PASSPHRASE: passphrase"
```

### Change Leverage

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/account/leverage" \
  -H "ACCESS-KEY: your_key" \
  -H "ACCESS-SIGN: signature" \
  -H "ACCESS-TIMESTAMP: timestamp" \
  -H "ACCESS-PASSPHRASE: passphrase" \
  -d '{"symbol":"cmt_btcusdt","marginMode":1,"longLeverage":"20"}'
```

### Get All Positions

```bash
curl "https://api-contract.weex.com/capi/v2/account/position/allPosition" \
  -H "ACCESS-KEY: your_key" \
  -H "ACCESS-SIGN: signature" \
  -H "ACCESS-TIMESTAMP: timestamp" \
  -H "ACCESS-PASSPHRASE: passphrase"
```

## Response Format

All endpoints return JSON responses with the following structure:

```json
{
  "data": {},
  "code": "00000",
  "msg": "success"
}
```

## Error Handling

Refer to [../ERROR_CODES.md](../ERROR_CODES.md) for complete error code reference.

Common errors:

- `40001` - Header "ACCESS_KEY" is required
- `40002` - Header "ACCESS_SIGN" is required
- `40012` - Incorrect API key/Passphrase
- `40022` - Insufficient permissions for this operation
- `50007` - Leverage cannot exceed the limit

## Account Structure

### Account Object

Contains default fee settings, fee settings per symbol, mode settings, and leverage settings.

### Collateral Object

Contains balance information, pending amounts, and cumulative statistics for each collateral currency.

### Position Object

Contains position details including size, leverage, margin, fees, and PnL information.
