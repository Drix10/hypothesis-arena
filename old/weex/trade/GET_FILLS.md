# Get Fills

## Endpoint

`GET /capi/v2/order/fills`

## Weight

**IP**: 5  
**UID**: 5

## Request Parameters

| Parameter | Type   | Required? | Description                                   |
| --------- | ------ | --------- | --------------------------------------------- |
| symbol    | String | No        | Trading pair name                             |
| orderId   | Long   | No        | Order ID                                      |
| startTime | Long   | No        | Start timestamp Unix millisecond timestamp    |
| endTime   | Long   | No        | End timestamp Unix millisecond timestamp      |
| limit     | Long   | No        | Number of queries: Maximum: 100, default: 100 |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/order/fills?symbol=cmt_bchusdt&orderId=596471064624628269" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*******" \
  -H "ACCESS-PASSPHRASE:*****" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json"
```

## Response Parameters

| Parameter                  | Type    | Description                                  |
| -------------------------- | ------- | -------------------------------------------- |
| list                       | List    | Transaction details                          |
| list[].tradeId             | Integer | Filled order ID                              |
| list[].orderId             | Integer | Associated order ID                          |
| list[].symbol              | String  | Trading pair name                            |
| list[].marginMode          | String  | Margin mode                                  |
| list[].separatedMode       | String  | Separated mode                               |
| list[].positionSide        | String  | Position direction                           |
| list[].orderSide           | String  | Order direction                              |
| list[].fillSize            | String  | Actual filled quantity                       |
| list[].fillValue           | String  | Actual filled value                          |
| list[].fillFee             | String  | Actual trading fee                           |
| list[].liquidateFee        | String  | Closing fee                                  |
| list[].realizePnl          | String  | Actual realized PnL                          |
| list[].direction           | String  | Actual execution direction                   |
| list[].liquidateType       | String  | Liquidation order type                       |
| list[].legacyOrdeDirection | String  | Compatible with legacy order direction types |
| list[].createdTime         | Integer | Timestamp Unix millisecond timestamp         |
| nextFlag                   | Boolean | Whether more pages exist                     |
| totals                     | Integer | Total entries                                |

## Response Example

```json
{
  "list": [
    {
      "tradeId": 0,
      "orderId": 0,
      "symbol": "cmt_btcusdt",
      "marginMode": "SHARED",
      "separatedMode": "SEPARATED",
      "positionSide": "LONG",
      "orderSide": "BUY",
      "fillSize": "67",
      "fillValue": "12",
      "fillFee": "67",
      "liquidateFee": "MAKER",
      "realizePnl": "83",
      "direction": "OPEN_LONG",
      "liquidateType": "FORCE_LIQUIDATE",
      "legacyOrdeDirection": "OPEN_LONG",
      "createdTime": 1716712170527
    }
  ],
  "nextFlag": false,
  "totals": 0
}
```
