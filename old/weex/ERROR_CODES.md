# Error Code Examples

All APIs may return exceptions. The following are possible error codes returned by the API.

## Error Codes

| Error Message                                       | Error Code | HTTP Status Code |
| --------------------------------------------------- | ---------- | ---------------- |
| Header "ACCESS_KEY" is required                     | 40001      | 400              |
| Header "ACCESS_SIGN" is required                    | 40002      | 400              |
| Header "ACCESS_TIMESTAMP" is required               | 40003      | 400              |
| Invalid ACCESS_TIMESTAMP                            | 40005      | 400              |
| Invalid ACCESS_KEY                                  | 40006      | 400              |
| Invalid Content_Type, use "application/json" format | 40007      | 400              |
| Request timestamp expired                           | 40008      | 400              |
| API verification failed                             | 40009      | 400              |
| Too many requests                                   | 429        | 429              |
| Header "ACCESS_PASSPHRASE" is required              | 40011      | 400              |
| Incorrect API key/Passphrase                        | 40012      | 400              |
| Account frozen                                      | 40013      | 400              |
| Invalid permissions                                 | 40014      | 400              |
| System error                                        | 40015      | 400              |
| Parameter validation failed                         | 40017      | 400              |
| Invalid IP request                                  | 40018      | 400              |
| Parameter cannot be empty                           | 40019      | 400              |
| Parameter is invalid                                | 40020      | 400              |
| API permission disabled                             | 40753      | 400              |
| Insufficient permissions for this operation         | 40022      | 403              |
| Not have permission to trade this pair.             | 50003      | 400              |
| Not have permission to access this API.             | 50004      | 400              |
| Order does not exist                                | 50005      | 400              |
| Leverage cannot exceed the limit                    | 50007      | 400              |

## Error Response Format

All errors return a JSON response in the following format:

```json
{
  "code": "error code",
  "msg": "error description",
  "requestTime": 1765776384556,
  "data": null
}
```

## Example 1: Parameter Error

```json
{
  "code": "40020",
  "msg": "Parameter symbol is invalid",
  "requestTime": 1765776928145,
  "data": null
}
```
