const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
app.use(cors());

// Serve static frontend in production
app.use(express.static(path.join(__dirname, '../client/dist')));

const io = new Server(server, {
  cors: {
    origin: '*', // Allows requests from Vercel or local environment
    methods: ['GET', 'POST'],
    transports: ['websocket', 'polling'],
    credentials: true
  },
  allowEIO3: true
});

const TOTAL_ROUNDS = 20;
const rooms = new Map();

// Helper to generate a 6-character room code
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Assign classic Raja, Wazir, Sipahi, Chor roles
function assignRoles(players) {
  const roles = ['Raja', 'Wazir', 'Sipahi', 'Chor'];
  const shuffledRoles = [...roles].sort(() => Math.random() - 0.5);
  const assignments = {};

  // Assign roles to the active 4 game players
  players.slice(0, 4).forEach((player, index) => {
    assignments[player.id] = shuffledRoles[index];
  });
  return assignments;
}

function broadcastVoiceStateUpdate(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('voice-state-updated', room.voiceStates);
}

function startNewRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.gameState = 'GUESSING';
  room.roles = assignRoles(room.players.filter(p => !p.isSpectator));

  // Assign role back to player objects for client representation
  room.players.forEach(p => {
    p.role = room.roles[p.id] || 'Spectator';
  });

  io.to(roomId).emit('roundStarted', {
    currentRound: room.currentRound,
    roles: room.roles,
    players: room.players,
    scores: room.scores
  });
}

io.on('connection', (socket) => {
  console.log(`User Connected: ${socket.id}`);

  // Create Room
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
      scores: { [socket.id]: 0 },
      currentRound: 1,
      gameState: 'WAITING', // WAITING, GUESSING, ROUND_OVER, SESSION_OVER
      roles: {},
      voiceStates: {},
      chatMessages: []
    };

    rooms.set(roomId, roomData);
    socket.join(roomId);
    socket.emit('room-created', { roomId, room: roomData });
  });

  // Join Room
  socket.on('join-room', ({ roomId, playerName }) => {
    const cleanRoomId = roomId ? roomId.trim().toUpperCase() : '';
    const room = rooms.get(cleanRoomId);

    if (!room) {
      return socket.emit('error-message', 'Room not found.');
    }

    if (room.players.length >= 8) {
      return socket.emit('error-message', 'Room is full.');
    }

    const isSpectator = room.players.length >= 4 || room.gameState !== 'WAITING';
    const playerObj = {
      id: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      isHost: false,
      isSpectator,
      isReady: false
    };

    room.players.push(playerObj);
    room.scores[socket.id] = room.scores[socket.id] || 0;
    socket.join(cleanRoomId);

    const joinMessage = {
      system: true,
      text: `${playerObj.name} joined the room.`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    room.chatMessages.push(joinMessage);
    io.to(cleanRoomId).emit('receive-message', joinMessage);

    socket.emit('room-joined', { roomId: cleanRoomId, room });
    socket.emit('chat-history', room.chatMessages);
    io.to(cleanRoomId).emit('player-joined', { player: playerObj, room });

    // Keep the room in WAITING state until the host manually starts the game.
    // The 5th+ players are spectators and do not affect the 4-player requirement.

    // Explicit Host Game Start Trigger
    socket.on('start-game', ({ roomId }) => {
      const room = rooms.get(roomId);
      const currentPlayer = room?.players.find(p => p.id === socket.id);

      if (!room || !currentPlayer || currentPlayer.isSpectator || socket.id !== room.host) return;
      const activePlayers = room.players.filter(p => !p.isSpectator);
      if (activePlayers.length !== 4) {
        return socket.emit('error-message', 'Exactly 4 active players are required to start.');
      }

      startNewRound(roomId);
    });

    // Gameplay Guess Logic
    socket.on('makeGuess', ({ roomId, guessedPlayerId }) => {
      const room = rooms.get(roomId);
      if (!room || room.gameState !== 'GUESSING') return;

      const currentPlayer = room.players.find(p => p.id === socket.id);

      if (!currentPlayer || currentPlayer.isSpectator) {
        return socket.emit('error-message', 'Spectators cannot make guesses.');
      }

      const wazirId = Object.keys(room.roles).find(id => room.roles[id] === 'Wazir');
      const chorId = Object.keys(room.roles).find(id => room.roles[id] === 'Chor');

      // Verification: Only Wazir can make the guess
      if (socket.id !== wazirId) {
        return socket.emit('error-message', 'Only the Wazir can make a guess.');
      }

      const isCorrect = (guessedPlayerId === chorId);

      // Scoring Rules
      room.players.forEach(player => {
        if (player.isSpectator) return;

        const role = room.roles[player.id];
        if (role === 'Raja') {
          room.scores[player.id] += 1000;
        } else if (role === 'Sipahi') {
          room.scores[player.id] += 500;
        } else if (role === 'Wazir') {
          room.scores[player.id] += isCorrect ? 800 : 0;
        } else if (role === 'Chor') {
          room.scores[player.id] += isCorrect ? 0 : 800;
        }
      });

      if (room.currentRound >= TOTAL_ROUNDS) {
        room.gameState = 'SESSION_OVER';

        const maxScore = Math.max(...Object.values(room.scores));
        const winners = room.players
          .filter(p => room.scores[p.id] === maxScore)
          .map(p => p.name);

        io.to(roomId).emit('sessionEnded', {
          scores: room.scores,
          roles: room.roles,
          winners: winners,
          isCorrect
        });
      } else {
        room.gameState = 'ROUND_OVER';
        io.to(roomId).emit('roundEnded', {
          scores: room.scores,
          roles: room.roles,
          isCorrect,
          chorId,
          currentRound: room.currentRound
        });
      }
    });

    // Proceed to Next Round
    socket.on('nextRound', ({ roomId }) => {
      const room = rooms.get(roomId);

      if (!room || socket.id !== room.host) return;

      if (room.gameState === 'ROUND_OVER') {
        room.currentRound += 1;
        startNewRound(roomId);
      }
    });

    // Reset Session
    socket.on('nextSession', ({ roomId }) => {
      const room = rooms.get(roomId);

      if (!room || socket.id !== room.host) return;

      room.currentRound = 1;

      room.players.forEach(p => {
        if (!p.isSpectator) {
          room.scores[p.id] = 0;
        }
      });

      startNewRound(roomId);
    });

    // Text Chat
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

    // Voice Chat Signaling & Controls
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

      const activeVoiceParticipants = Object.entries(room.voiceStates)
        .filter(([id, state]) => state.voiceJoined && id !== socket.id)
        .map(([id, state]) => ({ socketId: id, peerId: state.peerId }));

      socket.emit('voice-participants', activeVoiceParticipants);
      socket.to(roomId).emit('user-connected-voice', { socketId: socket.id, peerId });
      broadcastVoiceStateUpdate(roomId);
    });

    socket.on('voice-mute-self', ({ roomId, selfMuted }) => {
      const room = rooms.get(roomId);
      if (!room || !room.voiceStates[socket.id]) return;

      room.voiceStates[socket.id].selfMuted = Boolean(selfMuted);
      broadcastVoiceStateUpdate(roomId);
    });

    socket.on('host-mute-player', ({ roomId, targetSocketId }) => {
      const room = rooms.get(roomId);
      if (!room || socket.id !== room.host) return;

      if (room.voiceStates[targetSocketId]) {
        room.voiceStates[targetSocketId].hostMuted = true;
        io.to(targetSocketId).emit('force-host-mute', { hostMuted: true });
        broadcastVoiceStateUpdate(roomId);
      }
    });

    socket.on('host-unmute-player', ({ roomId, targetSocketId }) => {
      const room = rooms.get(roomId);
      if (!room || socket.id !== room.host) return;

      if (room.voiceStates[targetSocketId]) {
        room.voiceStates[targetSocketId].hostMuted = false;
        io.to(targetSocketId).emit('force-host-mute', { hostMuted: false });
        broadcastVoiceStateUpdate(roomId);
      }
    });

    socket.on('host-mute-all', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || socket.id !== room.host) return;

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
      if (!room || socket.id !== room.host) return;

      Object.keys(room.voiceStates).forEach((sId) => {
        if (sId !== room.host) {
          room.voiceStates[sId].hostMuted = false;
          io.to(sId).emit('force-host-mute', { hostMuted: false });
        }
      });
      broadcastVoiceStateUpdate(roomId);
    });

    // Disconnect & Room Cleanup
    socket.on('disconnect', () => {
      console.log(`User Disconnected: ${socket.id}`);
      rooms.forEach((room, roomId) => {
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
          const leavingPlayer = room.players[playerIndex];

          const leaveMessage = {
            system: true,
            text: `${leavingPlayer.name} left the room.`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };

          room.chatMessages.push(leaveMessage);
          io.to(roomId).emit('receive-message', leaveMessage);

          room.players.splice(playerIndex, 1);
          delete room.scores[socket.id];
          delete room.voiceStates[socket.id];

          socket.to(roomId).emit('user-disconnected-voice', { socketId: socket.id });
          socket.to(roomId).emit('player-left', { socketId: socket.id, room });

          if (room.players.length === 0) {
            rooms.delete(roomId);
          } else if (room.host === socket.id) {
            const newHost = room.players.find(p => !p.isSpectator);

            if (newHost) {
              room.host = newHost.id;
              newHost.isHost = true;

              io.to(roomId).emit('host-changed', {
                newHostId: room.host,
                room
              });
            }
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
    console.log(`Chor Sipahi Game Server running on port ${PORT}`);
  })
});