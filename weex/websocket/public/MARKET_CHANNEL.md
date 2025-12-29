# Market Channel

## Description

Retrieves real-time market data including latest price, best bid/ask prices, and 24-hour trading volume. Updates occur within 100-300ms when changes occur (trades, bid/ask updates).

## Request Parameters

| Parameter | Type   | Required | Description                                                               |
| --------- | ------ | -------- | ------------------------------------------------------------------------- |
| event     | String | Yes      | Operation: `subscribe` / `unsubscribe`                                    |
| channel   | String | Yes      | Channel name. Format: `ticker.{contractId}` Example: `ticker.cmt_btcusdt` |

## Request Example

```json
{
  "event": "subscribe",
  "channel": "ticker.cmt_btcusdt"
}
```

## Response Parameters

| Field   | Type   | Description                              |
| ------- | ------ | ---------------------------------------- |
| event   | String | Operation: `subscribed` / `unsubscribed` |
| channel | String | Channel name (e.g. `ticker.cmt_btcusdt`) |

## Subscription Response Example

```json
{
  "event": "subscribed",
  "channel": "ticker.cmt_btcusdt"
}
```

## Push Data Parameters

| Field                     | Type   | Description                              |
| ------------------------- | ------ | ---------------------------------------- |
| event                     | String | Push action                              |
| channel                   | String | Channel name (e.g. `ticker.cmt_btcusdt`) |
| data                      | List   | Market data array                        |
| data[].symbol             | String | Product ID                               |
| data[].priceChange        | String | Price change amount                      |
| data[].priceChangePercent | String | Price change percentage                  |
| data[].trades             | String | 24h trade count                          |
| data[].size               | String | 24h trading volume                       |
| data[].value              | String | 24h trading value                        |
| data[].high               | String | 24h highest price                        |
| data[].low                | String | 24h lowest price                         |
| data[].lastPrice          | String | Latest traded price                      |
| data[].markPrice          | String | Current mark price                       |

## Push Data Example

```json
{
  "event": "payload",
  "channel": "ticker.cmt_btcusdt",
  "data": [
    {
      "symbol": "cmt_btcusdt",
      "priceChange": "-2055.6",
      "priceChangePercent": "-0.019637",
      "trades": "28941",
      "size": "176145.66489",
      "value": "18115688543.1",
      "high": "104692.2",
      "low": "100709.6",
      "lastPrice": "102623.9",
      "markPrice": "102623.9"
    }
  ]
}
```
