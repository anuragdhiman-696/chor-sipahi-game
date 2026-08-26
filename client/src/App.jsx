import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Peer from 'peerjs';
import './App.css';

// Change URL to match your Express server port (default 5000 or process.env.PORT)
const SOCKET_SERVER_URL = 'http://localhost:4000';

const socket = io(SOCKET_SERVER_URL, { autoConnect: true });

export default function App() {
  // Connection State
  const [isConnected, setIsConnected] = useState(socket.connected);

  // Navigation & Room State
  const [playerName, setPlayerName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [currentRoom, setCurrentRoom] = useState(null);
  const [joined, setJoined] = useState(false);

  // Game Logic State
  const [myRole, setMyRole] = useState(null);
  const [scores, setScores] = useState({});
  const [roles, setRoles] = useState({});
  const [currentRound, setCurrentRound] = useState(1);
  const [gameState, setGameState] = useState('WAITING'); // WAITING, GUESSING, ROUND_OVER, SESSION_OVER
  const [isChitRevealed, setIsChitRevealed] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [lastGuessResult, setLastGuessResult] = useState(null);
  const [sessionWinners, setSessionWinners] = useState([]);

  // Text Chat State
  const [chatMessages, setChatMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const chatBottomRef = useRef(null);

  // Voice Chat (PeerJS) State
  const [isVoiceConnected, setIsVoiceConnected] = useState(false);
  const [isSelfMuted, setIsSelfMuted] = useState(false);
  const [speakingPlayers, setSpeakingPlayers] = useState({});
  const [mutedPlayers, setMutedPlayers] = useState({});

  const peerInstance = useRef(null);
  const localStream = useRef(null);
  const peerConnections = useRef({});
  const audioElements = useRef({});

  // -------------------------------------------------------------
  // SOCKET.IO LISTENERS & GAME STATE SYNC
  // -------------------------------------------------------------
  useEffect(() => {
    // Socket Connection Listeners
    function onConnect() {
      setIsConnected(true);
      console.log('Connected to server with ID:', socket.id);
    }

    function onDisconnect() {
      setIsConnected(false);
      console.log('Disconnected from server');
    }

    function onConnectError(err) {
      setIsConnected(false);
      console.error('Connection error:', err.message);
    }

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);

    // Room Listeners
    socket.on('room-created', ({ room }) => {
      setCurrentRoom(room);
      setGameState(room.gameState);
      setJoined(true);
    });

    socket.on('room-joined', ({ room }) => {
      setCurrentRoom(room);
      setJoined(true);
    });

    socket.on('player-joined', ({ room }) => {
      setCurrentRoom(room);
    });

    socket.on('player-left', ({ room }) => {
      setCurrentRoom(room);
    });

    socket.on('host-changed', ({ room }) => {
      setCurrentRoom(room);
    });

    // Game Event Listeners
    socket.on('roundStarted', (data) => {
      setRoles(data.roles);
      setScores(data.scores);
      setCurrentRound(data.currentRound);
      setGameState('GUESSING');
      setIsChitRevealed(false);
      setLastGuessResult(null);
      setSelectedTarget(null);

      if (data.roles && data.roles[socket.id]) {
        setMyRole(data.roles[socket.id]);
      }
    });

    socket.on('roundEnded', (data) => {
      setScores(data.scores);
      setRoles(data.roles);
      setGameState('ROUND_OVER');
      setLastGuessResult({
        isCorrect: data.isCorrect,
        message: data.isCorrect ? 'Correct Guess! Wazir caught the Chor!' : 'Wrong Guess! Chor escaped!'
      });
    });

    socket.on('sessionEnded', (data) => {
      setScores(data.scores);
      setRoles(data.roles);
      setSessionWinners(data.winners);
      setGameState('SESSION_OVER');
      setLastGuessResult({
        isCorrect: data.isCorrect,
        message: data.isCorrect ? 'Correct Final Guess!' : 'Wrong Final Guess!'
      });
    });

    // Chat Listeners
    socket.on('chat-history', (messages) => {
      setChatMessages(messages || []);
    });

    socket.on('receive-message', (msg) => {
      setChatMessages((prev) => [...prev, msg]);
    });

    socket.on('error-message', (msg) => {
      alert(msg);
    });

    // Voice Sync Listeners
    socket.on('voice-state-updated', (voiceStates) => {
      const mPlayers = {};
      Object.entries(voiceStates || {}).forEach(([id, state]) => {
        if (state.hostMuted || state.selfMuted) {
          mPlayers[id] = true;
        }
      });
      setMutedPlayers(mPlayers);
    });

    socket.on('force-host-mute', ({ hostMuted }) => {
      if (localStream.current) {
        localStream.current.getAudioTracks().forEach((track) => {
          track.enabled = !hostMuted;
        });
      }
      setIsSelfMuted(hostMuted);
    });

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off();
    };
  }, []);

  // Auto-scroll chat window
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // -------------------------------------------------------------
  // PEERJS VOICE CHAT SYSTEM
  // -------------------------------------------------------------
  const initPeerJS = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStream.current = stream;

      const peer = new Peer(undefined, {
        host: '0.peerjs.com',
        port: 443,
        path: '/',
        secure: true
      });

      peerInstance.current = peer;

      peer.on('open', (id) => {
        setIsVoiceConnected(true);
        socket.emit('join-voice', { roomId: currentRoom.code, peerId: id });
      });

      peer.on('call', (call) => {
        call.answer(localStream.current);
        call.on('stream', (remoteStream) => {
          attachRemoteStream(call.peer, remoteStream);
        });
      });

      socket.on('voice-participants', (participants) => {
        participants.forEach(({ peerId: remotePeerId }) => {
          connectToNewUser(remotePeerId, stream);
        });
      });

      socket.on('user-connected-voice', ({ peerId: remotePeerId }) => {
        connectToNewUser(remotePeerId, stream);
      });

      socket.on('user-disconnected-voice', ({ socketId }) => {
        if (peerConnections.current[socketId]) {
          peerConnections.current[socketId].close();
          delete peerConnections.current[socketId];
        }
        if (audioElements.current[socketId]) {
          audioElements.current[socketId].remove();
          delete audioElements.current[socketId];
        }
      });
    } catch (err) {
      console.error('Microphone access failed:', err);
      alert('Microphone permission required for Voice Chat.');
    }
  };

  const connectToNewUser = (remotePeerId, stream) => {
    if (!peerInstance.current) return;
    const call = peerInstance.current.call(remotePeerId, stream);
    peerConnections.current[remotePeerId] = call;

    call.on('stream', (remoteStream) => {
      attachRemoteStream(remotePeerId, remoteStream);
    });
  };

  const attachRemoteStream = (remotePeerId, stream) => {
    if (audioElements.current[remotePeerId]) return;

    const audio = document.createElement('audio');
    audio.srcObject = stream;
    audio.autoplay = true;
    audioElements.current[remotePeerId] = audio;

    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const checkVolume = () => {
      analyser.getByteFrequencyData(dataArray);
      let values = 0;
      for (let i = 0; i < dataArray.length; i++) {
        values += dataArray[i];
      }
      const average = values / dataArray.length;
      setSpeakingPlayers((prev) => ({
        ...prev,
        [remotePeerId]: average > 25,
      }));
      requestAnimationFrame(checkVolume);
    };
    checkVolume();
  };

  const toggleSelfMute = () => {
    if (!localStream.current) return;
    const audioTrack = localStream.current.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      const mutedState = !audioTrack.enabled;
      setIsSelfMuted(mutedState);
      socket.emit('voice-mute-self', { roomId: currentRoom?.code, selfMuted: mutedState });
    }
  };

  // -------------------------------------------------------------
  // ACTION HANDLERS
  // -------------------------------------------------------------
  const handleCreateRoom = () => {
    if (!playerName.trim()) return alert('Please enter your name');
    socket.emit('create-room', { playerName });
  };

  const handleJoinRoom = () => {
    if (!playerName.trim() || !roomCode.trim()) return alert('Please enter your name and room code');
    socket.emit('join-room', { roomId: roomCode.trim().toUpperCase(), playerName });
  };

  const handleStartGame = () => {
    socket.emit('start-game', { roomId: currentRoom.code });
  };

  const handleMakeGuess = () => {
    if (!selectedTarget) return alert('Select a player to guess as Chor!');
    socket.emit('makeGuess', { roomId: currentRoom.code, guessedPlayerId: selectedTarget });
  };

  const handleNextRound = () => {
    socket.emit('nextRound', { roomId: currentRoom.code });
  };

  const handleNextSession = () => {
    setSessionWinners([]);
    socket.emit('nextSession', { roomId: currentRoom.code });
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !currentRoom) return;
    socket.emit('send-message', { roomId: currentRoom.code, message: newMessage.trim() });
    setNewMessage('');
  };

  const handleHostMutePlayer = (targetSocketId) => {
    if (mutedPlayers[targetSocketId]) {
      socket.emit('host-unmute-player', { roomId: currentRoom.code, targetSocketId });
    } else {
      socket.emit('host-mute-player', { roomId: currentRoom.code, targetSocketId });
    }
  };

  const isWazir = myRole === 'Wazir';
  const isHost = currentRoom?.host === socket.id;

  // Reusable Connection Status Indicator Bar
  const renderConnectionBar = () => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        padding: '8px 16px',
        backgroundColor: isConnected ? '#e6fffa' : '#ffebe9',
        color: isConnected ? '#137333' : '#c5221f',
        border: `1px solid ${isConnected ? '#34a853' : '#ea4335'}`,
        borderRadius: '8px',
        marginBottom: '20px',
        fontWeight: 'bold',
        fontSize: '14px',
      }}
    >
      <span
        style={{
          height: '10px',
          width: '10px',
          borderRadius: '50%',
          backgroundColor: isConnected ? '#34a853' : '#ea4335',
          display: 'inline-block',
        }}
      />
      {isConnected ? 'Server Connected' : 'Server Disconnected (Checking Connection...)'}
    </div>
  );

  // -------------------------------------------------------------
  // RENDERING VIEWS
  // -------------------------------------------------------------

  // 1. Lobby Entry Screen
  if (!joined) {
    return (
      <div className="container center">
        {renderConnectionBar()}
        <h1 className="main-title">👑 Raja Mantri Chor Sipahi</h1>
        <p className="subtitle">Real-time Multiplayer Game with Voice Chat</p>
        <div className="card">
          <label>Display Name</label>
          <input
            type="text"
            placeholder="Enter your name..."
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
          />
          <div className="button-group">
            <button className="btn btn-primary" onClick={handleCreateRoom} disabled={!isConnected}>
              Create New Room
            </button>
          </div>
          <div className="divider">OR</div>
          <label>Room Code</label>
          <input
            type="text"
            placeholder="Enter 6-character Code"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value)}
          />
          <div className="button-group">
            <button className="btn btn-secondary" onClick={handleJoinRoom} disabled={!isConnected}>
              Join Room
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 2. Waiting Room Lobby
  if (gameState === 'WAITING') {
    const activePlayers = currentRoom?.players?.filter((p) => !p.isSpectator) || [];
    return (
      <div className="container center">
        {renderConnectionBar()}
        <h2>Room Code: <span className="highlight">{currentRoom?.code}</span></h2>
        <div className="card">
          <h3>
            Players ({activePlayers.length}/4)
            {currentRoom?.players?.some((p) => p.isSpectator) &&
              ` • Spectators: ${currentRoom.players.filter((p) => p.isSpectator).length}`}
          </h3>
          <ul className="lobby-player-list">
            {currentRoom?.players?.map((p) => (
              <li key={p.id} className="lobby-player-item">
                <span>
                  {p.name} {p.id === socket.id ? '(You)' : ''}
                  {p.isSpectator && <span className="spectator-badge"> 👁 Spectator</span>}
                </span>
                {p.id === currentRoom.host && <span className="host-badge">👑 Host</span>}
              </li>
            ))}
          </ul>

          <div className="voice-setup">
            {!isVoiceConnected ? (
              <button className="btn btn-secondary" onClick={initPeerJS}>
                🎙️ Connect to Voice Chat
              </button>
            ) : (
              <button className={`btn ${isSelfMuted ? 'btn-danger' : 'btn-success'}`} onClick={toggleSelfMute}>
                {isSelfMuted ? '🔇 Unmute Microphone' : '🎙️ Mute Microphone'}
              </button>
            )}
          </div>

          <div className="chat-box lobby-chat">
            <h3>💬 Room Chat</h3>
            <div className="chat-messages">
              {chatMessages.map((msg, index) => (
                <div key={index} className={`chat-message ${msg.system ? 'system-message' : ''}`}>
                  {msg.system ? (
                    <em>{msg.text}</em>
                  ) : (
                    <>
                      <strong>{msg.sender}: </strong>
                      <span>{msg.text}</span>
                    </>
                  )}
                </div>
              ))}
              <div ref={chatBottomRef} />
            </div>
            <form onSubmit={handleSendMessage} className="chat-input-form">
              <input
                type="text"
                placeholder="Type a message..."
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
              />
              <button type="submit" className="btn btn-primary btn-sm">
                Send
              </button>
            </form>
          </div>

          {isHost ? (
            <div className="host-actions">
              <button
                className="btn btn-primary"
                onClick={handleStartGame}
                disabled={activePlayers.length !== 4}
              >
                {activePlayers.length === 4 ? '🚀 Start Game' : 'Waiting for 4 Players...'}
              </button>
            </div>
          ) : (
            <p className="waiting-text">Waiting for the host to start the game...</p>
          )}
        </div>
      </div>
    );
  }

  // 3. Main Gameplay Board
  return (
    <div className="container">
      {renderConnectionBar()}
      <header className="header">
        <div>
          <h2>Raja Mantri Chor Sipahi</h2>
          <span className="room-tag">Room: {currentRoom?.code}</span>
        </div>
        <div className="round-info">
          <span>Round <strong>{currentRound}</strong> / 20</span>
        </div>
      </header>

      {lastGuessResult && (
        <div className={`guess-result-banner ${lastGuessResult.isCorrect ? 'success' : 'failure'}`}>
          {lastGuessResult.message}
        </div>
      )}

      <div className="main-layout">
        {/* Chit Component */}
        <div className="chit-section">
          <h3>Your Secret Chit</h3>
          <div
            className={`chit-card ${isChitRevealed ? 'unfolded' : 'folded'}`}
            onClick={() => myRole && setIsChitRevealed((prev) => !prev)}
          >
            {isChitRevealed && myRole ? (
              <>
                <span className="chit-stamp">ROYAL DECREE</span>
                <span className="chit-role-title">{myRole}</span>
              </>
            ) : (
              <>
                <span className="chit-stamp">SECRET ROLE</span>
                <span className="chit-icon">📜</span>
                <span className="chit-hint">Tap to Unfold Chit</span>
              </>
            )}
          </div>

          <button
            className="btn btn-secondary"
            style={{ marginTop: '15px' }}
            onClick={() => setIsChitRevealed((prev) => !prev)}
            disabled={!myRole}
          >
            {isChitRevealed ? 'Fold & Hide Role' : 'Reveal Role'}
          </button>

          {/* Voice Sidebar */}
          <div className="voice-controls-panel">
            <h4>🎙️ Voice Chat</h4>
            {!isVoiceConnected ? (
              <button className="btn btn-secondary btn-sm" onClick={initPeerJS}>
                Join Voice
              </button>
            ) : (
              <button
                className={`btn btn-sm ${isSelfMuted ? 'btn-danger' : 'btn-success'}`}
                onClick={toggleSelfMute}
              >
                {isSelfMuted ? 'Unmute Mic' : 'Mute Mic'}
              </button>
            )}
          </div>
        </div>

        {/* Players Grid */}
        <div className="players-section">
          <h3>Players Board</h3>
          <div className="players-grid">
            {currentRoom?.players
              ?.filter((p) => !p.isSpectator)
              .map((p) => {
                const isMe = p.id === socket.id;
                const canTarget = isWazir && !isMe && gameState === 'GUESSING';
                const showRole = gameState !== 'GUESSING' || isMe;
                const isMuted = mutedPlayers[p.id];

                return (
                  <div
                    key={p.id}
                    className={`player-card ${selectedTarget === p.id ? 'selected' : ''}`}
                    onClick={() => canTarget && setSelectedTarget(p.id)}
                  >
                    <div className="player-card-header">
                      <span className="player-name">
                        {p.name} {isMe ? '(You)' : ''}
                      </span>
                      {isMuted && <span className="muted-icon">🔇</span>}
                    </div>

                    <div className="player-score">Score: {scores[p.id] || 0}</div>
                    <div className="player-role">Role: {showRole ? roles[p.id] : '???'}</div>

                    {isHost && !isMe && (
                      <button
                        className="btn-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleHostMutePlayer(p.id);
                        }}
                      >
                        {isMuted ? 'Unmute' : 'Mute'}
                      </button>
                    )}
                  </div>
                );
              })}
          </div>

          {/* Wazir Guess Control */}
          {isWazir && gameState === 'GUESSING' && (
            <div className="wazir-controls">
              <p>You are the <strong>Wazir</strong>! Select a player and guess who holds the <strong>Chor</strong> role.</p>
              <button className="btn btn-primary" onClick={handleMakeGuess} disabled={!selectedTarget}>
                Confirm Guess
              </button>
            </div>
          )}

          {/* Round Controls */}
          {gameState === 'ROUND_OVER' && (
            <div className="host-controls">
              <button className="btn btn-primary" onClick={handleNextRound}>
                Next Round ➔
              </button>
            </div>
          )}

          {/* Chat Window */}
          <div className="chat-box">
            <div className="chat-messages">
              {chatMessages.map((msg, index) => (
                <div key={index} className="chat-message">
                  <strong>{msg.sender}: </strong>
                  <span>{msg.text}</span>
                </div>
              ))}
              <div ref={chatBottomRef} />
            </div>
            <form onSubmit={handleSendMessage} className="chat-input-form">
              <input
                type="text"
                placeholder="Type a message..."
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
              />
              <button type="submit" className="btn btn-primary btn-sm">
                Send
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Session Winner Modal */}
      {gameState === 'SESSION_OVER' && sessionWinners.length > 0 && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>🏆 Game Session Over!</h2>
            <h3 className="winner-title">
              Winner: {sessionWinners.join(', ')}
            </h3>
            <div className="leaderboard">
              <h4>Final Scores</h4>
              <ul>
                {currentRoom?.players
                  ?.filter((p) => !p.isSpectator)
                  .map((player) => (
                    <li key={player.id}>
                      <span>{player.name}</span>
                      <strong>{scores[player.id] || 0} pts</strong>
                    </li>
                  ))}
              </ul>
            </div>
            <button className="btn btn-primary" onClick={handleNextSession}>
              Start Next Session 🔄
            </button>
          </div>
        </div>
      )}
    </div>
  );
}