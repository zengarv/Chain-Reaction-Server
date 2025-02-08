// server.js

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"  // For development; restrict in production
  }
});

// In‑memory storage for rooms: each room stores a list of players.
const rooms = {};

// Listen for new connections.
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('joinRoom', (data) => {
    const { roomId, playerName, isAdmin } = data;
    if (!rooms[roomId]) {
      rooms[roomId] = { players: [] };
    }

    // Prevent duplicate joining (e.g. from React StrictMode re‑mounts)
    if (rooms[roomId].players.find(p => p.id === socket.id)) {
      return;
    }

    // Create the player object.
    const newPlayer = {
      id: socket.id,
      name: playerName,
      isAdmin: !!isAdmin  // true for admin, false otherwise
      // Additional properties (e.g., color) can be added here.
    };

    // Add the new player to the room and have the socket join the room.
    rooms[roomId].players.push(newPlayer);
    socket.join(roomId);
    console.log(`Player ${playerName} joined room ${roomId}`);

    // Broadcast the updated players list.
    io.to(roomId).emit('playerListUpdate', rooms[roomId].players);

    // Broadcast a system chat message.
    io.to(roomId).emit('chatMessage', {
      playerId: 'Server',
      text: `${playerName} has joined the room.`,
      timestamp: new Date()
    });
  });

  // Listen for chat messages.
  socket.on('sendChatMessage', (data) => {
    const { roomId, message, playerName } = data;
    io.to(roomId).emit('chatMessage', {
      playerId: socket.id,
      text: `${playerName}: ${message}`,
      timestamp: new Date()
    });
  });

  // When a client disconnects, remove it from any rooms.
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        const removedPlayer = room.players.splice(index, 1)[0];
        io.to(roomId).emit('playerListUpdate', room.players);
        io.to(roomId).emit('chatMessage', {
          playerId: 'Server',
          text: `${removedPlayer.name} has left the room.`,
          timestamp: new Date()
        });
        if (room.players.length === 0) {
          delete rooms[roomId];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
