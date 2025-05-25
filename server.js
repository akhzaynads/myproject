const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const port = 3000;

// Enable CORS
app.use(cors());
app.use(express.json());

// Store connected clients
const clients = new Map();
const masters = new Map();

// Create HTTP server
const server = require('http').createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection established');
  
  try {
    ws.send(JSON.stringify({
      type: 'welcome',
      message: 'Connected to SageMaker Control Server',
      timestamp: Date.now()
    }));
  } catch (error) {
    console.error('Error sending welcome message:', error);
  }
  
  ws.on('message', (message) => {
    try {
      console.log('Raw message received:', message.toString());
      const data = JSON.parse(message);
      console.log('Parsed message:', data);
      
      switch (data.type) {
        case 'register_master':
          handleMasterRegistration(ws, data);
          break;
          
        case 'register_client':
          handleClientRegistration(ws, data);
          break;
          
        case 'master_command':
          handleMasterCommand(data);
          break;
          
        case 'client_status':
          handleClientStatus(ws, data);
          break;
          
        case 'heartbeat':
          handleHeartbeat(ws, data);
          break;
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });
  
  ws.on('close', () => {
    handleDisconnection(ws);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

function handleMasterRegistration(ws, data) {
  const masterId = data.masterId || `master_${Date.now()}`;
  
  masters.set(masterId, {
    id: masterId,
    ws: ws,
    connectedAt: new Date(),
    lastHeartbeat: Date.now()
  });
  
  ws.masterId = masterId;
  
  console.log(`Master registered: ${masterId}`);
  
  // Send current clients list to master
  sendToMaster(masterId, {
    type: 'clients_list',
    clients: Array.from(clients.values()).map(client => ({
      id: client.id,
      connectedAt: client.connectedAt,
      lastHeartbeat: client.lastHeartbeat,
      status: client.status || 'idle'
    }))
  });
  
  // Confirm registration
  ws.send(JSON.stringify({
    type: 'registration_success',
    role: 'master',
    masterId: masterId
  }));
}

function handleClientRegistration(ws, data) {
  const clientId = data.clientId || `client_${Date.now()}`;
  
  clients.set(clientId, {
    id: clientId,
    ws: ws,
    connectedAt: new Date(),
    lastHeartbeat: Date.now(),
    status: 'connected'
  });
  
  ws.clientId = clientId;
  
  console.log(`Client registered: ${clientId}`);
  
  // Notify all masters about new client
  broadcastToMasters({
    type: 'client_connected',
    client: {
      id: clientId,
      connectedAt: new Date(),
      status: 'connected'
    }
  });
  
  // Confirm registration
  ws.send(JSON.stringify({
    type: 'registration_success',
    role: 'client',
    clientId: clientId
  }));
}

function handleMasterCommand(data) {
  console.log('Master command received:', data);
  
  switch (data.command) {
    case 'switch_account':
      broadcastToClients({
        type: 'command',
        command: 'switch_account',
        data: data.data || {}
      });
      break;
      
    case 'perform_login':
      broadcastToClients({
        type: 'command',
        command: 'login',
        data: data.data || {}
      });
      break;
      
    case 'get_client_status':
      broadcastToClients({
        type: 'command',
        command: 'status'
      });
      break;
      
    case 'clear_cache':
      console.log('Broadcasting clear_cache command to all clients');
      broadcastToClients({
        type: 'command',
        command: 'clear_cache',
        data: data.data || {}
      });
      break;
  }
}

function handleClientStatus(ws, data) {
  const clientId = ws.clientId;
  if (clients.has(clientId)) {
    const client = clients.get(clientId);
    client.status = data.status;
    client.lastActivity = data.activity;
    client.loginCount = data.loginCount;
    client.activeAccount = data.activeAccount;
    
    // Broadcast status update to masters
    broadcastToMasters({
      type: 'client_status_update',
      clientId: clientId,
      status: data.status,
      activity: data.activity,
      loginCount: data.loginCount,
      activeAccount: data.activeAccount
    });
  }
}

function handleHeartbeat(ws, data) {
  if (ws.masterId) {
    const master = masters.get(ws.masterId);
    if (master) {
      master.lastHeartbeat = Date.now();
    }
  }
  
  if (ws.clientId) {
    const client = clients.get(ws.clientId);
    if (client) {
      client.lastHeartbeat = Date.now();
    }
  }
}

function handleDisconnection(ws) {
  if (ws.masterId) {
    console.log(`Master disconnected: ${ws.masterId}`);
    masters.delete(ws.masterId);
  }
  
  if (ws.clientId) {
    console.log(`Client disconnected: ${ws.clientId}`);
    clients.delete(ws.clientId);
    
    // Notify masters about client disconnection
    broadcastToMasters({
      type: 'client_disconnected',
      clientId: ws.clientId
    });
  }
}

function sendToMaster(masterId, message) {
  const master = masters.get(masterId);
  if (master && master.ws.readyState === WebSocket.OPEN) {
    try {
      master.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error(`Error sending message to master ${masterId}:`, error);
    }
  }
}

function broadcastToMasters(message) {
  masters.forEach((master) => {
    if (master.ws.readyState === WebSocket.OPEN) {
      try {
        master.ws.send(JSON.stringify(message));
      } catch (error) {
        console.error(`Error broadcasting to master ${master.id}:`, error);
      }
    }
  });
}

function broadcastToClients(message) {
  console.log(`Broadcasting to ${clients.size} clients:`, message);
  clients.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(message));
        console.log(`Message sent to client ${client.id}`);
      } catch (error) {
        console.error(`Error broadcasting to client ${client.id}:`, error);
      }
    }
  });
}

// Basic status endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'Server is running',
    masters: masters.size,
    clients: clients.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Start server
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Local WebSocket URL: ws://localhost:${port}`);
  console.log(`Local HTTP URL: http://localhost:${port}`);
  console.log('');
  console.log('To expose this server to the internet:');
  console.log('1. Run ngrok in a separate terminal: ngrok http 3000');
  console.log('2. Use the https:// URL provided by ngrok');
  console.log('3. For WebSocket connections, use wss:// instead of https://');
});