import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Peer from 'peerjs';
import './App.css';

const SOCKET_SERVER_URL = 'https://chor-sipahi-game.onrender.com';

const socket = io(SOCKET_SERVER_URL, {
  autoConnect: true,
});

function App() {
  // Navigation & Lobby State
  const [playerName, setPlayerName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [currentRoom, setCurrentRoom] = useState(null);
  const [gameState, setGameState] = useState('lobby');

  // Game Logic State
  const [myRole, setMyRole] = useState(null);
  const [isChitRevealed, setIsChitRevealed] = useState(false);
  const [wazirSocketId, setWazirSocketId] = useState(null);
  const [roundEnded, setRoundEnded] = useState(false);
  const [lastGuessResult, setLastGuessResult] = useState(null);
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [sessionWinner, setSessionWinner] = useState(null);

  // Chat State
  const [chatMessages, setChatMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const chatBottomRef = useRef(null);

  // Voice Chat (PeerJS) State
  const [peerId, setPeerId] = useState('');
  const [isVoiceConnected, setIsVoiceConnected] = useState(false);
  const [isSelfMuted, setIsSelfMuted] = useState(false);
  const [speakingPlayers, setSpeakingPlayers] = useState({});
  const [mutedPlayers, setMutedPlayers] = useState({});

  const peerInstance = useRef(null);
  const localStream = useRef(null);
  const peerConnections = useRef({});
  const audioElements = useRef({});

  // -------------------------------------------------------------
  // SOCKET.IO EVENT LISTENERS & GAME STATE MANAGEMENT
  // -------------------------------------------------------------
  useEffect(() => {
    socket.on('chat-history', (messages) => {
      setChatMessages(messages || []);
    });

    socket.on('connect', () => {
      console.log('Connected to socket server:', socket.id);
    });

    socket.on('room-created', ({ room }) => {
      setCurrentRoom(room);
    });

    socket.on('room-joined', ({ room }) => {
      setCurrentRoom(room);
    });

    socket.on('player-joined', ({ room }) => {
      setCurrentRoom(room);
    });

    socket.on('player-left', ({ room }) => {
      setCurrentRoom(room);
    });

    socket.on('game-started', ({ room, roles, wazirId }) => {
      setCurrentRoom(room);
      setGameState('playing');
      setRoundEnded(false);
      setIsChitRevealed(false);
      setSessionWinner(null);
      setLastGuessResult(null);
      setSelectedTarget(null);
      setWazirSocketId(wazirId);

      if (roles && roles[socket.id]) {
        setMyRole(roles[socket.id]);
      }
    });

    socket.on('round-updated', ({ room, roles, wazirId }) => {
      setCurrentRoom(room);
      setRoundEnded(false);
      setIsChitRevealed(false);
      setLastGuessResult(null);
      setSelectedTarget(null);
      setWazirSocketId(wazirId);

      if (roles && roles[socket.id]) {
        setMyRole(roles[socket.id]);
      }
    });

    socket.on('round-over', ({ room, result }) => {
      setCurrentRoom(room);
      setRoundEnded(true);
      setLastGuessResult(result);
    });

    socket.on('session-ended', ({ room, winner }) => {
      setCurrentRoom(room);
      setGameState('ended');
      setSessionWinner(winner);
    });

    socket.on('receive-message', (msg) => {
      setChatMessages((prev) => [...prev, msg]);
    });

    socket.on('error-message', (msg) => {
      alert(msg);
    });

    // Voice Sync Listeners
    socket.on('voice-state-updated', ({ mutedPlayersMap }) => {
      setMutedPlayers(mutedPlayersMap || {});
    });

    socket.on('force-host-mute', ({ isMuted }) => {
      if (localStream.current) {
        localStream.current.getAudioTracks().forEach((track) => {
          track.enabled = !isMuted;
        });
      }
      setIsSelfMuted(isMuted);
    });

    return () => {
      socket.off('connect');
      socket.off('room-created');
      socket.off('room-joined');
      socket.off('player-joined');
      socket.off('player-left');
      socket.off('game-started');
      socket.off('round-updated');
      socket.off('round-over');
      socket.off('session-ended');
      socket.off('receive-message');
      socket.off('error-message');
      socket.off('voice-state-updated');
      socket.off('force-host-mute');
      socket.off('chat-history');
    };
  }, []);

  // Auto scroll text chat
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Force hide role chit when starting new round/session
  useEffect(() => {
    if (gameState === 'playing') {
      setIsChitRevealed(false);
    }
  }, [currentRoom?.round, gameState]);

  // -------------------------------------------------------------
  // PEERJS VOICE CHAT LOGIC
  // -------------------------------------------------------------
  const initPeerJS = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStream.current = stream;

      const peer = new Peer(undefined, {
        host: '0.peerjs.com',
        port: 443,
        path: '/',
        secure: true,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
          ],
        },
      });

      peerInstance.current = peer;

      peer.on('open', (id) => {
        setPeerId(id);
        setIsVoiceConnected(true);
        socket.emit('join-voice', { roomId: currentRoom.code, peerId: id });
      });

      peer.on('call', (call) => {
        call.answer(localStream.current);
        call.on('stream', (remoteStream) => {
          attachRemoteStream(call.peer, remoteStream);
        });
      });

      socket.on('user-connected-voice', ({ peerId: remotePeerId }) => {
        connectToNewUser(remotePeerId, localStream.current);
      });

      socket.on('user-disconnected-voice', ({ peerId: remotePeerId }) => {
        if (peerConnections.current[remotePeerId]) {
          peerConnections.current[remotePeerId].close();
          delete peerConnections.current[remotePeerId];
        }
        if (audioElements.current[remotePeerId]) {
          audioElements.current[remotePeerId].remove();
          delete audioElements.current[remotePeerId];
        }
      });
    } catch (err) {
      console.error('Failed to get audio stream:', err);
      alert('Microphone access is required for voice chat.');
    }
  };

  const connectToNewUser = (remotePeerId, stream) => {
    if (!peerInstance.current) return;
    const call = peerInstance.current.call(remotePeerId, stream);
    peerConnections.current[remotePeerId] = call;

    call.on('stream', (remoteStream) => {
      attachRemoteStream(remotePeerId, remoteStream);
    });

    call.on('close', () => {
      if (audioElements.current[remotePeerId]) {
        audioElements.current[remotePeerId].remove();
        delete audioElements.current[remotePeerId];
      }
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
  // EVENT HANDLERS
  // -------------------------------------------------------------
  const handleCreateRoom = () => {
    if (!playerName.trim()) return alert('Please enter your name');
    socket.emit('create-room', { playerName });
  };

  const handleJoinRoom = () => {
    if (!playerName.trim() || !roomCode.trim()) return alert('Please enter your name and room code');
    socket.emit('join-room', { roomId: roomCode.toUpperCase(), playerName });
  };

  const handleStartGame = () => {
    if (currentRoom?.players?.length !== 4) return alert('Exactly 4 players are required to start.');
    socket.emit('start-game', { roomId: currentRoom.code });
  };

  const handleMakeGuess = () => {
    if (!selectedTarget) return alert('Select a player to guess as Chor!');
    socket.emit('make-guess', { roomId: currentRoom.code, targetSocketId: selectedTarget });
  };

  const handleNextRound = () => {
    socket.emit('next-round', { roomId: currentRoom.code });
  };

  const handleNextSession = () => {
    socket.emit('next-session', { roomId: currentRoom.code });
  };

  const handleSendMessage = (e) => {
    e.preventDefault();

    if (!newMessage.trim() || !currentRoom) return;

    socket.emit('send-message', {
      roomId: currentRoom.code,
      message: newMessage.trim()
    });

    setNewMessage('');
  };

  const handleHostMutePlayer = (targetSocketId) => {
    const isCurrentlyMuted = mutedPlayers[targetSocketId];
    if (isCurrentlyMuted) {
      socket.emit('host-unmute-player', { roomId: currentRoom.code, targetSocketId });
    } else {
      socket.emit('host-mute-player', { roomId: currentRoom.code, targetSocketId });
    }
  };

  const handleHostMuteAll = () => {
    socket.emit('host-mute-all', { roomId: currentRoom.code });
  };

  const handleHostUnmuteAll = () => {
    socket.emit('host-unmute-all', { roomId: currentRoom.code });
  };

  const getRolePoints = (role) => {
    switch (role) {
      case 'Raja': return 1000;
      case 'Wazir': return 800;
      case 'Sipahi': return 500;
      case 'Chor': return 0;
      default: return 0;
    }
  };

  // Lobby Entry Screen
  if (gameState === 'lobby' && !currentRoom) {
    return (
      <div className="container center">
        <h1 className="main-title">👑 Chor-Sipahi Multiplayer</h1>
        <p className="subtitle">Real-time multiplayer paper chit guessing game</p>
        <div className="card">
          <label>Display Name</label>
          <input
            type="text"
            placeholder="Enter your name..."
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
          />
          <div className="button-group">
            <button className="btn btn-primary" onClick={handleCreateRoom}>
              Create New Room
            </button>
          </div>
          <div className="divider">OR</div>
          <label>Room Code</label>
          <input
            type="text"
            placeholder="Enter 6-digit Code"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value)}
          />
          <div className="button-group">
            <button className="btn btn-secondary" onClick={handleJoinRoom}>
              Join Room
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Waiting Room / Lobby
  if (gameState === 'lobby' && currentRoom) {
    const isHost = currentRoom.host === socket.id;
    return (
      <div className="container center">
        <h2>Room Code: <span className="highlight">{currentRoom.code}</span></h2>
        <div className="card">
          <h3>
            Players ({currentRoom.players.filter(p => !p.isSpectator).length}/4)
            {currentRoom.players.some(p => p.isSpectator) &&
              ` • Spectators: ${currentRoom.players.filter(p => p.isSpectator).length}`}
          </h3>
          <ul className="lobby-player-list">
            {currentRoom.players.map((p) => (
              <li key={p.id} className="lobby-player-item">
                <span>
                  {p.name} {p.id === socket.id ? '(You)' : ''}
                  {p.isSpectator && (
                    <span className="spectator-badge"> 👁 Spectator</span>
                  )}
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
                <div
                  key={index}
                  className={`chat-message ${msg.system ? 'system-message' : ''}`}
                >
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
                disabled={currentRoom.players.filter(p => !p.isSpectator).length !== 4}
              >
                {currentRoom.players.filter(p => !p.isSpectator).length === 4
                  ? '🚀 Start Game'
                  : 'Waiting for 4 Players...'}
              </button>
            </div>
          ) : (
            <p className="waiting-text">Waiting for host to start the game...</p>
          )}
        </div>
      </div>
    );
  }

  // Main Playing Screen
  return (
    <div className="container">
      <header className="header">
        <div>
          <h2>Chor-Sipahi</h2>
          <span className="room-tag">Room: {currentRoom?.code}</span>
        </div>
        <div className="round-info">
          <span>Round <strong>{currentRoom?.round || 1}</strong> / 5</span>
        </div>
      </header>

      {lastGuessResult && (
        <div className={`guess-result-banner ${lastGuessResult.correct ? 'success' : 'failure'}`}>
          {lastGuessResult.correct
            ? `🎉 Perfect Guess! ${lastGuessResult.wazirName} correctly caught ${lastGuessResult.chorName} as the Chor!`
            : `❌ Incorrect Guess! ${lastGuessResult.chorName} was the real Chor! Points lost.`}
        </div>
      )}

      <div className="main-layout">
        {/* Chit Section */}
        <div className="chit-section">
          <h3>Your Secret Chit</h3>
          <div
            className={`chit-card ${isChitRevealed ? 'unfolded' : 'folded'}`}
            onClick={() => {
              if (myRole) setIsChitRevealed((prev) => !prev);
            }}
          >
            {isChitRevealed && myRole ? (
              <>
                <span className="chit-stamp">ROYAL DECREE</span>
                <span className="chit-role-title">{myRole}</span>
                <span className="chit-role-points">Base: +{getRolePoints(myRole)} Pts</span>
              </>
            ) : (
              <>
                <span className="chit-stamp">RAJA WAZIR CHOR SIPAHI</span>
                <span className="chit-icon">📜</span>
                <span className="chit-hint">
                  {myRole ? 'Tap to Unfold Chit' : 'Assigning Role...'}
                </span>
              </>
            )}
          </div>

          <button
            className="btn btn-secondary"
            style={{ marginTop: '15px' }}
            onClick={() => setIsChitRevealed((prev) => !prev)}
            disabled={!myRole}
          >
            {!myRole ? 'Assigning Role...' : isChitRevealed ? 'Fold & Hide Role' : 'Reveal Role'}
          </button>

          {/* Voice Controls Sidebar */}
          <div className="voice-controls-panel">
            <h4>🎙️ Voice Control</h4>
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

            {currentRoom?.host === socket.id && (
              <div className="host-voice-buttons">
                <button className="btn btn-danger btn-sm" onClick={handleHostMuteAll}>
                  Mute All
                </button>
                <button className="btn btn-secondary btn-sm" onClick={handleHostUnmuteAll}>
                  Unmute All
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Board & Players */}
        <div className="players-section">
          <h3>Players Board</h3>
          <div className="players-grid">
            {currentRoom?.players
              .filter(p => !p.isSpectator)
              .map((p) => {
                const isMe = p.id === socket.id;
                const isWazir = socket.id === wazirSocketId;
                const isTargetable = isWazir && !isMe && !roundEnded;
                const isSpeaking = speakingPlayers[p.peerId];
                const isMuted = mutedPlayers[p.id];

                return (
                  <div
                    key={p.id}
                    className={`player-card ${selectedTarget === p.id ? 'selected' : ''} ${isSpeaking ? 'speaking' : ''}`}
                    onClick={() => isTargetable && setSelectedTarget(p.id)}
                  >
                    <div className="player-card-header">
                      <span className="player-name">
                        {p.name} {isMe ? '(You)' : ''}
                      </span>
                      {isMuted && <span className="muted-icon">🔇</span>}
                    </div>

                    <div className="player-score">Total Score: {p.score || 0}</div>

                    {roundEnded && p.role && (
                      <div className="player-role-revealed">Role: {p.role}</div>
                    )}

                    {currentRoom?.host === socket.id && !isMe && (
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

          {/* Wazir Action Controls */}
          {socket.id === wazirSocketId && !roundEnded && (
            <div className="wazir-controls">
              <p>
                You are the <strong>Wazir</strong>! Identify who holds the <strong>Chor</strong> chit.
              </p>
              <button
                className="btn btn-primary"
                onClick={handleMakeGuess}
                disabled={!selectedTarget}
              >
                Confirm Guess
              </button>
            </div>
          )}

          {/* Host Next Round Controls */}
          {roundEnded && currentRoom?.host === socket.id && (
            <div className="host-controls">
              {currentRoom.round < 5 ? (
                <button className="btn btn-primary" onClick={handleNextRound}>
                  Start Round {currentRoom.round + 1}
                </button>
              ) : (
                <button className="btn btn-primary" onClick={handleNextSession}>
                  End 5-Round Session
                </button>
              )}
            </div>
          )}

          {/* In-game Text Chat */}
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

      {/* Leaderboard Modal on Session End */}
      {gameState === 'ended' && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>🏆 Game Session Over!</h2>
            <h3 className="winner-title">
              Winner: {sessionWinner?.name} ({sessionWinner?.score} pts)
            </h3>
            <div className="leaderboard">
              <h4>Final Scoreboard</h4>
              <ul>
                {currentRoom?.players
                  ?.sort((a, b) => (b.score || 0) - (a.score || 0))
                  .map((player, rank) => (
                    <li key={player.id}>
                      <span>
                        #{rank + 1} {player.name}
                      </span>
                      <strong>{player.score || 0} pts</strong>
                    </li>
                  ))}
              </ul>
            </div>
            <button className="btn btn-primary" onClick={() => setGameState('lobby')}>
              Return to Lobby
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;