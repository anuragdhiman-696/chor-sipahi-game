import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Peer from 'peerjs';
import './App.css';

const SOCKET_SERVER_URL = 'https://chor-sipahi-game.onrender.com';

const socket = io(SOCKET_SERVER_URL, { 
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: 50,
  reconnectionDelay: 1000,
  transports: ['polling', 'websocket']
});

const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  }
};

export default function App() {
  const [playerName, setPlayerName] = useState('');
  const [roomIdInput, setRoomIdInput] = useState('');
  const [currentRoom, setCurrentRoom] = useState(null);
  const [gameState, setGameState] = useState('menu');
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isConnected, setIsConnected] = useState(socket.connected);

  // Voice Chat State
  const [voiceJoined, setVoiceJoined] = useState(false);
  const [selfMuted, setSelfMuted] = useState(false);
  const [hostMuted, setHostMuted] = useState(false);
  const [voiceStates, setVoiceStates] = useState({});
  const [speakingPlayers, setSpeakingPlayers] = useState({});
  const [voiceError, setVoiceError] = useState('');

  // Game Experience State
  const [session, setSession] = useState(1);
  const [round, setRound] = useState(1);
  const [scores, setScores] = useState({});
  const [myRole, setMyRole] = useState(null); // 'Raja', 'Mantri', 'Sipahi', 'Chor'
  const [isChitRevealed, setIsChitRevealed] = useState(false);
  const [sessionWinner, setSessionWinner] = useState(null);
  const [roundEnded, setRoundEnded] = useState(false);

  const peerRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerCallsRef = useRef({});
  const audioElementsRef = useRef({});
  const audioAnalyserRef = useRef(null);

  // Wake up Render instance on mount
  useEffect(() => {
    fetch('https://chor-sipahi-game.onrender.com')
      .then(() => console.log('Server awakened!'))
      .catch((err) => console.error('Server ping failed:', err));
  }, []);

  useEffect(() => {
    const onConnect = () => {
      setIsConnected(true);
      setErrorMessage('');
    };

    const onDisconnect = (reason) => {
      setIsConnected(false);
      setErrorMessage(`Disconnected (${reason}). Reconnecting...`);
    };

    const onConnectError = (err) => {
      setIsConnected(false);
      setErrorMessage(`Connection error: ${err.message}.`);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);

    socket.on('room-created', ({ room }) => {
      setCurrentRoom(room);
      setGameState('lobby');
      setErrorMessage('');
      initScores(room.players);
    });

    socket.on('room-joined', ({ room }) => {
      setCurrentRoom(room);
      setGameState(room.gameState === 'playing' ? 'playing' : 'lobby');
      setErrorMessage('');
      initScores(room.players);
    });

    socket.on('player-joined', ({ room }) => {
      setCurrentRoom(room);
      initScores(room.players);
    });

    socket.on('player-left', ({ socketId, room }) => {
      setCurrentRoom(room);
      removeRemoteAudio(socketId);
    });

    socket.on('receive-message', (msgData) => setMessages((prev) => [...prev, msgData]));

    socket.on('game-started', ({ room, roles }) => {
      setCurrentRoom(room);
      setGameState('playing');
      setRoundEnded(false);
      setIsChitRevealed(false);
      setSessionWinner(null);
      if (roles && roles[socket.id]) {
        setMyRole(roles[socket.id]);
      }
    });

    socket.on('round-updated', ({ currentRound, currentSession, updatedScores, roles }) => {
      setRound(currentRound);
      setSession(currentSession);
      if (updatedScores) setScores(updatedScores);
      if (roles && roles[socket.id]) setMyRole(roles[socket.id]);
      setIsChitRevealed(false);
      setRoundEnded(false);
    });

    socket.on('session-ended', ({ winnerName, finalScores }) => {
      setSessionWinner(winnerName);
      if (finalScores) setScores(finalScores);
      setRoundEnded(true);
    });

    socket.on('error-message', (msg) => setErrorMessage(msg));
    socket.on('voice-state-updated', (updatedVoiceStates) => setVoiceStates(updatedVoiceStates));

    socket.on('force-host-mute', ({ hostMuted: isMutedByHost }) => {
      setHostMuted(isMutedByHost);
      if (localStreamRef.current) {
        const audioTrack = localStreamRef.current.getAudioTracks()[0];
        if (audioTrack) audioTrack.enabled = !(isMutedByHost || selfMuted);
      }
    });

    socket.on('user-disconnected-voice', ({ socketId }) => removeRemoteAudio(socketId));

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('room-created');
      socket.off('room-joined');
      socket.off('player-joined');
      socket.off('player-left');
      socket.off('receive-message');
      socket.off('game-started');
      socket.off('round-updated');
      socket.off('session-ended');
      socket.off('error-message');
      socket.off('voice-state-updated');
      socket.off('force-host-mute');
      socket.off('user-disconnected-voice');
    };
  }, [selfMuted]);

  useEffect(() => {
    return () => cleanupVoice();
  }, []);

  const initScores = (players) => {
    setScores((prev) => {
      const newScores = { ...prev };
      players.forEach((p) => {
        if (newScores[p.id] === undefined) newScores[p.id] = 0;
      });
      return newScores;
    });
  };

  const joinVoiceChannel = async () => {
    if (voiceJoined) return;
    setVoiceError('');

    const requestNativePermission = () => {
      return new Promise((resolve) => {
        if (window.cordova && window.cordova.plugins && window.cordova.plugins.permissions) {
          const permissions = window.cordova.plugins.permissions;
          const permissionName = permissions.RECORD_AUDIO;

          permissions.checkPermission(
            permissionName,
            (status) => {
              if (status.hasPermission) {
                resolve(true);
              } else {
                permissions.requestPermission(
                  permissionName,
                  (reqStatus) => resolve(reqStatus.hasPermission),
                  () => resolve(false)
                );
              }
            },
            () => resolve(false)
          );
        } else {
          resolve(true);
        }
      });
    };

    if (window.cordova) {
      await new Promise((resolve) => {
        if (window.deviceReadyFired) {
          resolve();
        } else {
          document.addEventListener('deviceready', resolve, { once: true });
          setTimeout(resolve, 1000);
        }
      });
    }

    const nativePermissionGranted = await requestNativePermission();
    if (!nativePermissionGranted) {
      setVoiceError('Microphone permission denied by Android.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });

      localStreamRef.current = stream;
      setupAudioAnalyser(stream);

      const peer = new Peer(undefined, PEER_CONFIG);
      peerRef.current = peer;

      peer.on('open', (peerId) => {
        setVoiceJoined(true);
        socket.emit('join-voice', { roomId: currentRoom.id, peerId });
      });

      peer.on('call', (call) => {
        call.answer(localStreamRef.current);
        call.on('stream', (remoteStream) => attachRemoteStream(call.metadata?.socketId, remoteStream));
        call.on('close', () => cleanupCall(call.metadata?.socketId));
        call.on('error', () => cleanupCall(call.metadata?.socketId));
      });

      peer.on('error', (err) => {
        console.error('PeerJS Error:', err);
        setVoiceError('Voice connection error.');
      });

      socket.on('voice-participants', (participants) => {
        participants.forEach(({ socketId, peerId }) => {
          if (peerId && localStreamRef.current) {
            const call = peer.call(peerId, localStreamRef.current, { metadata: { socketId: socket.id } });
            if (call) {
              peerCallsRef.current[socketId] = call;
              call.on('stream', (remoteStream) => attachRemoteStream(socketId, remoteStream));
              call.on('close', () => cleanupCall(socketId));
              call.on('error', () => cleanupCall(socketId));
            }
          }
        });
      });

      socket.on('user-connected-voice', ({ socketId, peerId }) => {
        if (peerId && localStreamRef.current && peerRef.current) {
          const call = peerRef.current.call(peerId, localStreamRef.current, { metadata: { socketId: socket.id } });
          if (call) {
            peerCallsRef.current[socketId] = call;
            call.on('stream', (remoteStream) => attachRemoteStream(socketId, remoteStream));
            call.on('close', () => cleanupCall(socketId));
            call.on('error', () => cleanupCall(socketId));
          }
        }
      });
    } catch (err) {
      console.error('Microphone Error:', err);
      setVoiceError('Microphone permission denied.');
    }
  };

  const setupAudioAnalyser = (stream) => {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser.fftSize = 256;
      source.connect(analyser);
      audioAnalyserRef.current = analyser;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const checkVolume = () => {
        if (!localStreamRef.current) return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        const average = sum / bufferLength;
        const isSpeaking = average > 25 && !selfMuted && !hostMuted;
        setSpeakingPlayers((prev) => ({ ...prev, [socket.id]: isSpeaking }));
        requestAnimationFrame(checkVolume);
      };
      checkVolume();
    } catch (e) {
      console.error('Audio Analyser Error:', e);
    }
  };

  const attachRemoteStream = (remoteSocketId, stream) => {
    if (!remoteSocketId) return;
    let audioEl = audioElementsRef.current[remoteSocketId];
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioElementsRef.current[remoteSocketId] = audioEl;
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = stream;
    audioEl.play().catch((e) => console.log('Autoplay blocked:', e));
  };

  const removeRemoteAudio = (remoteSocketId) => {
    if (audioElementsRef.current[remoteSocketId]) {
      const el = audioElementsRef.current[remoteSocketId];
      el.pause();
      el.srcObject = null;
      if (el.parentNode) el.parentNode.removeChild(el);
      delete audioElementsRef.current[remoteSocketId];
    }
    cleanupCall(remoteSocketId);
  };

  const cleanupCall = (remoteSocketId) => {
    if (peerCallsRef.current[remoteSocketId]) {
      peerCallsRef.current[remoteSocketId].close();
      delete peerCallsRef.current[remoteSocketId];
    }
  };

  const cleanupVoice = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
    Object.keys(audioElementsRef.current).forEach((id) => removeRemoteAudio(id));
    setVoiceJoined(false);
  };

  const toggleSelfMute = () => {
    if (hostMuted) return;
    const newMuteState = !selfMuted;
    setSelfMuted(newMuteState);
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = !newMuteState;
    }
    socket.emit('voice-mute-self', { roomId: currentRoom.id, selfMuted: newMuteState });
  };

  const handleHostMute = (targetSocketId) => socket.emit('host-mute-player', { roomId: currentRoom.id, targetSocketId });
  const handleHostUnmute = (targetSocketId) => socket.emit('host-unmute-player', { roomId: currentRoom.id, targetSocketId });
  const handleHostMuteAll = () => socket.emit('host-mute-all', { roomId: currentRoom.id });
  const handleHostUnmuteAll = () => socket.emit('host-unmute-all', { roomId: currentRoom.id });

  const handleCreateRoom = () => {
    if (!playerName.trim()) return setErrorMessage('Please enter your name.');
    if (!socket.connected) socket.connect();
    socket.emit('create-room', { playerName });
  };

  const handleJoinRoom = () => {
    if (!playerName.trim()) return setErrorMessage('Please enter your name.');
    if (!roomIdInput.trim()) return setErrorMessage('Please enter a Room Code.');
    if (!socket.connected) socket.connect();
    socket.emit('join-room', { roomId: roomIdInput, playerName });
  };

  const handleStartGame = () => {
    if (currentRoom && socket.id === currentRoom.host) {
      socket.emit('start-game', { roomId: currentRoom.id });
    }
  };

  const handleNextRound = () => {
    if (currentRoom && socket.id === currentRoom.host) {
      socket.emit('next-round', { roomId: currentRoom.id });
    }
  };

  const handleNextSession = () => {
    if (currentRoom && socket.id === currentRoom.host) {
      socket.emit('next-session', { roomId: currentRoom.id });
    }
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (newMessage.trim() && currentRoom) {
      socket.emit('send-message', { roomId: currentRoom.id, message: newMessage });
      setNewMessage('');
    }
  };

  const getRolePoints = (role) => {
    switch(role) {
      case 'Raja': return 1000;
      case 'Mantri': return 800;
      case 'Sipahi': return 500;
      case 'Chor': return 0;
      default: return 0;
    }
  };

  const isHost = currentRoom && currentRoom.host === socket.id;

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>CHOR SIPAHI</h1>
        <p className="subtitle">Session {session} | Round {round}</p>
        <div className={`status-indicator ${isConnected ? 'online' : 'offline'}`}>
          <span className="status-dot"></span>
          <span className="status-text">{isConnected ? 'Server Connected' : 'Server Offline'}</span>
        </div>
      </header>

      {errorMessage && <div className="error-banner">{errorMessage}</div>}

      {gameState === 'menu' && (
        <div className="card menu-card">
          <h2>Join Game</h2>
          <div className="input-group">
            <label>Your Name</label>
            <input 
              type="text" 
              placeholder="Enter name..." 
              value={playerName} 
              onChange={(e) => setPlayerName(e.target.value)}
            />
          </div>
          <div className="action-buttons">
            <button className="btn btn-primary" onClick={handleCreateRoom} disabled={!isConnected}>
              Create Room
            </button>
            <div className="divider">OR</div>
            <div className="join-group">
              <input 
                type="text" 
                placeholder="Room Code" 
                value={roomIdInput} 
                onChange={(e) => setRoomIdInput(e.target.value.toUpperCase())}
              />
              <button className="btn btn-secondary" onClick={handleJoinRoom} disabled={!isConnected}>
                Join Room
              </button>
            </div>
          </div>
        </div>
      )}

      {(gameState === 'lobby' || gameState === 'playing') && currentRoom && (
        <div className="game-layout">
          <main className="main-panel">
            <div className="card room-info-card">
              <div className="room-header">
                <h2>Room Code: <span className="highlight">{currentRoom.id}</span></h2>
                <span className="badge">{gameState.toUpperCase()}</span>
              </div>

              {/* Voice Panel */}
              <div className="voice-panel">
                <h3>Voice Chat</h3>
                {voiceError && <p className="voice-error">{voiceError}</p>}
                {!voiceJoined ? (
                  <button className="btn btn-voice" onClick={joinVoiceChannel}>
                    🎙️ Join Voice Chat
                  </button>
                ) : (
                  <div className="voice-controls">
                    <button 
                      className={`btn ${selfMuted || hostMuted ? 'btn-muted' : 'btn-unmuted'}`} 
                      onClick={toggleSelfMute}
                      disabled={hostMuted}
                    >
                      {hostMuted ? '🔇 Muted by Host' : selfMuted ? '🔇 Unmute Mic' : '🎙️ Mute Mic'}
                    </button>
                    {isHost && (
                      <div className="host-voice-controls">
                        <button className="btn btn-small btn-danger" onClick={handleHostMuteAll}>
                          🔇 Mute All
                        </button>
                        <button className="btn btn-small btn-success" onClick={handleHostUnmuteAll}>
                          🔊 Unmute All
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Session Winner Banner */}
              {sessionWinner && (
                <div className="winner-banner">
                  🏆 SESSION {session - 1} WINNER: {sessionWinner.toUpperCase()}! 🏆
                </div>
              )}

              {/* Game Play Area */}
              {gameState === 'playing' && (
                <div className="game-play-area">
                  <h3>Your Secret Chit</h3>
                  <p className="subtext">Tap the paper chit below to fold / unfold it!</p>

                  <div className="chit-wrapper">
                    <div 
                      className={`chit-card ${isChitRevealed ? 'unfolded' : 'folded'}`}
                      onClick={() => setIsChitRevealed(!isChitRevealed)}
                    >
                      {isChitRevealed ? (
                        <>
                          <span className="chit-stamp">ROYAL DECREE</span>
                          <span className="chit-role-title">{myRole || 'Chit Revealed'}</span>
                          <span className="chit-role-points">+{getRolePoints(myRole)} Points</span>
                        </>
                      ) : (
                        <>
                          <span className="chit-stamp">CHOR SIPAHI</span>
                          <span style={{ fontSize: '2rem', marginTop: '5px' }}>📜</span>
                          <span style={{ fontSize: '0.85rem', color: '#666', marginTop: '5px' }}>Tap to Unfold</span>
                        </>
                      )}
                    </div>
                  </div>

                  <button 
                    className="btn btn-secondary" 
                    onClick={() => setIsChitRevealed(!isChitRevealed)}
                  >
                    {isChitRevealed ? 'Fold & Hide Role' : 'Reveal Role'}
                  </button>
                </div>
              )}

              {/* Points Table / Leaderboard */}
              <div className="leaderboard-section">
                <h3>Points Table (Session {session})</h3>
                <table className="leaderboard-table">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentRoom.players.map((p) => (
                      <tr key={p.id}>
                        <td>{p.name} {p.isHost && '👑'}</td>
                        <td><strong>{scores[p.id] || 0}</strong> pts</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Host Flow Buttons */}
              {isHost && (
                <div className="lobby-actions" style={{ marginTop: '20px' }}>
                  {gameState === 'lobby' && (
                    <button className="btn btn-primary btn-large" onClick={handleStartGame}>
                      Start Game (Session 1)
                    </button>
                  )}
                  {gameState === 'playing' && (
                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                      <button className="btn btn-primary" onClick={handleNextRound}>
                        ▶ Next Round (Round {round + 1})
                      </button>
                      <button className="btn btn-secondary" onClick={handleNextSession}>
                        👑 Next Session (Session {session + 1})
                      </button>
                    </div>
                  )}
                </div>
              )}

            </div>
          </main>

          {/* Chat Panel */}
          <aside className="chat-panel card">
            <h3>Text Chat</h3>
            <div className="chat-messages">
              {messages.map((m, i) => (
                <div key={i} className="chat-message">
                  <span className="msg-time">[{m.timestamp}]</span>
                  <strong>{m.sender}:</strong> {m.text}
                </div>
              ))}
            </div>
            <form onSubmit={handleSendMessage} className="chat-input-form">
              <input 
                type="text" 
                placeholder="Type a message..." 
                value={newMessage} 
                onChange={(e) => setNewMessage(e.target.value)}
              />
              <button type="submit" className="btn btn-primary">Send</button>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}