# Adjust Position Margin

## Endpoint

`POST /capi/v2/account/adjustMargin`

## Weight

**IP**: 15  
**UID**: 30

## Request Parameters

| Parameter          | Type    | Required? | Description                                                             |
| ------------------ | ------- | --------- | ----------------------------------------------------------------------- |
| coinId             | Integer | No        | Collateral ID. Basic Crypto Information. Default is 2 (USDT)            |
| isolatedPositionId | Long    | Yes       | Isolated margin position ID. Get the isolatedPositionId                 |
| collateralAmount   | String  | Yes       | Collateral amount. Positive means increase, and negative means decrease |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/account/adjustMargin" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "coinId": 2,
    "isolatedPositionId": 1,
    "collateralAmount": "10"
  }'
```

## Response Parameters

| Parameter   | Type   | Description                          |
| ----------- | ------ | ------------------------------------ |
| msg         | String | Response message                     |
| requestTime | String | Timestamp Unix millisecond timestamp |
| code        | String | Response code                        |

## Response Example

```json
{
  "msg": "success",
  "requestTime": 1713339011237,
  "code": "200"
}
```
