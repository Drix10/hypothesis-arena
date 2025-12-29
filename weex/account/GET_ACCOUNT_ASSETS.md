# Get Account Assets

## Endpoint

`GET /capi/v2/account/assets`

## Weight

**IP**: 5  
**UID**: 10

## Request Parameters

NONE

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/account/assets" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*******" \
  -H "ACCESS-PASSPHRASE:*****" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json"
```

## Response Parameters

| Field Name   | Type   | Field Description          |
| ------------ | ------ | -------------------------- |
| coinName     | String | Name of the crypto         |
| available    | String | Available asset            |
| frozen       | String | Frozen asset               |
| equity       | String | Total asset                |
| unrealizePnl | String | Unrealized Profit and Loss |

## Response Example

```json
[
  {
    "coinName": "USDT",
    "available": "5413.06877369",
    "equity": "5696.49288823",
    "frozen": "81.28240000",
    "unrealizePnl": "-34.55300000"
  }
]
```
