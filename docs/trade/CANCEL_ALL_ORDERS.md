# Cancel All Orders

## Endpoint

`POST /capi/v2/order/cancelAllOrders`

## Weight

**IP**: 40  
**UID**: 50

## Request Parameters

| Parameter       | Type   | Required? | Description                                                                                |
| --------------- | ------ | --------- | ------------------------------------------------------------------------------------------ |
| symbol          | String | No        | Trading pair. If not provided, orders for all trading pairs will be cancelled              |
| cancelOrderType | String | Yes       | Order type to cancel: `normal` = Cancel normal orders, `plan` = Cancel trigger/plan orders |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/cancelAllOrders" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "cmt_btcusdt",
    "cancelOrderType": "normal"
  }'
```

## Response Parameters

| Parameter | Type    | Description                                  |
| --------- | ------- | -------------------------------------------- |
| orderId   | Long    | Order ID                                     |
| success   | Boolean | Whether the order was cancelled successfully |

## Response Example

```json
[
  {
    "orderId": 696026685023191898,
    "success": true
  }
]
```
