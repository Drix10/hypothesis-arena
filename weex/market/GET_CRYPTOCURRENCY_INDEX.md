# Get Cryptocurrency Index

## Endpoint

`GET /capi/v2/market/index`

## Weight

**IP**: 1

## Request Parameters

| Parameter | Type   | Required? | Description                                           |
| --------- | ------ | --------- | ----------------------------------------------------- |
| symbol    | String | Yes       | Trading pair                                          |
| priceType | String | No        | Price Type : MARK mark; INDEX index; INDEX by default |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/market/index?symbol=cmt_bchusdt&priceType=INDEX"
```

## Response Parameters

| Parameter | Type   | Description                          |
| --------- | ------ | ------------------------------------ |
| symbol    | String | Trading pair                         |
| index     | String | Index                                |
| timestamp | String | Timestamp Unix millisecond timestamp |

## Response Example

```json
{
  "symbol": "cmt_btcusdt",
  "index": "333.627857143",
  "timestamp": "1716604853286"
}
```
