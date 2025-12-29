# Public Trade Channel

## Description

Platform trade channel (taker orders)

## Request Parameters

| Parameter | Type   | Required | Description                                         |
| --------- | ------ | -------- | --------------------------------------------------- |
| event     | String | Yes      | Operation: `subscribe`, `unsubscribe`               |
| channel   | String | Yes      | Channel name. Product ID e.g., `trades.cmt_btcusdt` |

## Request Example

```json
{
  "event": "subscribe",
  "channel": "trades.cmt_btcusdt"
}
```

## Response Parameters

| Field   | Type   | Description                             |
| ------- | ------ | --------------------------------------- |
| event   | String | Operation: `subscribed`, `unsubscribed` |
| channel | String | Channel name                            |

## Subscription Response Example

```json
{
  "event": "subscribed",
  "channel": "trades.cmt_btcusdt"
}
```

## Push Data Parameters

| Field             | Type   | Description                     |
| ----------------- | ------ | ------------------------------- |
| event             | String | Push data action                |
| channel           | String | Channel name                    |
| data              | List   | Subscribed data                 |
| data[].time       | String | Trade time                      |
| data[].price      | String | Trade price                     |
| data[].size       | String | Trade quantity                  |
| data[].value      | String | Trade amount                    |
| data[].buyerMaker | String | Market flag (internal/external) |

## Push Response Example

```json
{
  "event": "payload",
  "channel": "trades.cmt_btcusdt",
  "data": [
    {
      "time": "1747131727502",
      "price": "103337.5",
      "size": "0.01600",
      "value": "1653.400000",
      "buyerMaker": false
    }
  ]
}
```
