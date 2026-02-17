const users = require('../config/users');
const jwt = require('../utils/jwt');

exports.handleUserInfo = (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send('No token');

  const token = authHeader.split(' ')[1];
  const userId = jwt.verifyToken(token);
  if (!userId) return res.status(403).send('Invalid token');


  const user = users.find(u => u.id === userId);
  res.json({ id: user.id, email: user.email, name: user.name });
  

};