import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = new Map();
const ROLES = ['Raja', 'Wazir', 'Sipahi', 'Chor'];

const generateRoomId = () => Math.random().toString(36).substring(2, 8).toUpperCase();

const shuffleArray = (array) => {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

io.on('connection', (socket) => {
  // CREATE ROOM
  socket.on('create-room', ({ name, peerId }, callback) => {
    if (!name?.trim()) return callback({ error: 'Name is required' });

    const roomId = generateRoomId();
    const newPlayer = { id: socket.id, peerId, name: name.trim(), score: 0, role: null, isReady: true, isSpectator: false };

    const newRoom = {
      roomId,
      host: socket.id,
      players: [newPlayer],
      spectators: [],
      gameStarted: false,
      currentRound: 1,
      messages: []
    };

    rooms.set(roomId, newRoom);
    socket.join(roomId);
    callback({ success: true, room: newRoom });
  });

  // JOIN ROOM (Auto-assigns to Spectators if room >= 4 or game in progress)
  socket.on('join-room', ({ roomId, name, peerId }, callback) => {
    const cleanRoomId = roomId?.trim().toUpperCase();
    const room = rooms.get(cleanRoomId);

    if (!name?.trim()) return callback({ error: 'Name is required' });
    if (!room) return callback({ error: 'Room not found' });

    const isSpectator = room.players.length >= 4 || room.gameStarted;
    const newParticipant = { id: socket.id, peerId, name: name.trim(), score: 0, role: null, isReady: false, isSpectator };

    if (isSpectator) {
      room.spectators.push(newParticipant);
    } else {
      room.players.push(newParticipant);
    }

    socket.join(cleanRoomId);
    io.to(cleanRoomId).emit('room-updated', { room });
    callback({ success: true, room });
  });

  // TOGGLE READY
  socket.on('toggle-ready', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.isReady = !player.isReady;
      io.to(roomId).emit('room-updated', { room });
    }
  });

  // START GAME
  socket.on('start-game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.players.length !== 4) return;

    room.gameStarted = true;
    const shuffledRoles = shuffleArray(ROLES);

    room.players.forEach((p, idx) => { p.role = shuffledRoles[idx]; });

    io.to(roomId).emit('game-started', { room });

    room.players.forEach((p) => {
      io.to(p.id).emit('assign-roles', { 
        myRole: p.role,
        players: room.players.map(i => ({ id: i.id, name: i.name, score: i.score }))
      });
    });

    const raja = room.players.find(p => p.role === 'Raja');
    const wazir = room.players.find(p => p.role === 'Wazir');
    io.to(roomId).emit('reveal-raja', { rajaId: raja.id, rajaName: raja.name, wazirId: wazir.id });
  });

  // VOICE SIGNALING
  socket.on('join-voice', ({ roomId, peerId }) => {
    socket.to(roomId).emit('user-connected-voice', { peerId, socketId: socket.id });
  });

  // CHAT
  socket.on('send-message', ({ roomId, messageText }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const sender = [...room.players, ...room.spectators].find(p => p.id === socket.id);
    const msg = {
      id: Date.now(),
      sender: sender ? sender.name : 'Unknown',
      senderId: socket.id,
      text: messageText,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.messages.push(msg);
    io.to(roomId).emit('new-message', msg);
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      let index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) room.players.splice(index, 1);

      index = room.spectators.findIndex(p => p.id === socket.id);
      if (index !== -1) room.spectators.splice(index, 1);

      if (room.players.length === 0 && room.spectators.length === 0) {
        rooms.delete(roomId);
      } else {
        if (room.host === socket.id && room.players.length > 0) {
          room.host = room.players[0].id;
        }
        io.to(roomId).emit('room-updated', { room });
      }
      break;
    }
  });
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));