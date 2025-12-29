# Batch Cancel Orders

## Endpoint

`POST /capi/v2/order/cancel_batch_orders`

## Weight

**IP**: 5  
**UID**: 10

## Request Parameters

| Parameter | Type     | Required? | Description                                     |
| --------- | -------- | --------- | ----------------------------------------------- |
| ids       | String[] | No        | Either Order ID or cids is required.            |
| cids      | String[] | No        | Either Client customized ID or ids is required. |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/cancel_batch_orders" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["596471064624628269"]
  }'
```

## Response Parameters

| Parameter             | Type                    | Description                         |
| --------------------- | ----------------------- | ----------------------------------- |
| result                | Boolean                 | Processing result (success/failure) |
| orderIds              | List<String>            | List of order IDs to be cancelled   |
| clientOids            | List<String>            | List of client order IDs            |
| cancelOrderResultList | List<CancelOrderResult> | List of cancellation results        |
| failInfos             | List<CancelOrderResult> | List of failed cancellation info    |

### CancelOrderResult Fields

| Parameter  | Type    | Description                          |
| ---------- | ------- | ------------------------------------ |
| err_msg    | String  | Error message if cancellation failed |
| order_id   | String  | Order ID                             |
| client_oid | String  | Client order ID                      |
| result     | Boolean | Whether cancellation succeeded       |

## Response Example

```json
{
  "result": true,
  "orderIds": ["596471064624628269"],
  "clientOids": [],
  "cancelOrderResultList": [
    {
      "err_msg": "",
      "order_id": "596471064624628269",
      "client_oid": "",
      "result": true
    }
  ],
  "failInfos": []
}
```
