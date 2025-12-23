# Change Leverage

## Endpoint

`POST /capi/v2/account/leverage`

## Weight

**IP**: 10  
**UID**: 20

## Request Parameters

| Parameter     | Type    | Required? | Description                                                                                                   |
| ------------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| symbol        | String  | Yes       | Trading pair                                                                                                  |
| marginMode    | Integer | Yes       | Margin mode: `1` = Cross Mode, `3` = Isolated Mode. The marginMode must be set to the account's current mode. |
| longLeverage  | String  | Yes       | Long position leverage. In Cross Mode, must be identical to shortLeverage.                                    |
| shortLeverage | String  | Yes       | Short position leverage. In Cross Mode, must be identical to longLeverage.                                    |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/account/leverage" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "cmt_bchusdt",
    "marginMode": 1,
    "longLeverage": "2"
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
