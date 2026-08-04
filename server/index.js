// server/index.js
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
  console.log(`⚡ Client connected: ${socket.id}`);

  // 1. CREATE ROOM
  socket.on('create-room', ({ name }, callback) => {
    if (!name?.trim()) return callback({ error: 'Please enter a valid name' });

    const roomId = generateRoomId();
    const newPlayer = { id: socket.id, name: name.trim(), score: 0, role: null, isReady: true };

    const newRoom = {
      roomId,
      host: socket.id,
      players: [newPlayer],
      gameStarted: false,
      currentRound: 1,
      messages: []
    };

    rooms.set(roomId, newRoom);
    socket.join(roomId);
    callback({ success: true, room: newRoom });
  });

  // 2. JOIN ROOM
  socket.on('join-room', ({ roomId, name }, callback) => {
    const cleanRoomId = roomId?.trim().toUpperCase();
    const room = rooms.get(cleanRoomId);

    if (!name?.trim()) return callback({ error: 'Please enter a valid name' });
    if (!room) return callback({ error: 'Room code not found. Please check and try again.' });
    if (room.players.length >= 4) return callback({ error: 'Room is full! Maximum 4 players allowed.' });
    if (room.gameStarted) return callback({ error: 'Game has already started in this room.' });

    const newPlayer = { id: socket.id, name: name.trim(), score: 0, role: null, isReady: false };
    room.players.push(newPlayer);
    socket.join(cleanRoomId);

    // Announce system join message in chat
    const sysMsg = {
      id: Date.now(),
      sender: 'System',
      text: `${name.trim()} joined the room.`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isSystem: true
    };
    room.messages.push(sysMsg);

    io.to(cleanRoomId).emit('player-joined', { room });
    io.to(cleanRoomId).emit('new-message', sysMsg);
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

  // 4. START GAME
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

    // Send private role chits to each socket
    room.players.forEach((p) => {
      io.to(p.id).emit('assign-roles', { 
        myRole: p.role,
        players: room.players.map(item => ({ id: item.id, name: item.name, score: item.score }))
      });
    });

    const raja = room.players.find(p => p.role === 'Raja');
    const wazir = room.players.find(p => p.role === 'Wazir');

    io.to(roomId).emit('reveal-raja', { 
      rajaId: raja.id, 
      rajaName: raja.name,
      wazirId: wazir.id 
    });
  });

  // 5. WAZIR GUESSES CHOR
  socket.on('guess-chor', ({ roomId, guessedPlayerId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const wazir = room.players.find(p => p.role === 'Wazir');
    const chor = room.players.find(p => p.role === 'Chor');
    const raja = room.players.find(p => p.role === 'Raja');
    const sipahi = room.players.find(p => p.role === 'Sipahi');

    if (socket.id !== wazir.id) return;

    const isCorrect = guessedPlayerId === chor.id;

    // Standard scoring
    raja.score += 1000;
    sipahi.score += 500;

    if (isCorrect) {
      wazir.score += 800;
      chor.score += 0;
    } else {
      chor.score += 800;
      wazir.score += 0;
    }

    io.to(roomId).emit('round-result', {
      isCorrect,
      guessedPlayerId,
      chor,
      wazir,
      raja,
      sipahi,
      allPlayers: room.players,
      room
    });
  });

  // 6. NEXT ROUND RESET
  socket.on('next-round', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id) return;

    room.currentRound += 1;
    io.to(roomId).emit('trigger-next-round', { roomId });
  });

  // 7. REAL-TIME CHAT (Phase 7)
  socket.on('send-message', ({ roomId, messageText }) => {
    const room = rooms.get(roomId);
    if (!room || !messageText?.trim()) return;

    const senderPlayer = room.players.find(p => p.id === socket.id);
    if (!senderPlayer) return;

    const chatMsg = {
      id: Date.now(),
      senderId: socket.id,
      sender: senderPlayer.name,
      text: messageText.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    room.messages.push(chatMsg);
    io.to(roomId).emit('new-message', chatMsg);
  });

  // 8. DISCONNECT HANDLING (Phase 8)
  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        const leftPlayer = room.players[index];
        room.players.splice(index, 1);

        if (room.players.length === 0) {
          rooms.delete(roomId);
        } else {
          // Transfer host if original host leaves
          if (room.host === socket.id) {
            room.host = room.players[0].id;
            const newHost = room.players.find(p => p.id === room.host);
            if (newHost) newHost.isReady = true;
          }

          // System message in chat for disconnect
          const discMsg = {
            id: Date.now(),
            sender: 'System',
            text: `${leftPlayer.name} disconnected.`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            isSystem: true
          };
          room.messages.push(discMsg);

          io.to(roomId).emit('player-left', { room });
          io.to(roomId).emit('new-message', discMsg);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});