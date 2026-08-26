import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Peer from 'peerjs';
import './App.css';

// Always use production backend URL when running inside mobile APK (where hostname is empty or localhost)
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
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

  const [voiceJoined, setVoiceJoined] = useState(false);
  const [selfMuted, setSelfMuted] = useState(false);
  const [hostMuted, setHostMuted] = useState(false);
  const [voiceStates, setVoiceStates] = useState({});
  const [speakingPlayers, setSpeakingPlayers] = useState({});
  const [voiceError, setVoiceError] = useState('');

  const peerRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerCallsRef = useRef({});
  const audioElementsRef = useRef({});
  const audioAnalyserRef = useRef(null);

  // Wake up Render instance on mount
  useEffect(() => {
    fetch('https://chor-sipahi-game.onrender.com')
      .then(() => console.log('Server awakened successfully!'))
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
      setErrorMessage(`Connection error: ${err.message}. Server warming up...`);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);

    socket.on('room-created', ({ room }) => {
      setCurrentRoom(room);
      setGameState('lobby');
      setErrorMessage('');
    });

    socket.on('room-joined', ({ room }) => {
      setCurrentRoom(room);
      setGameState(room.gameState === 'playing' ? 'playing' : 'lobby');
      setErrorMessage('');
    });

    socket.on('player-joined', ({ room }) => setCurrentRoom(room));
    socket.on('player-left', ({ socketId, room }) => {
      setCurrentRoom(room);
      removeRemoteAudio(socketId);
    });
    socket.on('host-changed', ({ room }) => setCurrentRoom(room));
    socket.on('receive-message', (msgData) => setMessages((prev) => [...prev, msgData]));
    socket.on('game-started', ({ room }) => {
      setCurrentRoom(room);
      setGameState('playing');
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
      socket.off('host-changed');
      socket.off('receive-message');
      socket.off('game-started');
      socket.off('error-message');
      socket.off('voice-state-updated');
      socket.off('force-host-mute');
      socket.off('user-disconnected-voice');
    };
  }, [selfMuted]);

  useEffect(() => {
    return () => cleanupVoice();
  }, []);

  const joinVoiceChannel = async () => {
    if (voiceJoined) return;
    setVoiceError('');

    // Utility helper to request Android permissions via Cordova
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
          // Fallback for desktop browsers
          resolve(true);
        }
      });
    };

    // Ensure deviceready has fired if running inside Cordova
    if (window.cordova) {
      await new Promise((resolve) => {
        if (window.deviceReadyFired) {
          resolve();
        } else {
          document.addEventListener('deviceready', resolve, { once: true });
          // Safety timeout in case event already passed
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
    if (!socket.connected) {
      socket.connect();
      return setErrorMessage('Connecting... Please try again shortly.');
    }
    socket.emit('create-room', { playerName });
  };

  const handleJoinRoom = () => {
    if (!playerName.trim()) return setErrorMessage('Please enter your name.');
    if (!roomIdInput.trim()) return setErrorMessage('Please enter a Room Code.');
    if (!socket.connected) {
      socket.connect();
      return setErrorMessage('Connecting... Please try again shortly.');
    }
    socket.emit('join-room', { roomId: roomIdInput, playerName });
  };

  const handleStartGame = () => {
    if (currentRoom && socket.id === currentRoom.host) {
      socket.emit('start-game', { roomId: currentRoom.id });
    }
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (newMessage.trim() && currentRoom) {
      socket.emit('send-message', { roomId: currentRoom.id, message: newMessage });
      setNewMessage('');
    }
  };

  const isHost = currentRoom && currentRoom.host === socket.id;

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>CHOR SIPAHI</h1>
        <p className="subtitle">4-Player Realtime Voice Game</p>
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

              <div className="players-section">
                <h3>Players ({currentRoom.players.length})</h3>
                <div className="player-grid">
                  {currentRoom.players.map((p) => {
                    const pVoice = voiceStates[p.id] || {};
                    const isSpeaking = speakingPlayers[p.id];
                    return (
                      <div key={p.id} className={`player-card ${isSpeaking ? 'speaking' : ''}`}>
                        <div className="player-info">
                          <span className="player-name">
                            {p.name} {p.isHost && '👑'}
                          </span>
                          <span className="voice-indicator">
                            {!pVoice.voiceJoined ? '🔇 Off' : 
                              pVoice.hostMuted ? '🔇 Host Muted' : 
                              pVoice.selfMuted ? '🔇 Muted' : '🎙️ Active'}
                          </span>
                        </div>
                        {isHost && p.id !== socket.id && pVoice.voiceJoined && (
                          <div className="host-actions">
                            {pVoice.hostMuted ? (
                              <button className="btn-xs btn-success" onClick={() => handleHostUnmute(p.id)}>
                                Unmute
                              </button>
                            ) : (
                              <button className="btn-xs btn-danger" onClick={() => handleHostMute(p.id)}>
                                Mute
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {gameState === 'lobby' && isHost && (
                <div className="lobby-actions">
                  <button className="btn btn-primary btn-large" onClick={handleStartGame}>
                    Start Game
                  </button>
                </div>
              )}

              {gameState === 'playing' && (
                <div className="game-board card">
                  <h3>Game in Progress</h3>
                  <p>In-game state loaded successfully.</p>
                </div>
              )}
            </div>
          </main>

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