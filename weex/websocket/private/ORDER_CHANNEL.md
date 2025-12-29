# Order Channel

## Description

Subscribe to order channel

## Request Parameters

| Parameter | Type   | Required | Description                           |
| --------- | ------ | -------- | ------------------------------------- |
| event     | String | Yes      | Operation: `subscribe`, `unsubscribe` |
| channel   | String | Yes      | Channel name                          |

## Request Example

```json
{
  "event": "subscribe",
  "channel": "orders"
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
  "channel": "orders"
}
```

## Push Data Parameters

| Field                 | Type   | Description                                                                                                                      |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| id                    | String | Order ID (value > 0)                                                                                                             |
| coinId                | String | Collateral currency ID                                                                                                           |
| contractId            | String | Contract ID                                                                                                                      |
| marginMode            | String | Margin mode                                                                                                                      |
| separatedMode         | String | Position separation mode                                                                                                         |
| separatedOpenOrderId  | String | Separated position creation order ID (exists only when separated_mode=SEPARATED)                                                 |
| positionSide          | String | Position direction (always UNKNOWN for one-way positions)                                                                        |
| orderSide             | String | Buy/Sell direction                                                                                                               |
| price                 | String | Order price (worst acceptable price)                                                                                             |
| size                  | String | Order quantity                                                                                                                   |
| clientOrderId         | String | Client custom ID for idempotency check                                                                                           |
| type                  | String | Order type                                                                                                                       |
| timeInForce           | String | Order execution strategy (meaningful when type is LIMIT/STOP_LIMIT/TAKE_PROFIT_LIMIT)                                            |
| reduceOnly            | String | Whether reduce-only order                                                                                                        |
| triggerPrice          | String | Trigger price (meaningful for STOP_LIMIT/STOP_MARKET/TAKE_PROFIT_LIMIT/TAKE_PROFIT_MARKET orders, 0 means empty)                 |
| triggerPriceType      | String | Price type: last price [default], mark price (meaningful for STOP_LIMIT/STOP_MARKET/TAKE_PROFIT_LIMIT/TAKE_PROFIT_MARKET orders) |
| isPositionTpsl        | String | Whether position take-profit/stop-loss order                                                                                     |
| orderSource           | String | Order source                                                                                                                     |
| openTpslParentOrderId | String | Opening order ID for position take-profit/stop-loss orders                                                                       |
| isSetOpenTp           | String | Whether set open take-profit                                                                                                     |
| openTpParam           | String | Open take-profit parameters                                                                                                      |
| isSetOpenSl           | String | Whether set open stop-loss                                                                                                       |
| openSlParam           | String | Open stop-loss parameters                                                                                                        |
| leverage              | String | Leverage multiplier when opening position                                                                                        |
| takerFeeRate          | String | Taker fee rate when placing order                                                                                                |
| makerFeeRate          | String | Maker fee rate when placing order                                                                                                |
| feeDiscount           | String | Fee discount rate when placing order                                                                                             |
| liquidateFeeRate      | String | Liquidation fee rate when placing order                                                                                          |
| status                | String | Order status                                                                                                                     |
| triggerTime           | String | Conditional order trigger time                                                                                                   |
| triggerPriceTime      | String | Conditional order trigger price time                                                                                             |
| triggerPriceValue     | String | Conditional order trigger price value                                                                                            |
| cancelReason          | String | Order cancellation reason                                                                                                        |
| latestFillPrice       | String | Latest filled price of current order                                                                                             |
| maxFillPrice          | String | Highest filled price of current order                                                                                            |
| minFillPrice          | String | Lowest filled price of current order                                                                                             |
| cumFillSize           | String | Cumulative filled quantity after matching                                                                                        |
| cumFillValue          | String | Cumulative filled value after matching                                                                                           |
| cumFillFee            | String | Cumulative transaction fee after matching                                                                                        |
| cumLiquidateFee       | String | Cumulative liquidation fee                                                                                                       |
| cumRealizePnl         | String | Cumulative realized profit/loss                                                                                                  |
| createdTime           | String | Creation time                                                                                                                    |
| updatedTime           | String | Update time                                                                                                                      |

## Push Response Example

```json
{
  "type": "trade-event",
  "channel": "orders",
  "event": "payload",
  "msg": {
    "msgEvent": "OrderUpdate",
    "version": 46654,
    "data": {
      "order": [
        {
          "id": "617414920861909658",
          "coinId": "USDT",
          "contractId": "cmt_btcusdt",
          "marginMode": "SHARED",
          "separatedMode": "COMBINED",
          "separatedOpenOrderId": "0",
          "positionSide": "LONG",
          "orderSide": "BUY",
          "price": "0.0",
          "size": "0.10000",
          "clientOrderId": "1747203186927fpiZrpAEkOlH3ygdwfJpowP0HeXVer7JFxxmIohyCMPXqKCz74s",
          "type": "MARKET",
          "timeInForce": "IMMEDIATE_OR_CANCEL",
          "reduceOnly": false,
          "triggerPrice": "0",
          "triggerPriceType": "UNKNOWN_PRICE_TYPE",
          "orderSource": "WEB",
          "openTpslParentOrderId": "0",
          "leverage": "20",
          "takerFeeRate": "0.0006",
          "makerFeeRate": "0.0002",
          "feeDiscount": "1",
          "liquidateFeeRate": "0.01",
          "status": "PENDING",
          "triggerTime": "0",
          "triggerPriceTime": "0",
          "triggerPriceValue": "0",
          "cancelReason": "UNKNOWN_ORDER_CANCEL_REASON",
          "latestFillPrice": "0",
          "maxFillPrice": "0",
          "minFillPrice": "0",
          "cumFillSize": "0",
          "cumFillValue": "0",
          "cumFillFee": "0",
          "cumLiquidateFee": "0",
          "cumRealizePnl": "0",
          "createdTime": "1747203188148",
          "updatedTime": "1747203188148",
          "positionTpsl": false,
          "setOpenTp": false,
          "setOpenSl": false
        }
      ]
    },
    "time": 1747203188148
  }
}
```
