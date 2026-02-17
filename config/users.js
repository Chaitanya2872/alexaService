// config/users.js
// Replace with DB connection later

module.exports = [
  {
    id: "user1",
    name: "John Doe",
    email: "john@example.com",
    passwordHash: bcrypt.hashSync('password123', 8) // Use bcrypt in production
  },
  {
    id: "user2",
    name: "Alice Smith",
    email: "alice@example.com",
    passwordHash: bcrypt.hashSync('password123', 8)
  }
];