# Fill Channel

## Description

Subscribe to trade details information

## Request Parameters

| Parameter | Type   | Required | Description                           |
| --------- | ------ | -------- | ------------------------------------- |
| event     | String | Yes      | Operation: `subscribe`, `unsubscribe` |
| channel   | String | Yes      | Channel name                          |

## Request Example

```json
{
  "event": "subscribe",
  "channel": "fill"
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
  "channel": "fill"
}
```

## Push Data Parameters

| Field                | Type   | Description                                                                      |
| -------------------- | ------ | -------------------------------------------------------------------------------- |
| id                   | String | Unique identifier                                                                |
| coinId               | String | Collateral currency ID                                                           |
| contractId           | String | Contract ID                                                                      |
| orderId              | String | Order ID                                                                         |
| marginMode           | String | Margin mode                                                                      |
| separatedMode        | String | Position separation mode                                                         |
| separatedOpenOrderId | String | Separated position creation order ID (exists only when separated_mode=SEPARATED) |
| positionSide         | String | Position direction (always UNKNOWN for one-way positions)                        |
| orderSide            | String | Buy/Sell direction                                                               |
| fillSize             | String | Actual filled quantity                                                           |
| fillValue            | String | Actual filled value                                                              |
| fillFee              | String | Actual transaction fee (precise value)                                           |
| liquidateFee         | String | Liquidation fee (if trade is a liquidation)                                      |
| realizePnl           | String | Realized profit/loss (only appears for closing trades)                           |
| direction            | String | Execution direction (MAKER/TAKER)                                                |
| createdTime          | String | Creation timestamp                                                               |
| updatedTime          | String | Update timestamp                                                                 |

## Push Response Example

```json
{
  "type": "trade-event",
  "channel": "fill",
  "event": "payload",
  "msg": {
    "msgEvent": "OrderUpdate",
    "version": 46655,
    "data": {
      "orderFillTransaction": [
        {
          "id": "617414920887075482",
          "coinId": "USDT",
          "contractId": "cmt_btcusdt",
          "orderId": "617414920861909658",
          "marginMode": "SHARED",
          "separatedMode": "COMBINED",
          "separatedOpenOrderId": "0",
          "positionSide": "LONG",
          "orderSide": "BUY",
          "fillSize": "0.10000",
          "fillValue": "10381.270000",
          "fillFee": "6.228762",
          "liquidateFee": "0",
          "realizePnl": "0",
          "direction": "TAKER",
          "createdTime": "1747203188154",
          "updatedTime": "1747203188154"
        }
      ]
    },
    "time": 1747203188154
  }
}
```
