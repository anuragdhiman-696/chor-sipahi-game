import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import './App.css';

const BACKEND_URL = import.meta.env.PROD 
  ? 'https://chor-sipahi-game.onrender.com' 
  : `http://${window.location.hostname}:5000`;

const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });

const ROLE_CONFIG = {
  Raja: { emoji: '👑', color: '#ecc94b' },
  Wazir: { emoji: '🛡️', color: '#38bdf8' },
  Sipahi: { emoji: '👮', color: '#4ade80' },
  Chor: { emoji: '🥷', color: '#f87171' }
};

function App() {
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [name, setName] = useState('');
  const [joinRoomId, setJoinRoomId] = useState('');
  const [currentRoom, setCurrentRoom] = useState(null);
  const [error, setError] = useState('');

  // Voice Chat States
  const [peerId, setPeerId] = useState('');
  const [isMuted, setIsMuted] = useState(true);
  const [hasMicPermission, setHasMicPermission] = useState(false);
  const peerInstance = useRef(null);
  const localStream = useRef(null);

  // Game & Card Animation States
  const [gameStarted, setGameStarted] = useState(false);
  const [myRole, setMyRole] = useState(null);
  const [cardFlipped, setCardFlipped] = useState(false);

  // Chat
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef(null);

  // Helper to handle and auto-play incoming WebRTC streams cleanly
  const handleRemoteStream = (remoteStream) => {
    let audio = document.getElementById(`audio-${remoteStream.id}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio-${remoteStream.id}`;
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = remoteStream;
    audio.play().catch((err) => console.log('Audio playback waiting for gesture:', err));
  };

  useEffect(() => {
    const peer = new Peer();
    peer.on('open', (id) => setPeerId(id));
    peerInstance.current = peer;

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));
    socket.on('room-updated', ({ room }) => setCurrentRoom(room));

    socket.on('game-started', ({ room }) => {
      setCurrentRoom(room);
      setGameStarted(true);
      setCardFlipped(false);
    });

    socket.on('assign-roles', ({ myRole }) => {
      setMyRole(myRole);
      setCardFlipped(false);
    });

    socket.on('user-connected-voice', ({ peerId: remotePeerId }) => {
      if (localStream.current && remotePeerId) {
        const call = peerInstance.current.call(remotePeerId, localStream.current);
        call?.on('stream', (remoteStream) => handleRemoteStream(remoteStream));
      }
    });

    socket.on('new-message', (msg) => setMessages((prev) => [...prev, msg]));

    return () => socket.off();
  }, []);

  const enableMicrophone = async () => {
    // Unlock WebAudio Context on mobile WebView
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
    }

    const requestAudioStream = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        localStream.current = stream;
        setHasMicPermission(true);
        setIsMuted(false);

        if (peerInstance.current) {
          peerInstance.current.on('call', (call) => {
            call.answer(stream);
            call.on('stream', (remoteStream) => handleRemoteStream(remoteStream));
          });
        }
      } catch (err) {
        alert("Microphone permission denied or blocked by system settings.");
        console.error("Mic Error:", err);
      }
    };

    if (window.cordova) {
      document.addEventListener('deviceready', requestAudioStream, false);
    } else {
      await requestAudioStream();
    }
  };

  const toggleMic = () => {
    if (!hasMicPermission) {
      enableMicrophone();
      return;
    }
    if (localStream.current) {
      const nextMuteState = !isMuted;
      localStream.current.getAudioTracks()[0].enabled = !nextMuteState;
      setIsMuted(nextMuteState);
    }
  };

  const handleCreateRoom = () => {
    socket.emit('create-room', { name, peerId }, (res) => {
      if (res.error) setError(res.error);
      else setCurrentRoom(res.room);
    });
  };

  const handleJoinRoom = () => {
    socket.emit('join-room', { roomId: joinRoomId, name, peerId }, (res) => {
      if (res.error) setError(res.error);
      else {
        setCurrentRoom(res.room);
        socket.emit('join-voice', { roomId: res.room.roomId, peerId });
      }
    });
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (chatInput.trim() && currentRoom) {
      socket.emit('send-message', { roomId: currentRoom.roomId, messageText: chatInput });
      setChatInput('');
    }
  };

  const isSpectator = currentRoom?.spectators.some(s => s.id === socket.id);
  const isHost = currentRoom?.host === socket.id;

  return (
    <div>
      <nav className="navbar">
        <div className="brand">
          <span>👑</span>
          <span className="brand-title">CROWN & THIEF</span>
        </div>
        
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          {currentRoom && (
            <button 
              onClick={toggleMic} 
              className={`btn ${!hasMicPermission ? 'btn-primary' : isMuted ? 'btn-danger' : 'btn-success'}`} 
              style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
            >
              {!hasMicPermission ? '🎙️ Enable Mic' : isMuted ? '🔇 Muted' : '🎙️ Voice Active'}
            </button>
          )}
          <span style={{ color: isConnected ? '#4ade80' : '#f87171', fontSize: '0.85rem', fontWeight: '700' }}>
            {isConnected ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>
      </nav>

      <main className="main-container">
        {!currentRoom && (
          <div className="glass-card" style={{ maxWidth: '450px', margin: '2rem auto' }}>
            <h2>Enter Arena</h2>
            {error && <div style={{ color: '#f87171', marginBottom: '0.5rem' }}>{error}</div>}
            <input type="text" placeholder="Your Name" value={name} onChange={(e) => setName(e.target.value)} className="input-field" style={{ marginBottom: '1rem' }} />
            <button onClick={handleCreateRoom} className="btn btn-primary" style={{ marginBottom: '1rem' }}>✨ Create Room</button>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input type="text" placeholder="Room Code" value={joinRoomId} onChange={(e) => setJoinRoomId(e.target.value)} className="input-field" />
              <button onClick={handleJoinRoom} className="btn btn-secondary">Join</button>
            </div>
          </div>
        )}

        {currentRoom && (
          <div className="grid-workspace">
            <div>
              <div className="glass-card">
                <h3>Room Code: <span style={{ color: '#38bdf8' }}>{currentRoom.roomId}</span></h3>
                {isSpectator && <span className="badge-spectator">👁️ You are Spectating</span>}

                <h4>Players ({currentRoom.players.length}/4)</h4>
                {currentRoom.players.map((p) => (
                  <div key={p.id} className="player-card">
                    <span>{p.name} {p.id === currentRoom.host && '👑'}</span>
                    <span className={p.isReady ? 'badge-ready' : 'badge-waiting'}>{p.isReady ? 'READY' : 'WAITING'}</span>
                  </div>
                ))}

                {currentRoom.spectators.length > 0 && (
                  <div style={{ marginTop: '1rem' }}>
                    <h4>Spectators ({currentRoom.spectators.length})</h4>
                    {currentRoom.spectators.map(s => <span key={s.id} style={{ fontSize: '0.8rem', marginRight: '0.5rem', opacity: 0.8 }}>👁️ {s.name}</span>)}
                  </div>
                )}

                {isHost && !gameStarted && (
                  <button onClick={() => socket.emit('start-game', { roomId: currentRoom.roomId })} className="btn btn-primary" style={{ marginTop: '1rem' }}>
                    🚀 Deal Cards & Start Game
                  </button>
                )}
              </div>

              {/* CARD ARENA WITH TAP FLIP & EXPLICIT BUTTON */}
              {gameStarted && (
                <div className="card-arena-container">
                  <div 
                    className={`uno-card ${cardFlipped ? 'flipped' : ''}`}
                    onClick={() => setCardFlipped(!cardFlipped)}
                  >
                    <div className="card-face card-front">
                      <div style={{ fontSize: '3rem' }}>🂠</div>
                      <div style={{ fontSize: '0.8rem', marginTop: '0.5rem', fontWeight: 'bold' }}>TAP TO REVEAL</div>
                    </div>
                    <div className="card-face card-back">
                      <div style={{ fontSize: '3.5rem' }}>{ROLE_CONFIG[myRole]?.emoji || '❓'}</div>
                      <div style={{ fontWeight: '800', fontSize: '1.2rem', color: ROLE_CONFIG[myRole]?.color || '#ffffff' }}>
                        {myRole || 'Assigning...'}
                      </div>
                    </div>
                  </div>

                  <button 
                    onClick={() => setCardFlipped(!cardFlipped)} 
                    className="btn btn-secondary" 
                    style={{ marginTop: '1.2rem', padding: '0.5rem 1.2rem' }}
                  >
                    {cardFlipped ? '🙈 Hide Role' : '👁️ Reveal Role'}
                  </button>
                </div>
              )}
            </div>

            <div className="glass-card chat-card">
              <div className="chat-header">💬 IN-GAME CHAT</div>
              <div className="chat-messages">
                {messages.map((m) => (
                  <div key={m.id} className="chat-msg">
                    <strong>{m.sender}: </strong>{m.text}
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <form onSubmit={handleSendMessage} className="chat-form">
                <input type="text" placeholder="Type..." value={chatInput} onChange={(e) => setChatInput(e.target.value)} className="input-field" />
                <button type="submit" className="btn btn-primary">Send</button>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;