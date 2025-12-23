# Standard Specifications

## Timestamp

The ACCESS-TIMESTAMP in request signatures is in milliseconds.

Requests are rejected if the timestamp deviates by over 30 seconds from the API server time. If the local server time deviates significantly from the API server time, we recommend updating the HTTP header by querying the API server time.

## Request Formats

Only two request methods are supported: GET and POST

### GET

Parameters are sent via queryString in the path to the server.

### POST

Parameters are sent as a JSON-formatted body to the server.
