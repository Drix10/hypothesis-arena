# Depth Channel

## Description

Retrieves order book depth data. Upon successful subscription, a full snapshot will be pushed initially (depthType=SNAPSHOT), followed by incremental updates (depthType=CHANGED).

## Request Parameters

| Parameter | Type   | Required | Description                                                                        |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------- |
| event     | String | Yes      | Operation: `subscribe` / `unsubscribe`                                             |
| channel   | String | Yes      | Channel name. Format: `depth.{contractId}.{depth}` Example: `depth.cmt_btcusdt.15` |

### Depth Parameters

| Value | Description |
| ----- | ----------- |
| 15    | 15 levels   |
| 200   | 200 levels  |

## Request Example

```json
{
  "event": "subscribe",
  "channel": "depth.cmt_btcusdt.15"
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
  "channel": "depth.cmt_btcusdt.15"
}
```

## Push Data Parameters

| Field               | Type   | Description                 |
| ------------------- | ------ | --------------------------- |
| event               | String | Push action                 |
| channel             | String | Channel name                |
| data                | List   | Subscribed data             |
| data[].startVersion | String | Starting order book version |
| data[].endVersion   | String | Ending order book version   |
| data[].level        | String | Depth level                 |
| data[].depthType    | String | Order book depth type       |
| data[].symbol       | String | Product ID                  |
| data[].asks         | String | Ask list                    |
| data[].asks[].price | String | Price level                 |
| data[].asks[].size  | String | Quantity at price level     |
| data[].bids         | String | Bid list                    |
| data[].bids[].price | String | Price level                 |
| data[].bids[].size  | String | Quantity at price level     |

## Push Data Example

```json
{
  "event": "payload",
  "channel": "depth.cmt_btcusdt.15",
  "data": [
    {
      "startVersion": "3644174246",
      "endVersion": "3644174270",
      "level": 15,
      "depthType": "CHANGED",
      "symbol": "cmt_btcusdt",
      "asks": [
        {
          "price": "103436.1",
          "size": "0.91500"
        },
        {
          "price": "103436.3",
          "size": "1.95800"
        },
        {
          "price": "103436.5",
          "size": "0"
        },
        {
          "price": "103436.6",
          "size": "1.08300"
        },
        {
          "price": "103436.7",
          "size": "7.64700"
        },
        {
          "price": "103436.9",
          "size": "7.23100"
        },
        {
          "price": "103437.0",
          "size": "0"
        },
        {
          "price": "103437.2",
          "size": "0"
        }
      ],
      "bids": [
        {
          "price": "103435.9",
          "size": "2.40500"
        },
        {
          "price": "103435.7",
          "size": "0"
        },
        {
          "price": "103435.6",
          "size": "0.32700"
        },
        {
          "price": "103435.5",
          "size": "0"
        },
        {
          "price": "103435.2",
          "size": "3.19400"
        },
        {
          "price": "103434.8",
          "size": "10.25000"
        },
        {
          "price": "103434.5",
          "size": "11.13900"
        }
      ]
    }
  ]
}
```
