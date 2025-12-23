# Candlestick Channel

## Description

Order K-line channel

## Request Parameters

| Parameter | Type   | Required | Description                                                                                                        |
| --------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| event     | String | Yes      | Operation: `subscribe` / `unsubscribe`                                                                             |
| channel   | String | Yes      | Channel name. Format: `kline.{priceType}.{contractId}.{interval}` Example: `kline.LAST_PRICE.cmt_btcusdt.MINUTE_1` |

### Price Type Parameters

| Value      | Description         |
| ---------- | ------------------- |
| LAST_PRICE | Latest price K-line |
| MARK_PRICE | Mark price K-line   |

### Interval Parameters

| Value     | Description |
| --------- | ----------- |
| MINUTE_1  | 1-minute    |
| MINUTE_5  | 5-minute    |
| MINUTE_15 | 15-minute   |
| MINUTE_30 | 30-minute   |
| HOUR_1    | 1-hour      |
| HOUR_2    | 2-hour      |
| HOUR_4    | 4-hour      |
| HOUR_6    | 6-hour      |
| HOUR_8    | 8-hour      |
| HOUR_12   | 12-hour     |
| DAY_1     | Daily       |
| WEEK_1    | Weekly      |
| MONTH_1   | Monthly     |

## Request Example

```json
{
  "event": "subscribe",
  "channel": "kline.LAST_PRICE.cmt_btcusdt.MINUTE_1"
}
```

## Response Parameters

| Field   | Type   | Description                              |
| ------- | ------ | ---------------------------------------- |
| event   | String | Operation: `subscribed` / `unsubscribed` |
| channel | String | Channel name                             |

## Subscription Response Example

```json
{
  "event": "subscribed",
  "channel": "kline.LAST_PRICE.cmt_btcusdt.MINUTE_1"
}
```

## Push Data Parameters

| Field            | Type   | Description                                     |
| ---------------- | ------ | ----------------------------------------------- |
| event            | String | Push action                                     |
| type             | String | Type: `change` (incremental), `snapshot` (full) |
| channel          | String | Channel name                                    |
| data             | List   | Subscribed data                                 |
| data[].symbol    | String | Product ID                                      |
| data[].klineTime | String | K-line timestamp                                |
| data[].size      | String | Trading volume                                  |
| data[].value     | String | Trading amount                                  |
| data[].high      | String | Highest price                                   |
| data[].low       | String | Lowest price                                    |
| data[].open      | String | Opening price                                   |
| data[].close     | String | Closing price                                   |

## Push Data Example

```json
{
  "event": "payload",
  "type": "change",
  "channel": "kline.LAST_PRICE.cmt_btcusdt.MINUTE_1",
  "data": [
    {
      "symbol": "cmt_btcusdt",
      "klineTime": "1747125660000",
      "size": "23.76600",
      "value": "2442678.713400",
      "high": "102784.6",
      "low": "102760.6",
      "open": "102760.6",
      "close": "102764.0"
    }
  ]
}
```
