// server/index.js
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

// 1. FIRST create the httpServer
const httpServer = createServer(app);

// 2. THEN pass httpServer to Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allows connections from Vercel / production apps
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();
const ROLES = ['Raja', 'Wazir', 'Sipahi', 'Chor'];

const generateRoomId = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// Helper to shuffle roles randomly
const shuffleArray = (array) => {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

io.on('connection', (socket) => {
  console.log(`⚡ Client connected: ${socket.id}`);

  // 1. CREATE ROOM
  socket.on('create-room', ({ name }, callback) => {
    if (!name?.trim()) return callback({ error: 'Name is required' });

    const roomId = generateRoomId();
    const newPlayer = { id: socket.id, name: name.trim(), score: 0, role: null, isReady: true };

    const newRoom = {
      roomId,
      host: socket.id,
      players: [newPlayer],
      gameStarted: false,
      currentRound: 1
    };

    rooms.set(roomId, newRoom);
    socket.join(roomId);
    callback({ success: true, room: newRoom });
  });

  // 2. JOIN ROOM
  socket.on('join-room', ({ roomId, name }, callback) => {
    const cleanRoomId = roomId?.trim().toUpperCase();
    const room = rooms.get(cleanRoomId);

    if (!name?.trim()) return callback({ error: 'Name is required' });
    if (!room) return callback({ error: 'Room not found.' });
    if (room.players.length >= 4) return callback({ error: 'Room is full.' });
    if (room.gameStarted) return callback({ error: 'Game already started.' });

    const newPlayer = { id: socket.id, name: name.trim(), score: 0, role: null, isReady: false };
    room.players.push(newPlayer);
    socket.join(cleanRoomId);

    io.to(cleanRoomId).emit('player-joined', { room });
    callback({ success: true, room });
  });

  // 3. TOGGLE READY
  socket.on('toggle-ready', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.isReady = !player.isReady;
      io.to(roomId).emit('room-updated', { room });
    }
  });

  // 4. START GAME & ASSIGN ROLES
  socket.on('start-game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.players.length !== 4 || !room.players.every(p => p.isReady)) return;

    room.gameStarted = true;
    const shuffledRoles = shuffleArray(ROLES);

    room.players.forEach((p, index) => {
      p.role = shuffledRoles[index];
    });

    io.to(roomId).emit('game-started', { room });

    room.players.forEach((p) => {
      io.to(p.id).emit('assign-roles', { 
        myRole: p.role,
        players: room.players.map(item => ({ id: item.id, name: item.name, score: item.score }))
      });
    });

    const raja = room.players.find(p => p.role === 'Raja');
    io.to(roomId).emit('reveal-raja', { rajaId: raja.id, rajaName: raja.name });
  });

  // 5. DISCONNECT
  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        if (room.players.length === 0) {
          rooms.delete(roomId);
        } else {
          if (room.host === socket.id) {
            room.host = room.players[0].id;
            const newHost = room.players.find(p => p.id === room.host);
            if (newHost) newHost.isReady = true;
          }
          io.to(roomId).emit('player-left', { room });
        }
        break;
      }
    }
  });
});

// Use process.env.PORT for Render cloud compatibility
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
