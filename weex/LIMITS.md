# Limits

API keys have rate limits. Exceeding them returns error 429: Too many requests.

## Rate Limiting Units

The account is used as the basic unit of speed limit for the endpoints that need to carry an API key. For endpoints that do not need to carry an API key, IP addresses are used as the basic unit of rate limiting.

## Limits Description

- IP-based and UID-based limits operate independently
- Each endpoint indicates whether it follows IP or UID limits, along with its weight value
- Endpoints with IP limits have an independent limit of 1000 requests per 10 seconds
- Endpoints with UID limits also have an independent limit of 1000 requests per 10 seconds

## Special Interface Description

The interfaces for Place Order, Cancel Order, Place Trigger Order, and Cancel Trigger Order are limited to a maximum of 10 requests per second.

## Limits Error

When a 429 error occurs, make sure to stop sending excessive requests.
