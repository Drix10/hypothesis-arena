# Close All Positions

## Endpoint

`POST /capi/v2/order/closePositions`

## Weight

**IP**: 40  
**UID**: 50

## Request Parameters

| Parameter | Type   | Required? | Description                                                                 |
| --------- | ------ | --------- | --------------------------------------------------------------------------- |
| symbol    | String | No        | Trading pair. If not provided, all positions will be closed at market price |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/closePositions" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "cmt_btcusdt"
  }'
```

## Response Parameters

| Parameter      | Type    | Description                                  |
| -------------- | ------- | -------------------------------------------- |
| positionId     | Long    | Position ID                                  |
| success        | Boolean | Whether the position was successfully closed |
| successOrderId | Long    | Order ID if successful (0 if failed)         |
| errorMessage   | String  | Error message if the close position failed   |

## Response Example

```json
[
  {
    "positionId": 690800371848708186,
    "successOrderId": 696023766399976282,
    "errorMessage": "",
    "success": true
  }
]
```
