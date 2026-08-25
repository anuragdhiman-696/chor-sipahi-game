import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import './App.css';

const BACKEND_URL = import.meta.env.PROD 
  ? 'https://chor-sipahi-game.onrender.com' 
  : `http://${window.location.hostname}:5000`;

const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });

const ROLE_CONFIG = {
  Raja: { emoji: '👑', points: 1000, color: '#ecc94b' },
  Wazir: { emoji: '🛡️', points: 800, color: '#38bdf8' },
  Sipahi: { emoji: '👮', points: 500, color: '#4ade80' },
  Chor: { emoji: '🥷', points: 0, color: '#f87171' }
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

  // Game States
  const [gameStarted, setGameStarted] = useState(false);
  const [myRole, setMyRole] = useState(null);
  const [cardFlipped, setCardFlipped] = useState(false);
  const [gameResult, setGameResult] = useState(null);

  // Chat
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef(null);

  const handleRemoteStream = (stream, id) => {
    let audio = document.getElementById(`audio-${id}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio-${id}`;
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    audio.play().catch(console.error);
  };

  useEffect(() => {
    const peer = new Peer();
    peer.on('open', (id) => setPeerId(id));
    
    peer.on('call', (call) => {
      if (localStream.current) {
        call.answer(localStream.current);
        call.on('stream', (stream) => handleRemoteStream(stream, call.peer));
      }
    });

    peerInstance.current = peer;

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));
    
    socket.on('room-updated', ({ room }) => {
      setCurrentRoom(room);
      if (room.messages) setMessages(room.messages);
    });

    socket.on('game-started', ({ room }) => {
      setCurrentRoom(room);
      setGameStarted(true);
      setCardFlipped(false);
      setGameResult(null);
    });

    socket.on('assign-roles', ({ myRole }) => {
      setMyRole(myRole);
      setCardFlipped(false);
    });

    socket.on('user-connected-voice', ({ peerId: remotePeerId }) => {
      if (localStream.current && remotePeerId && remotePeerId !== peerId) {
        const call = peerInstance.current.call(remotePeerId, localStream.current);
        call?.on('stream', (stream) => handleRemoteStream(stream, remotePeerId));
      }
    });

    socket.on('game-over', (result) => setGameResult(result));
    socket.on('new-message', (msg) => setMessages((prev) => [...prev, msg]));

    return () => socket.off();
  }, [peerId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const enableMicrophone = async () => {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStream.current = stream;
      setHasMicPermission(true);
      setIsMuted(false);

      if (currentRoom && peerId) {
        socket.emit('join-voice', { roomId: currentRoom.roomId, peerId });
      }
    } catch (err) {
      alert("Microphone permission blocked. Please check site permissions.");
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
    setError('');
    if (!name.trim()) return setError('Please enter your name');
    socket.emit('create-room', { name, peerId }, (res) => {
      if (res.error) setError(res.error);
      else setCurrentRoom(res.room);
    });
  };

  const handleJoinRoom = () => {
    setError('');
    if (!name.trim() || !joinRoomId.trim()) return setError('Enter name & room code');
    socket.emit('join-room', { roomId: joinRoomId.trim().toUpperCase(), name, peerId }, (res) => {
      if (res.error) setError(res.error);
      else setCurrentRoom(res.room);
    });
  };

  const handleCatchChor = (suspectId) => {
    socket.emit('make-guess', { roomId: currentRoom.roomId, suspectId });
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (chatInput.trim() && currentRoom) {
      socket.emit('send-message', { roomId: currentRoom.roomId, messageText: chatInput });
      setChatInput('');
    }
  };

  const isHost = currentRoom?.host === socket.id;
  const otherPlayers = currentRoom?.players.filter((p) => p.id !== socket.id) || [];

  return (
    <div>
      <nav className="navbar">
        <div className="brand">
          <span>👑</span>
          <span className="brand-title">CHOR SIPAHI</span>
        </div>
        
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          {currentRoom && (
            <button 
              onClick={toggleMic} 
              className={`btn ${!hasMicPermission ? 'btn-primary' : isMuted ? 'btn-danger' : 'btn-success'}`} 
              style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem', width: 'auto' }}
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
            {error && <div style={{ color: '#f87171', margin: '0.5rem 0' }}>{error}</div>}
            <input 
              type="text" 
              placeholder="Your Name" 
              value={name} 
              onChange={(e) => setName(e.target.value)} 
              className="input-field" 
              style={{ marginBottom: '1rem' }} 
            />
            <button onClick={handleCreateRoom} className="btn btn-primary" style={{ marginBottom: '1rem' }}>
              ✨ Create Room
            </button>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input 
                type="text" 
                placeholder="Room Code" 
                value={joinRoomId} 
                onChange={(e) => setJoinRoomId(e.target.value.toUpperCase())} 
                className="input-field" 
              />
              <button onClick={handleJoinRoom} className="btn btn-secondary" style={{ width: 'auto' }}>
                Join
              </button>
            </div>
          </div>
        )}

        {currentRoom && (
          <div className="grid-workspace">
            <div>
              <div className="glass-card" style={{ marginBottom: '1rem' }}>
                <h3>Room Code: <span style={{ color: '#38bdf8' }}>{currentRoom.roomId}</span></h3>
                
                <h4 style={{ marginTop: '1rem' }}>🏆 Scoreboard</h4>
                <div style={{ marginTop: '0.5rem' }}>
                  {currentRoom.players.map((p) => (
                    <div key={p.id} className="player-card">
                      <span>{p.name} {p.id === currentRoom.host && '👑'}</span>
                      <span style={{ fontWeight: 'bold', color: '#ecc94b' }}>{p.score || 0} pts</span>
                    </div>
                  ))}
                </div>

                {isHost && !gameStarted && (
                  <button onClick={() => socket.emit('start-game', { roomId: currentRoom.roomId })} className="btn btn-primary" style={{ marginTop: '1rem' }}>
                    🚀 Deal Cards & Start Game
                  </button>
                )}
              </div>

              {gameStarted && (
                <div className="card-arena-container">
                  <div className={`uno-card ${cardFlipped ? 'flipped' : ''}`} onClick={() => setCardFlipped(!cardFlipped)}>
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

                  <button onClick={() => setCardFlipped(!cardFlipped)} className="btn btn-secondary" style={{ marginTop: '1rem', width: 'auto' }}>
                    {cardFlipped ? '🙈 Hide Role' : '👁️ Reveal Role'}
                  </button>

                  {myRole === 'Wazir' && !gameResult && (
                    <div className="glass-card" style={{ marginTop: '1.5rem', width: '100%' }}>
                      <h4 style={{ color: '#38bdf8', marginBottom: '0.5rem' }}>🛡️ Wazir: Catch the Thief (Chor)</h4>
                      <div style={{ display: 'grid', gap: '0.5rem' }}>
                        {otherPlayers.map((player) => (
                          <button key={player.id} onClick={() => handleCatchChor(player.id)} className="btn btn-danger">
                            Catch {player.name} 🥷
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {gameResult && (
                    <div className="glass-card" style={{ marginTop: '1.5rem', width: '100%', textAlign: 'center' }}>
                      <h3 style={{ color: gameResult.success ? '#4ade80' : '#f87171' }}>
                        {gameResult.success ? '🎉 Wazir Caught the Thief!' : '❌ Thief Escaped!'}
                      </h3>
                      <p style={{ margin: '0.5rem 0' }}>{gameResult.message}</p>
                    </div>
                  )}
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
                <input 
                  type="text" 
                  placeholder="Type..." 
                  value={chatInput} 
                  onChange={(e) => setChatInput(e.target.value)} 
                  className="input-field" 
                />
                <button type="submit" className="btn btn-primary" style={{ width: 'auto' }}>Send</button>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;