# Get Historical Candlestick

## Description

Query all historical K-line data and return a maximum of 100 pieces of data. When either startTime or endTime is invalid, the K-line data for the latest time period will be returned. When both startTime and endTime are provided, the endTime will take precedence and the startTime will be ignored.

## Endpoint

`GET /capi/v2/market/historyCandles`

## Weight

**IP**: 5

## Request Parameters

| Parameter   | Type    | Required? | Description                                                                       |
| ----------- | ------- | --------- | --------------------------------------------------------------------------------- |
| symbol      | String  | Yes       | Trading pair                                                                      |
| granularity | String  | Yes       | Candlestick interval [1m,5m,15m,30m,1h,4h,12h,1d,1w]                              |
| startTime   | Long    | No        | The start time is to query the k-lines after this time Unix millisecond timestamp |
| endTime     | Long    | No        | The end time is to query the k-lines before this time Unix millisecond timestamp  |
| limit       | Integer | No        | The size of the data ranges from 1 to 100, with a default of 100                  |
| priceType   | String  | No        | Price Type : LAST latest market price; MARK mark; INDEX index; LAST by default    |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/market/historyCandles?symbol=cmt_bchusdt&granularity=1m"
```

## Response Parameters

| Index | Type   | Description                                 |
| ----- | ------ | ------------------------------------------- |
| [0]   | String | Candlestick time Unix millisecond timestamp |
| [1]   | String | Opening price                               |
| [2]   | String | Highest price                               |
| [3]   | String | Lowest price                                |
| [4]   | String | Closing price                               |
| [5]   | String | Trading volume of the base coin             |
| [6]   | String | Trading volume of quote currency            |

## Response Example

```json
[["1716707460000", "69174.3", "69174.4", "69174.1", "69174.3", "0", "0.011"]]
```
