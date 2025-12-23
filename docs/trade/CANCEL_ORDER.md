# Cancel Order

## Endpoint

`POST /capi/v2/order/cancel_order`

## Weight

**IP**: 2  
**UID**: 3

## Request Parameters

| Parameter | Type   | Required? | Description                                         |
| --------- | ------ | --------- | --------------------------------------------------- |
| orderId   | String | No        | Either Order ID or clientOid is required.           |
| clientOid | String | No        | Either Client customized ID or orderId is required. |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/cancel_order" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "596471064624628269"
  }'
```

## Response Parameters

| Parameter  | Type    | Description                          |
| ---------- | ------- | ------------------------------------ |
| order_id   | String  | Order ID                             |
| client_oid | String  | Client identifier                    |
| result     | Boolean | Cancellation status                  |
| err_msg    | String  | Error message if cancellation failed |

## Response Example

```json
{
  "order_id": "596476148997685805",
  "client_oid": null,
  "result": true,
  "err_msg": null
}
```
