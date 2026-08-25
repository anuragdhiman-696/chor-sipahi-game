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

  // JOIN ROOM
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

  // START GAME & DEAL CARDS
  socket.on('start-game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.players.length !== 4) return;

    room.gameStarted = true;
    const shuffledRoles = shuffleArray(ROLES);

    room.players.forEach((p, idx) => { 
      p.role = shuffledRoles[idx]; 
    });

    io.to(roomId).emit('game-started', { room });

    // Send private roles to each individual client
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

  // WAZIR GUESSING & SCORE CALCULATION
  socket.on('make-guess', ({ roomId, suspectId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameStarted) return;

    const wazir = room.players.find(p => p.role === 'Wazir');
    const chor = room.players.find(p => p.role === 'Chor');

    // Only Wazir can make a guess
    if (socket.id !== wazir?.id) return;

    const isCorrect = chor.id === suspectId;
    const roundScores = {};

    // Calculate score updates based on original game rules
    room.players.forEach(p => {
      if (!p.score) p.score = 0;

      let addedPts = 0;
      if (p.role === 'Raja') {
        addedPts = 1000;
      } else if (p.role === 'Sipahi') {
        addedPts = 500;
      } else if (p.role === 'Wazir') {
        addedPts = isCorrect ? 800 : 0;
      } else if (p.role === 'Chor') {
        addedPts = isCorrect ? 0 : 800;
      }

      p.score += addedPts;
      roundScores[p.name] = addedPts;
    });

    // Reset round state for potential next round
    room.gameStarted = false;

    // Broadcast updated score matrix & outcome
    io.to(roomId).emit('room-updated', { room });
    io.to(roomId).emit('game-over', {
      success: isCorrect,
      scores: roundScores,
      message: isCorrect 
        ? `🎉 ${wazir.name} (Wazir) correctly identified ${chor.name} as the Chor!` 
        : `❌ ${wazir.name} (Wazir) guessed wrong! ${chor.name} was the Thief and steals the points!`
    });
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

  // DISCONNECT HANDLER
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