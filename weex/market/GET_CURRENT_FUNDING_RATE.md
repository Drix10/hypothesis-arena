# Get Current Funding Rate

## Endpoint

`GET /capi/v2/market/currentFundRate`

## Weight

**IP**: 1

## Request Parameters

| Parameter | Type   | Required? | Description  |
| --------- | ------ | --------- | ------------ |
| symbol    | String | No        | Trading pair |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/market/currentFundRate?symbol=cmt_bchusdt"
```

## Response Parameters

| Parameter    | Type   | Description                                            |
| ------------ | ------ | ------------------------------------------------------ |
| symbol       | String | Trading pair                                           |
| fundingRate  | String | Current funding rates                                  |
| collectCycle | Long   | Funding rate settlement cycle Unit: minute             |
| timestamp    | Long   | Funding fee settlement time Unix millisecond timestamp |

## Response Example

```json
[
  {
    "symbol": "cmt_btcusdt",
    "fundingRate": "-0.0001036",
    "collectCycle": 480,
    "timestamp": 1750383726052
  }
]
```
