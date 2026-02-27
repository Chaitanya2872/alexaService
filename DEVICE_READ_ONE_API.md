# Read One Device API Documentation

This document provides details on how to use the "Read One Device" API endpoint to fetch a single device's information.

## Overview

- **Description**: Retrieves the complete details of a specific device by its unique ID.
- **Method**: `GET`
- **Endpoint**: `/api/server/device/read/one/:deviceId`
- **Authentication**: Required (`Bearer <JWT>`)

## Request

### Path Parameters

| Parameter  | Type   | Required | Description                                            |
| ---------- | ------ | -------- | ------------------------------------------------------ |
| `deviceId` | string | Yes      | The unique identifier of the device you want to fetch. |

### Headers

| Header          | Type   | Required | Description                                                                           |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------- |
| `Authorization` | string | Yes      | Standard JWT bearer token required for authenticating the request (`Bearer <token>`). |

## Responses

### 200 OK (Success)

Successfully fetched the device. The endpoint will return a JSON object populated with the device's fields.

**Example Response:**

```json
{
	"id": "some-device-id-1234",
	"deviceName": "Main AC Unit",
	"deviceStatus": "ACTIVE",
	"connectionStatus": "ONLINE",
	"projectId": "project-id-5678",
	"locationId": "location-id",
	"metadata": {},
	"Components": [],
	"createdAt": "2023-10-01T12:00:00Z",
	"updatedAt": "2023-10-05T12:00:00Z"
}
```

### 401 Unauthorized

The JWT token is missing, expired, or invalid.

```json
{
	"message": "Unauthorized"
}
```

### 500 Internal Server Error

Returned if the `deviceId` does not exist or an unexpected failure happens while retrieving the document.

```json
{
	"message": "Failed to fetch Device",
	"code": "FAILED_TO_READ_DOCUMENT"
}
```

## Notes

- To test the endpoint locally, use a URL like `http://localhost:8000/api/server/device/read/one/<DEVICE_ID>`.
- Internal validation expects the user context to be tied to either `account.activeProjectId` or `account.projectId`, ensuring that access control is tightly integrated to the user context.
