# Place TP/SL Order

## Endpoint

`POST /capi/v2/order/placeTpSlOrder`

## Weight

**IP**: 2  
**UID**: 5

## Request Parameters

| Parameter     | Type    | Required? | Description                                                                                          |
| ------------- | ------- | --------- | ---------------------------------------------------------------------------------------------------- |
| symbol        | String  | Yes       | Trading pair                                                                                         |
| clientOrderId | String  | Yes       | Custom order ID (no more than 40 characters)                                                         |
| planType      | String  | Yes       | TP/SL type: `profit_plan` = Take-profit plan order, `loss_plan` = Stop-loss plan order               |
| triggerPrice  | String  | Yes       | Trigger price                                                                                        |
| executePrice  | String  | No        | Execution price. If not provided or set to 0, market price will be used. Value > 0 means limit price |
| size          | String  | Yes       | Order quantity                                                                                       |
| positionSide  | String  | Yes       | Position direction: `long` = Long position, `short` = Short position                                 |
| marginMode    | Integer | No        | Margin mode: `1` = Cross Mode, `3` = Isolated Mode. Default is 1 (Cross Mode)                        |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/placeTpSlOrder" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "cmt_btcusdt",
    "clientOrderId": "123456789",
    "planType": "profit_plan",
    "triggerPrice": "50000",
    "executePrice": "0",
    "size": "1",
    "positionSide": "long",
    "marginMode": 1
  }'
```

## Response Parameters

| Parameter | Type    | Description                                     |
| --------- | ------- | ----------------------------------------------- |
| success   | Boolean | Whether the TP/SL order was placed successfully |
| orderId   | Long    | Order ID (0 if failed)                          |

## Response Example

```json
[
  {
    "orderId": 696073048050107226,
    "success": true
  }
]
```
