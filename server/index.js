const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// Serve static frontend in production
app.use(express.static(path.join(__dirname, '../client/dist')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allows browser, web apps, and APK native webviews
    methods: ["GET", "POST"]
  }
});

/**
 * Room Data Structure:
 * {
 *   id: string,
 *   host: string (socket.id),
 *   players: Array<{ id: string, name: string, isHost: boolean, isSpectator: boolean, isReady: boolean }>,
 *   gameState: 'lobby' | 'playing' | 'round_end' | 'game_end',
 *   voiceStates: {
 *     [socketId]: {
 *       peerId: string,
 *       voiceJoined: boolean,
 *       selfMuted: boolean,
 *       hostMuted: boolean
 *     }
 *   },
 *   gameData: { ... }
 * }
 */
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function broadcastVoiceStateUpdate(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('voice-state-updated', room.voiceStates);
}

io.on('connection', (socket) => {
  console.log(`User Connected: ${socket.id}`);

  socket.on('create-room', ({ playerName }) => {
    let roomId = generateRoomCode();
    while (rooms.has(roomId)) {
      roomId = generateRoomCode();
    }

    const roomData = {
      id: roomId,
      code: roomId,
      host: socket.id,
      players: [{
        id: socket.id,
        name: playerName || 'Player 1',
        isHost: true,
        isSpectator: false,
        isReady: false
      }],
      gameState: 'lobby',
      voiceStates: {},
      chatMessages: []
    };

    rooms.set(roomId, roomData);
    socket.join(roomId);
    socket.emit('room-created', { roomId, room: roomData });
  });

  socket.on('join-room', ({ roomId, playerName }) => {
    const cleanRoomId = roomId ? roomId.trim().toUpperCase() : '';
    const room = rooms.get(cleanRoomId);

    if (!room) {
      return socket.emit('error-message', 'Room not found.');
    }

    if (room.players.length >= 8 && room.gameState !== 'lobby') {
      return socket.emit('error-message', 'Room is full or game in progress.');
    }

    const isSpectator = room.players.length >= 4 || room.gameState !== 'lobby';
    const playerObj = {
      id: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      isHost: false,
      isSpectator,
      isReady: false
    };

    room.players.push(playerObj);
    socket.join(cleanRoomId);

    socket.emit('room-joined', { roomId: cleanRoomId, room });
    io.to(cleanRoomId).emit('player-joined', { player: playerObj, room });
  });

  // VOICE SIGNALING & STATE MANAGEMENT
  socket.on('join-voice', ({ roomId, peerId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (!room.voiceStates[socket.id]) {
      room.voiceStates[socket.id] = {
        peerId,
        voiceJoined: true,
        selfMuted: false,
        hostMuted: false
      };
    } else {
      room.voiceStates[socket.id].peerId = peerId;
      room.voiceStates[socket.id].voiceJoined = true;
    }

    // Inform joining player of existing voice participants
    const activeVoiceParticipants = Object.entries(room.voiceStates)
      .filter(([id, state]) => state.voiceJoined && id !== socket.id)
      .map(([id, state]) => ({ socketId: id, peerId: state.peerId }));

    socket.emit('voice-participants', activeVoiceParticipants);

    // Broadcast new participant to others
    socket.to(roomId).emit('user-connected-voice', {
      socketId: socket.id,
      peerId
    });

    broadcastVoiceStateUpdate(roomId);
  });

  socket.on('voice-mute-self', ({ roomId, selfMuted }) => {
    const room = rooms.get(roomId);
    if (!room || !room.voiceStates[socket.id]) return;

    room.voiceStates[socket.id].selfMuted = Boolean(selfMuted);
    broadcastVoiceStateUpdate(roomId);
  });

  // SECURE HOST VOICE CONTROLS
  socket.on('host-mute-player', ({ roomId, targetSocketId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (socket.id !== room.host) {
      return socket.emit('error-message', 'Unauthorized: Only the room host can mute players.');
    }

    if (room.voiceStates[targetSocketId]) {
      room.voiceStates[targetSocketId].hostMuted = true;
      io.to(targetSocketId).emit('force-host-mute', { hostMuted: true });
      broadcastVoiceStateUpdate(roomId);
    }
  });

  socket.on('host-unmute-player', ({ roomId, targetSocketId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (socket.id !== room.host) {
      return socket.emit('error-message', 'Unauthorized: Only the room host can unmute players.');
    }

    if (room.voiceStates[targetSocketId]) {
      room.voiceStates[targetSocketId].hostMuted = false;
      io.to(targetSocketId).emit('force-host-mute', { hostMuted: false });
      broadcastVoiceStateUpdate(roomId);
    }
  });

  socket.on('host-mute-all', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (socket.id !== room.host) {
      return socket.emit('error-message', 'Unauthorized: Only the room host can mute all.');
    }

    Object.keys(room.voiceStates).forEach((sId) => {
      if (sId !== room.host) {
        room.voiceStates[sId].hostMuted = true;
        io.to(sId).emit('force-host-mute', { hostMuted: true });
      }
    });

    broadcastVoiceStateUpdate(roomId);
  });

  socket.on('host-unmute-all', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (socket.id !== room.host) {
      return socket.emit('error-message', 'Unauthorized: Only the room host can unmute all.');
    }

    Object.keys(room.voiceStates).forEach((sId) => {
      if (sId !== room.host) {
        room.voiceStates[sId].hostMuted = false;
        io.to(sId).emit('force-host-mute', { hostMuted: false });
      }
    });

    broadcastVoiceStateUpdate(roomId);
  });

  socket.on('send-message', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const sender = room.players.find(p => p.id === socket.id);
    const msgData = {
      sender: sender ? sender.name : 'Unknown',
      text: message,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    room.chatMessages.push(msgData);
    io.to(roomId).emit('receive-message', msgData);
  });

  socket.on('start-game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.host) return;

    if (room.players.length !== 4) {
      return socket.emit('error-message', 'Exactly 4 players are required.');
    }

    const shuffledPlayers = [...room.players].sort(() => Math.random() - 0.5);

    const roles = {};
    roles[shuffledPlayers[0].id] = 'Raja';
    roles[shuffledPlayers[1].id] = 'Wazir';
    roles[shuffledPlayers[2].id] = 'Sipahi';
    roles[shuffledPlayers[3].id] = 'Chor';

    room.players.forEach((player) => {
      player.role = roles[player.id];
    });

    room.gameState = 'playing';

    const wazirId = shuffledPlayers[1].id;

    io.to(roomId).emit('game-started', {
      room,
      roles,
      wazirId
    });
  });
  socket.on('disconnect', () => {
    console.log(`User Disconnected: ${socket.id}`);
    rooms.forEach((room, roomId) => {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        delete room.voiceStates[socket.id];

        socket.to(roomId).emit('user-disconnected-voice', { socketId: socket.id });
        socket.to(roomId).emit('player-left', { socketId: socket.id, room });

        if (room.players.length === 0) {
          rooms.delete(roomId);
        } else if (room.host === socket.id) {
          room.host = room.players[0].id;
          room.players[0].isHost = true;
          io.to(roomId).emit('host-changed', { newHostId: room.host, room });
        }
        broadcastVoiceStateUpdate(roomId);
      }
    });
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Chor Sipahi Server running on port ${PORT}`);
});