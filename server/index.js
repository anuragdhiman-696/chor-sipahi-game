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
const MAX_ROUNDS_PER_SESSION = 20;

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
      currentSession: 1,
      maxRounds: MAX_ROUNDS_PER_SESSION,
      sessionWinners: [], // Stores { session: N, winnerName: "", score: X }
      messages: []
    };

    rooms.set(roomId, newRoom);
    socket.join(roomId);
    callback({ success: true, room: newRoom });
  });

  // JOIN ROOM
  socket.on('join-room', ({ roomId, name, peerId }, callback) => {
    if (!name?.trim()) return callback({ error: 'Name is required' });
    if (!roomId) return callback({ error: 'Room code required' });

    const cleanRoomId = roomId.trim().toUpperCase();
    const room = rooms.get(cleanRoomId);

    if (!room) return callback({ error: 'Room not found.' });

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

  // CARD DEALER HELPER
  const dealCards = (room, cleanRoomId) => {
    room.gameStarted = true;
    const shuffledRoles = shuffleArray(ROLES);

    room.players.forEach((p, idx) => { 
      p.role = shuffledRoles[idx]; 
    });

    io.to(cleanRoomId).emit('game-started', { room });

    room.players.forEach((p) => {
      io.to(p.id).emit('assign-roles', { 
        myRole: p.role,
        players: room.players.map(i => ({ id: i.id, name: i.name, score: i.score }))
      });
    });

    const raja = room.players.find(p => p.role === 'Raja');
    const wazir = room.players.find(p => p.role === 'Wazir');
    io.to(cleanRoomId).emit('reveal-raja', { rajaId: raja.id, rajaName: raja.name, wazirId: wazir.id });
  };

  // START FIRST GAME
  socket.on('start-game', ({ roomId }) => {
    const cleanRoomId = roomId?.trim().toUpperCase();
    const room = rooms.get(cleanRoomId);
    if (!room || room.players.length !== 4) return;
    
    room.currentRound = 1;
    dealCards(room, cleanRoomId);
  });

  // NEXT ROUND
  socket.on('next-round', ({ roomId }) => {
    const cleanRoomId = roomId?.trim().toUpperCase();
    const room = rooms.get(cleanRoomId);
    if (!room || room.host !== socket.id) return;

    if (room.currentRound < MAX_ROUNDS_PER_SESSION) {
      room.currentRound += 1;
      dealCards(room, cleanRoomId);
    }
  });

  // START NEXT SESSION
  socket.on('next-session', ({ roomId }) => {
    const cleanRoomId = roomId?.trim().toUpperCase();
    const room = rooms.get(cleanRoomId);
    if (!room || room.host !== socket.id) return;

    // Increment Session Counter and Reset Rounds & Scores
    room.currentSession += 1;
    room.currentRound = 1;
    room.gameStarted = false;
    room.players.forEach(p => p.score = 0);

    io.to(cleanRoomId).emit('room-updated', { room });
    dealCards(room, cleanRoomId);
  });

  // WAZIR GUESSING
  socket.on('make-guess', ({ roomId, suspectId }) => {
    const cleanRoomId = roomId?.trim().toUpperCase();
    const room = rooms.get(cleanRoomId);
    if (!room || !room.gameStarted) return;

    const wazir = room.players.find(p => p.role === 'Wazir');
    const chor = room.players.find(p => p.role === 'Chor');

    if (socket.id !== wazir?.id) return;

    const isCorrect = chor.id === suspectId;
    const roundScores = {};

    room.players.forEach(p => {
      if (!p.score) p.score = 0;

      let addedPts = 0;
      if (p.role === 'Raja') addedPts = 1000;
      else if (p.role === 'Sipahi') addedPts = 500;
      else if (p.role === 'Wazir') addedPts = isCorrect ? 800 : 0;
      else if (p.role === 'Chor') addedPts = isCorrect ? 0 : 800;

      p.score += addedPts;
      roundScores[p.name] = addedPts;
    });

    room.gameStarted = false;

    // Check if session ended (Round 20 completed)
    let isSessionEnd = room.currentRound >= MAX_ROUNDS_PER_SESSION;
    if (isSessionEnd) {
      // Find highest scoring player for this session
      const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score);
      const sessionWinner = sortedPlayers[0];
      room.sessionWinners.push({
        session: room.currentSession,
        winnerName: sessionWinner.name,
        score: sessionWinner.score
      });
    }

    io.to(cleanRoomId).emit('room-updated', { room });
    io.to(cleanRoomId).emit('game-over', {
      success: isCorrect,
      scores: roundScores,
      isSessionEnd,
      message: isCorrect 
        ? `🎉 ${wazir.name} (Wazir) correctly identified ${chor.name} as the Chor!` 
        : `❌ ${wazir.name} (Wazir) guessed wrong! ${chor.name} was the Thief!`
    });
  });

  // VOICE SIGNALING
  socket.on('join-voice', ({ roomId, peerId }) => {
    const cleanRoomId = roomId?.trim().toUpperCase();
    socket.to(cleanRoomId).emit('user-connected-voice', { peerId, socketId: socket.id });
  });

  // CHAT
  socket.on('send-message', ({ roomId, messageText }) => {
    const cleanRoomId = roomId?.trim().toUpperCase();
    const room = rooms.get(cleanRoomId);
    if (!room) return;

    const sender = [...room.players, ...room.spectators].find(p => p.id === socket.id);
    const msg = {
      id: Date.now(),
      sender: sender ? sender.name : 'Player',
      senderId: socket.id,
      text: messageText,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.messages.push(msg);
    io.to(cleanRoomId).emit('new-message', msg);
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