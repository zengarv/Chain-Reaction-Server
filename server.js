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

// In‑memory storage for rooms. Each room now has players, gridSize,
// board (a 2D array of cell objects), currentTurn (index into players),
// and a gameStarted flag.
const rooms = {};

// ---------------------
// Helper Functions
// ---------------------

// Create an empty board and initialize game state.
function initializeGame(room) {
  const { rows, cols } = room.gridSize;
  room.board = [];
  for (let i = 0; i < rows; i++) {
    room.board[i] = [];
    for (let j = 0; j < cols; j++) {
      room.board[i][j] = { count: 0, owner: null };
    }
  }
  room.currentTurn = 0; // start with the first player in the list
  room.gameStarted = true;
}

// Given a cell position (row, col) and the board dimensions,
// return its critical mass (i.e. the number of neighbors).
function getCriticalMass(row, col, gridSize) {
  let count = 0;
  if (row > 0) count++;                      // Up
  if (row < gridSize.rows - 1) count++;        // Down
  if (col > 0) count++;                      // Left
  if (col < gridSize.cols - 1) count++;        // Right
  return count;
}

// Process a move in a room. (Only the current player may make a move,
// and a move is valid only if the targeted cell is either empty or already owned.)
function processMove(room, playerSocketId, row, col) {
  if (!room.gameStarted) {
    return { error: "Game is not active" };
  }
  
  let currentPlayer = room.players[room.currentTurn];
  if (currentPlayer.id !== playerSocketId) {
    return { error: "Not your turn" };
  }
  
  // Check if the player is a spectator
  const player = room.players.find(p => p.id === playerSocketId);
  if (player && player.isSpectator) {
    return { error: "Spectators cannot make moves" };
  }
  
  let cell = room.board[row][col];
  if (cell.owner !== null && cell.owner !== playerSocketId) {
    return { error: "Invalid move" };
  }
  
  // Place an orb into the cell.
  cell.count += 1;
  cell.owner = playerSocketId;
  currentPlayer.hasPlayed = true;

  // Save the last move in the room state.
  room.lastMove = { row, col };

  // Process chain reactions using a queue.
  let queue = [];
  if (cell.count >= getCriticalMass(row, col, room.gridSize)) {
    queue.push({ row, col });
  }
  
  while (queue.length > 0) {
    let { row: r, col: c } = queue.shift();
    let currentCell = room.board[r][c];
    let threshold = getCriticalMass(r, c, room.gridSize);
    if (currentCell.count < threshold) continue; // might have been updated already
    let owner = currentCell.owner;
    
    // Explosion: reset the cell.
    currentCell.count = 0;
    currentCell.owner = null;
    
    // For each neighbor, add an orb and change its owner.
    const directions = [ [1,0], [-1,0], [0,1], [0,-1] ];
    for (let [dr, dc] of directions) {
      let nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < room.gridSize.rows && nc >= 0 && nc < room.gridSize.cols) {
        let neighbor = room.board[nr][nc];
        neighbor.count += 1;
        neighbor.owner = owner;
        if (neighbor.count >= getCriticalMass(nr, nc, room.gridSize)) {
          queue.push({ row: nr, col: nc });
        }
      }
    }
  }
  
  // Update each player's "active" status.
  // For players who haven't played yet, consider them active by default.
  room.players.forEach(player => {
    if (!player.hasPlayed) {
      player.isActive = true;
    } else {
      player.isActive = false;
    }
  });
  // Then, for each cell on the board, mark the owner as active.
  for (let i = 0; i < room.gridSize.rows; i++) {
    for (let j = 0; j < room.gridSize.cols; j++) {
      let cell = room.board[i][j];
      if (cell.owner) {
        let player = room.players.find(p => p.id === cell.owner);
        if (player) {
          player.isActive = true;
        }
      }
    }
  }  // Check for win condition only if all non-spectator players have played at least once
  let nonSpectatorPlayers = room.players.filter(p => !p.isSpectator);
  let playersWhoPlayed = nonSpectatorPlayers.filter(p => p.hasPlayed);
  let winner = null;
  
  // Only check for winner if all non-spectator players have had a turn
  if (playersWhoPlayed.length === nonSpectatorPlayers.length && nonSpectatorPlayers.length > 1) {
    // Only count non-spectator active players for win condition
    let activePlayers = room.players.filter(p => p.isActive && !p.isSpectator);
    if (activePlayers.length === 1) {
      winner = activePlayers[0];
      room.gameStarted = false;
    }
  }
  
  // Only update turn if the game hasn't ended
  if (!winner) {
    // Update turn: advance to the next active, non-spectator player.
    let nextTurn = room.currentTurn;
    for (let i = 0; i < room.players.length; i++) {
      nextTurn = (nextTurn + 1) % room.players.length;
      if (room.players[nextTurn].isActive && !room.players[nextTurn].isSpectator) {
        break;
      }
    }
    room.currentTurn = nextTurn;
  }
  
  return {
    board: room.board,
    currentTurn: winner ? null : room.players[room.currentTurn].id, // Don't return currentTurn if game is over
    players: room.players,
    winner: winner,
    lastMove: room.lastMove  
  };
  };


// ---------------------
// Socket.io Event Handlers
// ---------------------

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('joinRoom', (data) => {
    
    const { roomId, playerName, isAdmin, gridSize } = data;
    if (!rooms[roomId]) {
      // If the room is new, initialize it with default grid settings.
      rooms[roomId] = {
        players: [],
        gridSize: gridSize || { rows: 9, cols: 6 },
        board: [],
        currentTurn: 0,
        gameStarted: false
      };
    }

    // Prevent duplicate joining.
    if (rooms[roomId].players.find(p => p.id === socket.id)) {
      return;
    }    // Create a new player object.
    const newPlayer = {
      id: socket.id,
      name: playerName,
      isAdmin: !!isAdmin,  // true for admin, false otherwise
      isActive: true,
      hasPlayed: false,    // NEW: track whether this player has played yet
      isSpectator: rooms[roomId].gameStarted  // If game is already started, they're a spectator
    };

    rooms[roomId].players.push(newPlayer);
    socket.join(roomId);
    console.log(`Player ${playerName} joined room ${roomId}`);

    // Send the gridSize to the new client so its board matches.
    socket.emit('gridSizeUpdate', rooms[roomId].gridSize);
    
    // Broadcast updated players list.
    io.to(roomId).emit('playerListUpdate', rooms[roomId].players);    // Broadcast a system chat message.
    io.to(roomId).emit('chatMessage', {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      playerId: 'Server',
      text: `${playerName} has joined the room${newPlayer.isSpectator ? ' as a spectator' : ''}.`,
      timestamp: new Date()
    });
  });

  // Allow the admin to update the grid size.
  socket.on('setGridSize', (data) => {
    const { roomId, gridSize } = data;
    if (rooms[roomId]) {
      rooms[roomId].gridSize = gridSize;
      io.to(roomId).emit('gridSizeUpdate', gridSize);
    }
  });

  // When the admin starts the game, initialize the board and state.
  socket.on('gameStart', (data) => {
    const { roomId } = data;
    const room = rooms[roomId];
    if (room) {
      initializeGame(room);
      io.to(roomId).emit('updateGameState', {
        board: room.board,
        currentTurn: room.players[room.currentTurn].id,
        players: room.players,
        winner: null
      });
    }
  });
  // When a move is made, process it on the server.
  socket.on('makeMove', (data) => {
    const { roomId, row, col } = data;
    const room = rooms[roomId];
    if (!room || !room.gameStarted) {
      console.log('Move blocked: room not found or game not started');
      return;
    }
    const result = processMove(room, socket.id, row, col);
    if (result.error) {
      socket.emit('errorMessage', result.error);
    } else {
      // Broadcast the updated game state to everyone in the room.
      io.to(roomId).emit('updateGameState', result);
    }
  });
  // Reset the game state for a "play again" request.
  socket.on('playAgain', (data) => {
    const { roomId } = data;
    const room = rooms[roomId];
    if (room) {
      // Check if the requesting player is an admin
      const requestingPlayer = room.players.find(p => p.id === socket.id);
      if (!requestingPlayer || !requestingPlayer.isAdmin) {
        socket.emit('errorMessage', 'Only admin can restart the game');
        return;
      }      // Reset all player states properly but preserve player order and attributes
      room.players.forEach(p => {
        p.isActive = true;
        p.hasPlayed = false;
        p.isSpectator = false; // Convert all spectators to players for the new round
      });
      
      // Clear the last move
      room.lastMove = null;
      
      // Reset only the board, don't call initializeGame to avoid changing other state
      const { rows, cols } = room.gridSize;
      room.board = [];
      for (let i = 0; i < rows; i++) {
        room.board[i] = [];
        for (let j = 0; j < cols; j++) {
          room.board[i][j] = { count: 0, owner: null };
        }
      }
      
      // Reset turn to first player but keep game started
      room.currentTurn = 0;
      room.gameStarted = true; // Ensure game is marked as started
      
      // Broadcast the reset state to all players
      io.to(roomId).emit('updateGameState', {
        board: room.board,
        currentTurn: room.players[room.currentTurn].id,
        players: room.players,
        winner: null,
        lastMove: null
      });      // Send a chat message to indicate the game has restarted
      io.to(roomId).emit('chatMessage', {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        playerId: 'Server',
        text: 'Game has been restarted. All spectators can now participate. Good luck!',
        timestamp: new Date()
      });
    }
  });
  socket.on('sendChatMessage', (data) => {
    const { roomId, message, playerName } = data;
    io.to(roomId).emit('chatMessage', {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      playerId: socket.id,
      text: `${playerName}: ${message}`,
      timestamp: new Date()
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        const removedPlayer = room.players.splice(index, 1)[0];        io.to(roomId).emit('playerListUpdate', room.players);
        io.to(roomId).emit('chatMessage', {
          id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
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
