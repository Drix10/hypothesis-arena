# Get OrderBook Depth

## Endpoint

`GET /capi/v2/market/depth`

## Weight

**IP**: 1

## Request Parameters

| Parameter | Parameter Type | Required? | Description                                                  |
| --------- | -------------- | --------- | ------------------------------------------------------------ |
| symbol    | String         | Yes       | Trading pair                                                 |
| limit     | Integer        | No        | Fixed gear enumeration value: 15/200, the default gear is 15 |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/market/depth?symbol=cmt_btcusdt&limit=15"
```

## Response Parameters

| Parameter | Type   | Description                                                                       |
| --------- | ------ | --------------------------------------------------------------------------------- |
| asks      | List   | Sell side depth data Format: [price, quantity] where quantity is in base currency |
| asks[0]   | String | Price                                                                             |
| asks[1]   | String | Quantity                                                                          |
| bids      | List   | Buy side depth data Format: [price, quantity] where quantity is in base currency  |
| bids[0]   | String | Price                                                                             |
| bids[1]   | String | Quantity                                                                          |
| timestamp | String | Timestamp Unix millisecond timestamp                                              |

## Response Example

```json
{
  "asks": [["8858.0", "19299"]],
  "bids": [
    ["7466.0", "499"],
    ["4995.0", "12500"]
  ],
  "timestamp": "1591237821479"
}
```
