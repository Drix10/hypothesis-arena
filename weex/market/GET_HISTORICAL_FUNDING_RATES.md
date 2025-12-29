# Get Historical Funding Rates

## Endpoint

`GET /capi/v2/market/getHistoryFundRate`

## Weight

**IP**: 5

## Request Parameters

| Parameter | Type    | Required? | Description                                                     |
| --------- | ------- | --------- | --------------------------------------------------------------- |
| symbol    | String  | Yes       | Trading pair                                                    |
| limit     | Integer | No        | The size of the data ranges from 1 to 100, with a default of 10 |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/market/getHistoryFundRate?symbol=cmt_bchusdt&limit=100"
```

## Response Parameters

| Parameter   | Type   | Description                                            |
| ----------- | ------ | ------------------------------------------------------ |
| symbol      | String | Trading pair                                           |
| fundingRate | String | Funding rate                                           |
| fundingTime | Long   | Funding fee settlement time Unix millisecond timestamp |

## Response Example

```json
[
  {
    "symbol": "cmt_btcusdt",
    "fundingRate": "0.0001028",
    "fundingTime": 1716595200000
  }
]
```
