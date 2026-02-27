# API Usage Documentation

The below documentation outlines the API usage for Login, Device Control, and Device Listing.

## 1. Login API

This endpoint authenticates a user using their email (or phone number) and password.

**Endpoint:** `POST /auth/identity/strategy/basic/signin`

**Request Headers:**

- `Content-Type`: `application/json`

**Request Body:**

| Parameter           | Type   | Required | Description                                    |
| ------------------- | ------ | :------: | ---------------------------------------------- |
| `email`             | String |  Yes\*   | User's email address. (\*Required if no phone) |
| `phoneNumber`       | String |  Yes\*   | User's phone number. (\*Required if no email)  |
| `password`          | String |   Yes    | User's password.                               |
| `notificationToken` | String |    No    | Expo push token for mobile notifications.      |

**Response (Success - 200 OK):**

Returns user account details and sets an `auth.token` httpOnly cookie.

```json
{
	"message": "Authentication Successful",
	"data": {
		"id": "account_uuid",
		"phoneNumber": "1234567890",
		"email": "user@example.com",
		"createdAt": "2023-01-01T00:00:00.000Z",
		"name": "User Name",
		"projectId": "project_uuid",
		"activeProjectId": "active_project_uuid",
		"emailVerified": true,
		"profilePicture": "https://..."
	}
}
```

---

## 2. Device Control API

This endpoint triggers an action on a specific device using a command utterance (e.g., "turn on", "dim to 50%").

**Endpoint:** `POST /api/server/trigger/device`

**Request Headers:**

- `Content-Type`: `application/json`
- `Authorization`: `Bearer <token>` (Handled via cookie or header)

**Request Body:**

| Parameter   | Type   | Required | Description                                                 |
| ----------- | ------ | :------: | ----------------------------------------------------------- |
| `deviceId`  | String |   Yes    | The ID of the device to control.                            |
| `utterence` | String |   Yes    | The command to execute (e.g., "turn on", "set cool white"). |
| `params`    | Object |    No    | Additional parameters for the command (JSON object).        |

**Response (Success - 200 OK):**

```json
{
	"status": "success",
	"data": {
		// Response from the downstream control service
	}
}
```

---

## 3. List of Devices API

This endpoint retrieves the entire project structure, including all Spaces, Floors, Rooms, and Devices.

**Endpoint:** `POST /api/server/read/spaces`

**Request Headers:**

- `Content-Type`: `application/json`
- `Authorization`: `Bearer <token>`

**Request Body:**

| Parameter         | Type    | Required | Description                                                        |
| ----------------- | ------- | :------: | ------------------------------------------------------------------ |
| `spaceId`         | String  |    No    | Filter by specific Space ID.                                       |
| `floorId`         | String  |    No    | Filter by specific Floor ID.                                       |
| `roomId`          | String  |    No    | Filter by specific Room ID.                                        |
| `projectId`       | String  |    No    | Filter by specific Project ID (defaults to user's active project). |
| `useOwnerProject` | Boolean |    No    | If true, forces use of the account's own project ID.               |

**Response (Success - 200 OK):**

Returns a comprehensive object containing normalized collections of all entities.

```json
{
  "status": 200,
  "message": "Space data retrieved successfully",
  "data": {
    "project": {
      "id": "project_uuid",
      "name": "My Project",
      "displayName": "User's Project"
    },
    "spaces": {
      "space_uuid": { "id": "space_uuid", "name": "Home", ... }
    },
    "floors": {
      "floor_uuid": { "id": "floor_uuid", "name": "Ground Floor", ... }
    },
    "rooms": {
      "room_uuid": { "id": "room_uuid", "name": "Living Room", ... }
    },
    "devices": {
      "device_uuid": {
        "id": "device_uuid",
        "name": "Living Room Light",
        "metadata": { "type": "Light", ... },
        "status": "ONLINE"
      }
    },
    "switches": {
      "switch_uuid": { ... }
    },
    "scenes": {
      "scene_uuid": { ... }
    }
  },
  "activeSpace": "space_uuid",
  "activeFloor": null,
  "activeRoom": null
}
```

---

## 4. Change Active Project API

This endpoint switches the user's active project context.

**Endpoint:** `POST /api/user/project/active/:accountId`

**Request Headers:**

- `Content-Type`: `application/json`
- `Authorization`: `Bearer <token>`

**URL Parameters:**

- `accountId`: The ID of the account to switch the project for.

**Request Body:**

| Parameter   | Type   | Required | Description                         |
| ----------- | ------ | :------: | ----------------------------------- |
| `projectId` | String |   Yes    | The ID of the project to switch to. |

**Response (Success - 200 OK):**

Returns the updated account status and access context.

```json
{
	"data": {
		"account": {
			"id": "account_uuid"
			// ... other account fields
		},
		"accessContext": {
			// ... Lighthouse access context details
		},
		"isSecondary": false // or true
	},
	"message": "Active Project for Account <account_uuid> set to <project_uuid>"
}
```
