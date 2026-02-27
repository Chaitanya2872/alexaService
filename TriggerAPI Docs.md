`POST /api/server/trigger/device`

### Example request
```bash
curl -X POST "$API_URL/api/server/trigger/device" \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "x-project-id: <ACTIVE_PROJECT_ID>" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "dev_01HZX7K8Q9",
    "utterence": "set temperature to 24",
    "params": {
      "temperature": 24,
      "mode": "cool"
    }
  }'
```

### Request details
- Method: `POST`
- Auth: required (`Authorization: Bearer <token>`)
- Headers:
  - `x-project-id` optional but if present and mismatched => `401`
- Body:
  - `deviceId` (string, required)
  - `utterence` (string, required; note spelling is `utterence` in this API)
  - `params` (object, optional)

### Example success response (`200`)
This route returns the upstream action-service payload as-is, so fields can vary. Example:
```json
{
  "status": 200,
  "data": {
    "deviceId": "DEVICE ID",
    "action": "RESPONSE ACTION OBJECT",
    "accepted": true
  },
  "message": "Action triggered"
}
```

### Example error responses

`400` (missing `utterence`):
```json
{
  "data": null,
  "message": "Utterance is required",
  "error": {
    "status": 400,
    "code": 1100,
    "metadata": {}
  }
}
```

`401` (missing/invalid auth header):
```json
{
  "error": "Missing or invalid Authorization header"
}
```

`502` or upstream status (third-party/action-service failure):
```json
{
  "data": null,
  "message": "Failed to trigger device",
  "error": {
    "status": 502,
    "code": 1504,
    "metadata": {}
  }
}
```