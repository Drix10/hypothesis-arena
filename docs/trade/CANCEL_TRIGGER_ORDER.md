# Cancel Trigger Order

## Endpoint

`POST /capi/v2/order/cancel_plan`

## Weight

**IP**: 2  
**UID**: 3

## Request Parameters

| Parameter | Type   | Required? | Description |
| --------- | ------ | --------- | ----------- |
| orderId   | String | Yes       | Order ID    |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/cancel_plan" \
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

| Parameter  | Type    | Description                              |
| ---------- | ------- | ---------------------------------------- |
| order_id   | String  | Order ID                                 |
| client_oid | String  | Client identifier                        |
| result     | Boolean | Whether the cancellation was successful  |
| err_msg    | String  | Error message if the cancellation failed |

## Response Example

```json
{
  "order_id": "596480271352594989",
  "client_oid": null,
  "result": true,
  "err_msg": null
}
```
