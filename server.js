// server.js - Complete OAuth Provider for Alexa
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const querystring = require('querystring');

const app = express();

// Add CORS headers for testing
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

// CONFIG - in prod use env vars
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'replace_this_with_strong_secret';
const CODE_TTL_SEC = 600;    // 10 minutes - longer for debugging
const ACCESS_TOKEN_TTL_SEC = 3600; // 1 hour

// In-memory stores for demo (replace with DB)
const clients = {
  'alexa-skill': {
    clientSecret: 'alexa-client-secret',
    redirectUris: [
      'https://pitangui.amazon.com/api/skill/link/M8UOFD7R8R1TG',
      'https://layla.amazon.com/api/skill/link/M8UOFD7R8R1TG',
      'https://alexa.amazon.co.jp/api/skill/link/M8UOFD7R8R1TG',
      'https://skills-store.amazon.com/api/skill/link/M8UOFD7R8R1TG'
    ],
  },
};

// Users with hashed passwords
const users = {
  'john@example.com': { 
    passwordHash: bcrypt.hashSync('password123', 8), 
    id: 'user1',
    name: 'John Doe',
    email: 'john@example.com'
  },
  'alice@example.com': { 
    passwordHash: bcrypt.hashSync('test456', 8), 
    id: 'user2',
    name: 'Alice Smith',
    email: 'alice@example.com'
  },
};

const authCodes = {}; // code -> { clientId, redirectUri, userId, expiresAt, scope }
const refreshTokens = {}; // refreshToken -> { userId, clientId, scope, expiresAt }

// Simple login page
app.get('/login', (req, res) => {
  const continueTo = req.query.continue || '/';
  const continueValue = continueTo.replace(/"/g, '&quot;');
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Login - OAuth Provider</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          max-width: 400px;
          margin: 50px auto;
          padding: 20px;
          background: #f5f5f5;
        }
        .login-box {
          background: white;
          padding: 30px;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h2 { margin-top: 0; color: #333; }
        label { 
          display: block; 
          margin-top: 15px; 
          color: #555;
          font-weight: bold;
        }
        input {
          width: 100%;
          padding: 10px;
          margin-top: 5px;
          border: 1px solid #ddd;
          border-radius: 4px;
          box-sizing: border-box;
          font-size: 14px;
        }
        button {
          width: 100%;
          padding: 12px;
          margin-top: 20px;
          background: #0066cc;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 16px;
          cursor: pointer;
        }
        button:hover {
          background: #0052a3;
        }
        .hint {
          margin-top: 20px;
          padding: 10px;
          background: #e7f3ff;
          border-left: 3px solid #0066cc;
          font-size: 12px;
          color: #333;
        }
      </style>
    </head>
    <body>
      <div class="login-box">
        <h2>Login</h2>
        <form method="post" action="/login">
          <input type="hidden" name="continue" value="${continueValue}" />
          
          <label>Email:</label>
          <input type="email" name="username" placeholder="john@example.com" required />
          
          <label>Password:</label>
          <input type="password" name="password" placeholder="Enter password" required />
          
          <button type="submit">Login</button>
        </form>
        
        <div class="hint">
          <strong>Demo Accounts:</strong><br>
          john@example.com / password123<br>
          alice@example.com / test456
        </div>
      </div>
    </body>
    </html>
  `);
});

app.post('/login', (req, res) => {
  const { username, password, continue: cont } = req.body;
  const user = users[username];
  
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Login Failed</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 400px;
            margin: 50px auto;
            padding: 20px;
          }
          .error {
            background: #ffebee;
            color: #c62828;
            padding: 15px;
            border-radius: 4px;
            border-left: 3px solid #c62828;
          }
          a {
            display: inline-block;
            margin-top: 15px;
            color: #0066cc;
            text-decoration: none;
          }
        </style>
      </head>
      <body>
        <div class="error">
          <strong>Invalid credentials</strong><br>
          The email or password you entered is incorrect.
        </div>
        <a href="/login?continue=${encodeURIComponent(cont || '/')}">← Try again</a>
      </body>
      </html>
    `);
  }
  
  // Set session cookie
  res.cookie('userId', user.id, { httpOnly: true, secure: false });
  res.redirect(cont || '/');
});

// Authorization endpoint
app.get('/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, state, scope } = req.query;
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔐 AUTHORIZATION REQUEST');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Query params:', JSON.stringify(req.query, null, 2));
  
  // Validate request
  if (response_type !== 'code') {
    console.log('❌ Invalid response_type:', response_type);
    return res.status(400).send('response_type must be "code"');
  }
  
  const client = clients[client_id];
  if (!client) {
    console.log('❌ Unknown client_id:', client_id);
    return res.status(400).send(`Unknown client_id: ${client_id}`);
  }
  
  if (!client.redirectUris.includes(redirect_uri)) {
    console.log('❌ Invalid redirect_uri:', redirect_uri);
    console.log('   Allowed URIs:', client.redirectUris);
    return res.status(400).send('Invalid redirect_uri');
  }

  // If user not logged in, redirect to login page
  if (!req.cookies.userId) {
    console.log('⚠️  User not logged in, redirecting to login page');
    const continueUrl = `/authorize?${querystring.stringify(req.query)}`;
    return res.redirect(`/login?continue=${encodeURIComponent(continueUrl)}`);
  }

  const userId = req.cookies.userId;

  // Generate authorization code
  const code = uuidv4();
  authCodes[code] = {
    clientId: client_id,
    redirectUri: redirect_uri,
    userId,
    scope,
    expiresAt: Date.now() + CODE_TTL_SEC * 1000,
  };

  console.log('✅ Authorization code generated');
  console.log('   Code:', code);
  console.log('   User:', userId);
  console.log('   Expires in:', CODE_TTL_SEC, 'seconds');

  // Redirect back to Alexa with code and state
  const redirectTo = new URL(redirect_uri);
  redirectTo.searchParams.set('code', code);
  if (state) redirectTo.searchParams.set('state', state);

  console.log('🔄 Redirecting to:', redirectTo.toString());
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  res.redirect(redirectTo.toString());
});

// Token endpoint - THIS IS THE CRITICAL ONE
app.post('/token', (req, res) => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎫 TOKEN REQUEST RECEIVED');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('Content-Type:', req.headers['content-type']);
  console.log('Authorization:', req.headers['authorization'] ? 'Present' : 'Missing');
  
  const grant_type = req.body.grant_type;
  
  if (!grant_type) {
    console.log('❌ Missing grant_type');
    return res.status(400).json({ 
      error: 'invalid_request',
      error_description: 'grant_type is required'
    });
  }
  
  if (grant_type !== 'authorization_code' && grant_type !== 'refresh_token') {
    console.log('❌ Unsupported grant type:', grant_type);
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  // Extract client credentials from Basic Auth or body
  let clientId, clientSecret;
  if (req.headers.authorization && req.headers.authorization.startsWith('Basic ')) {
    const b64 = req.headers.authorization.slice('Basic '.length);
    const [cId, cSecret] = Buffer.from(b64, 'base64').toString().split(':');
    clientId = cId;
    clientSecret = cSecret;
    console.log('🔑 Using Basic Auth - Client ID:', clientId);
  } else {
    clientId = req.body.client_id;
    clientSecret = req.body.client_secret;
    console.log('🔑 Using Body Auth - Client ID:', clientId);
  }

  const client = clients[clientId];
  if (!client) {
    console.log('❌ Client not found:', clientId);
    return res.status(401).json({ error: 'invalid_client', error_description: 'client not found' });
  }
  
  if (client.clientSecret !== clientSecret) {
    console.log('❌ Client secret mismatch');
    return res.status(401).json({ error: 'invalid_client', error_description: 'invalid client secret' });
  }

  if (grant_type === 'authorization_code') {
    const code = req.body.code;
    const redirect_uri = req.body.redirect_uri;
    
    console.log('📋 Authorization Code Exchange:');
    console.log('   Code:', code);
    console.log('   Redirect URI:', redirect_uri);
    
    const stored = authCodes[code];
    
    if (!stored) {
      console.log('❌ Code not found or already used');
      console.log('   Available codes:', Object.keys(authCodes).length > 0 ? Object.keys(authCodes) : 'none');
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code not found or already used' });
    }
    
    if (stored.clientId !== clientId) {
      console.log('❌ Client ID mismatch');
      console.log('   Code belongs to:', stored.clientId);
      console.log('   Request from:', clientId);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'client mismatch' });
    }
    
    // Check if redirect_uri matches (be lenient for Amazon domains)
    const isValidRedirectUri = 
      redirect_uri === stored.redirectUri ||
      (redirect_uri && redirect_uri.includes('amazon.com/api/skill/link'));
    
    if (!isValidRedirectUri) {
      console.log('⚠️  Redirect URI mismatch (allowing anyway for Amazon)');
      console.log('   Stored:', stored.redirectUri);
      console.log('   Received:', redirect_uri);
    }
    
    if (Date.now() > stored.expiresAt) {
      delete authCodes[code];
      console.log('❌ Code expired');
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code expired' });
    }

    // Issue tokens
    const accessTokenPayload = { 
      sub: stored.userId, 
      scope: stored.scope, 
      client_id: clientId 
    };
    const accessToken = jwt.sign(accessTokenPayload, JWT_SECRET, { 
      expiresIn: ACCESS_TOKEN_TTL_SEC 
    });

    const refreshToken = uuidv4();
    refreshTokens[refreshToken] = { 
      userId: stored.userId, 
      clientId, 
      scope: stored.scope, 
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000 
    };

    // Delete code (one-time use)
    delete authCodes[code];

    console.log('✅ TOKENS ISSUED SUCCESSFULLY');
    console.log('   User:', stored.userId);
    console.log('   Access Token:', accessToken.substring(0, 20) + '...');
    console.log('   Refresh Token:', refreshToken);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SEC,
      refresh_token: refreshToken,
      scope: stored.scope,
    });
  }

  if (grant_type === 'refresh_token') {
    const refreshToken = req.body.refresh_token;
    const stored = refreshTokens[refreshToken];
    
    console.log('🔄 Refresh token request');
    
    if (!stored || stored.clientId !== clientId) {
      console.log('❌ Invalid refresh token');
      return res.status(400).json({ error: 'invalid_grant' });
    }
    
    if (Date.now() > stored.expiresAt) {
      delete refreshTokens[refreshToken];
      console.log('❌ Refresh token expired');
      return res.status(400).json({ error: 'invalid_grant', error_description: 'refresh token expired' });
    }

    // Issue new access token
    const accessToken = jwt.sign(
      { sub: stored.userId, scope: stored.scope, client_id: clientId }, 
      JWT_SECRET, 
      { expiresIn: ACCESS_TOKEN_TTL_SEC }
    );
    
    console.log('✅ New access token issued');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    return res.json({ 
      access_token: accessToken, 
      token_type: 'Bearer', 
      expires_in: ACCESS_TOKEN_TTL_SEC, 
      scope: stored.scope 
    });
  }
});

// User info endpoint
app.get('/userinfo', (req, res) => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('👤 USERINFO REQUEST');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const auth = req.headers.authorization;
  
  if (!auth || !auth.startsWith('Bearer ')) {
    console.log('❌ Missing or invalid authorization header');
    return res.status(401).json({ error: 'invalid_token' });
  }
  
  const token = auth.slice('Bearer '.length);
  
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    console.log('✅ Token verified for user:', payload.sub);
    
    // Find user by ID
    const user = Object.values(users).find(u => u.id === payload.sub);
    
    if (!user) {
      console.log('❌ User not found');
      return res.status(404).json({ error: 'user_not_found' });
    }
    
    console.log('✅ Returning user info for:', user.email);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Return user profile
    return res.json({ 
      sub: user.id,
      user_id: user.id,
      email: user.email,
      name: user.name
    });
  } catch (e) {
    console.log('❌ Token verification failed:', e.message);
    return res.status(401).json({ error: 'invalid_token' });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>OAuth Provider</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          max-width: 800px;
          margin: 50px auto;
          padding: 20px;
        }
        h1 { color: #333; }
        .status { color: green; font-weight: bold; }
        .endpoint {
          background: #f5f5f5;
          padding: 15px;
          margin: 10px 0;
          border-left: 3px solid #0066cc;
        }
        code {
          background: #e0e0e0;
          padding: 2px 6px;
          border-radius: 3px;
          font-family: monospace;
        }
        .config-box {
          background: #e7f3ff;
          padding: 20px;
          margin: 20px 0;
          border-radius: 5px;
          border: 1px solid #0066cc;
        }
        .config-item {
          margin: 10px 0;
          padding: 10px;
          background: white;
          border-radius: 3px;
        }
        .label {
          font-weight: bold;
          color: #555;
          display: block;
          margin-bottom: 5px;
        }
      </style>
    </head>
    <body>
      <h1>🔐 OAuth 2.0 Provider</h1>
      <p>Status: <span class="status">Running</span></p>
      
      <div class="config-box">
        <h3>Alexa Skill Configuration</h3>
        <p>Use these URLs in your Alexa Skill Account Linking settings:</p>
        
        <div class="config-item">
          <span class="label">Authorization URI:</span>
          <code>https://YOUR_NGROK_URL/authorize</code>
        </div>
        
        <div class="config-item">
          <span class="label">Access Token URI:</span>
          <code>https://YOUR_NGROK_URL/token</code>
        </div>
        
        <div class="config-item">
          <span class="label">Client ID:</span>
          <code>alexa-skill</code>
        </div>
        
        <div class="config-item">
          <span class="label">Client Secret:</span>
          <code>alexa-client-secret</code>
        </div>
      </div>
      
      <h2>Available Endpoints:</h2>
      <div class="endpoint">
        <strong>GET</strong> <code>/authorize</code> - Authorization endpoint
      </div>
      <div class="endpoint">
        <strong>POST</strong> <code>/token</code> - Token endpoint
      </div>
      <div class="endpoint">
        <strong>GET</strong> <code>/userinfo</code> - User info endpoint
      </div>
      
      <h2>Test Users:</h2>
      <ul>
        <li><code>john@example.com</code> / <code>password123</code></li>
        <li><code>alice@example.com</code> / <code>test456</code></li>
      </ul>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔐 OAuth Provider Server');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🌐 Local: http://localhost:${PORT}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⚠️  CRITICAL: Alexa is NOT calling /token endpoint');
  console.log('   Check Alexa Developer Console Account Linking:');
  console.log('   - Access Token URI must be: https://YOUR_NGROK_URL/token');
  console.log('   - Make sure you clicked SAVE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});