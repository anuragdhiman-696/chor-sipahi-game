// client/src/App.jsx
import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import './App.css'; // Pure CSS File Import

const BACKEND_URL = import.meta.env.PROD 
  ? 'https://chor-sipahi-game.onrender.com' 
  : `http://${window.location.hostname}:5000`;

// 👇 ADD THIS LINE HERE:
const socket = io("https://chor-sipahi-game.onrender.com", {
  transports: ["websocket", "polling"]
});

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

  // Game state
  const [gameStarted, setGameStarted] = useState(false);
  const [myRole, setMyRole] = useState(null);
  const [rajaInfo, setRajaInfo] = useState(null);
  const [wazirId, setWazirId] = useState(null);
  const [cardFlipped, setCardFlipped] = useState(false);
  const [roundResult, setRoundResult] = useState(null);

  // Chat state
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef(null);

  useEffect(() => {
    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    socket.on('player-joined', ({ room }) => setCurrentRoom(room));
    socket.on('player-left', ({ room }) => setCurrentRoom(room));
    socket.on('room-updated', ({ room }) => setCurrentRoom(room));

    socket.on('game-started', ({ room }) => {
      setCurrentRoom(room);
      setGameStarted(true);
      setRoundResult(null);
    });

    socket.on('assign-roles', ({ myRole }) => {
      setMyRole(myRole);
      setCardFlipped(false);
    });

    socket.on('reveal-raja', ({ rajaId, rajaName, wazirId }) => {
      setRajaInfo({ id: rajaId, name: rajaName });
      setWazirId(wazirId);
    });

    socket.on('round-result', (result) => {
      setRoundResult(result);
      setCurrentRoom(result.room);
    });

    socket.on('trigger-next-round', ({ roomId }) => {
      socket.emit('start-game', { roomId });
    });

    socket.on('new-message', (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    return () => socket.off();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleCreateRoom = () => {
    setError('');
    socket.emit('create-room', { name }, (response) => {
      if (response.error) setError(response.error);
      else {
        setCurrentRoom(response.room);
        setMessages(response.room.messages || []);
      }
    });
  };

  const handleJoinRoom = () => {
    setError('');
    socket.emit('join-room', { roomId: joinRoomId, name }, (response) => {
      if (response.error) setError(response.error);
      else {
        setCurrentRoom(response.room);
        setMessages(response.room.messages || []);
      }
    });
  };

  const handleToggleReady = () => {
    if (currentRoom) socket.emit('toggle-ready', { roomId: currentRoom.roomId });
  };

  const handleStartGame = () => {
    if (currentRoom) socket.emit('start-game', { roomId: currentRoom.roomId });
  };

  const handleGuessChor = (targetPlayerId) => {
    if (currentRoom) {
      socket.emit('guess-chor', { roomId: currentRoom.roomId, guessedPlayerId: targetPlayerId });
    }
  };

  const handleNextRound = () => {
    if (currentRoom) socket.emit('next-round', { roomId: currentRoom.roomId });
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (chatInput.trim() && currentRoom) {
      socket.emit('send-message', { roomId: currentRoom.roomId, messageText: chatInput });
      setChatInput('');
    }
  };

  const myPlayer = currentRoom?.players.find(p => p.id === socket.id);
  const isHost = currentRoom?.host === socket.id;
  const allPlayersReady = currentRoom?.players.length === 4 && currentRoom?.players.every(p => p.isReady);
  const suspects = currentRoom?.players.filter(p => p.id !== rajaInfo?.id && p.id !== wazirId) || [];

  return (
    <div>
      {/* NAVBAR */}
      <nav className="navbar">
        <div className="brand">
          <span style={{ fontSize: '1.75rem' }}>👑</span>
          <span className="brand-title">CROWN & THIEF</span>
        </div>
        <div className="status-badge" style={{ color: isConnected ? '#4ade80' : '#f87171' }}>
          <span className="status-dot" style={{ backgroundColor: isConnected ? '#4ade80' : '#f87171' }}></span>
          {isConnected ? 'ONLINE' : 'OFFLINE'}
        </div>
      </nav>

      {/* MAIN CONTAINER */}
      <main className="main-container">
        {error && <div className="glass-card" style={{ borderColor: '#f87171', color: '#fca5a5', marginBottom: '1rem' }}>⚠️ {error}</div>}

        {/* 1. ENTRY SCREEN */}
        {!currentRoom && (
          <div className="glass-card" style={{ maxWidth: '500px', margin: '2rem auto' }}>
            <h2 className="card-title">Welcome to the Arena</h2>
            <p className="card-subtitle">Play the classic Raja Wazir Chor Sipahi game online!</p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.5rem' }}>
              <input
                type="text"
                placeholder="Enter Your Display Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input-field"
              />

              <button onClick={handleCreateRoom} className="btn btn-primary">
                ✨ Create Private Room
              </button>

              <div className="divider">
                <span>OR JOIN WITH CODE</span>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  placeholder="Room Code"
                  value={joinRoomId}
                  onChange={(e) => setJoinRoomId(e.target.value)}
                  className="input-field"
                  style={{ textTransform: 'uppercase', letterSpacing: '2px', flex: 1 }}
                />
                <button onClick={handleJoinRoom} className="btn btn-secondary" style={{ width: 'auto' }}>
                  Join
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 2. GAME WORKSPACE */}
        {currentRoom && (
          <div className="grid-workspace">
            {/* LEFT COLUMN */}
            <div>
              {/* LOBBY */}
              {!gameStarted && (
                <div className="glass-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: '700' }}>ROOM CODE</span>
                      <div style={{ fontSize: '2rem', fontWeight: '800', color: '#38bdf8', letterSpacing: '2px' }}>{currentRoom.roomId}</div>
                    </div>
                    <span style={{ background: 'rgba(255,255,255,0.08)', padding: '0.4rem 0.8rem', borderRadius: '20px', fontSize: '0.8rem', fontWeight: '700' }}>
                      👥 {currentRoom.players.length}/4 PLAYERS
                    </span>
                  </div>

                  <div className="player-list">
                    {currentRoom.players.map((p) => (
                      <div key={p.id} className="player-card">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                          <span className="avatar">{p.name.charAt(0).toUpperCase()}</span>
                          <span style={{ fontWeight: p.id === socket.id ? '700' : '500' }}>
                            {p.name} {p.id === currentRoom.host && '👑'} {p.id === socket.id && '(You)'}
                          </span>
                        </div>
                        <span className={p.isReady ? 'badge-ready' : 'badge-waiting'}>
                          {p.isReady ? 'READY' : 'WAITING'}
                        </span>
                      </div>
                    ))}
                  </div>

                  {!isHost && (
                    <button onClick={handleToggleReady} className={`btn ${myPlayer?.isReady ? 'btn-danger' : 'btn-success'}`}>
                      {myPlayer?.isReady ? 'Cancel Ready' : 'I Am Ready!'}
                    </button>
                  )}

                  {isHost && (
                    <button disabled={!allPlayersReady} onClick={handleStartGame} className={`btn ${allPlayersReady ? 'btn-primary' : 'btn-disabled'}`}>
                      {allPlayersReady ? '🚀 Start Round 1' : 'Waiting for players...'}
                    </button>
                  )}
                </div>
              )}

              {/* GAMEPLAY */}
              {gameStarted && (
                <div className="glass-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '1.25rem', fontWeight: '800' }}>ROUND {currentRoom?.currentRound || 1}</span>
                    {rajaInfo && (
                      <span style={{ background: '#d97706', color: '#fff', padding: '0.3rem 0.8rem', borderRadius: '12px', fontSize: '0.8rem', fontWeight: '800' }}>
                        👑 RAJA: {rajaInfo.name}
                      </span>
                    )}
                  </div>

                  {/* FLIP CARD */}
                  <div className="chit-card-wrapper" onClick={() => setCardFlipped(!cardFlipped)}>
                    <div className={`chit-card ${cardFlipped ? 'flipped' : ''}`}>
                      {!cardFlipped ? (
                        <div className="chit-face">
                          <div style={{ fontSize: '2.5rem' }}>📜</div>
                          <div style={{ fontWeight: '700', marginTop: '0.5rem' }}>TAP TO REVEAL ROLE CHIT</div>
                        </div>
                      ) : (
                        <div className="chit-face chit-back">
                          <div style={{ fontSize: '3rem' }}>{ROLE_CONFIG[myRole]?.emoji}</div>
                          <div style={{ fontSize: '1.5rem', fontWeight: '800', color: ROLE_CONFIG[myRole]?.color, marginTop: '0.25rem' }}>
                            {myRole}
                          </div>
                          <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '0.25rem' }}>Tap to hide</div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* WAZIR GUESS ACTION */}
                  {!roundResult && (
                    <div style={{ marginTop: '1rem' }}>
                      {myRole === 'Wazir' ? (
                        <div>
                          <div style={{ textAlign: 'center', color: '#fbbf24', fontWeight: '700', marginBottom: '0.75rem' }}>
                            🔍 You are Wazir! Who is the Chor?
                          </div>
                          <div style={{ display: 'flex', gap: '0.75rem' }}>
                            {suspects.map((suspect) => (
                              <button key={suspect.id} onClick={() => handleGuessChor(suspect.id)} className="btn btn-danger">
                                🥷 {suspect.name}?
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div style={{ textAlign: 'center', color: '#94a3b8', fontStyle: 'italic' }}>
                          ⏳ Wazir is investigating...
                        </div>
                      )}
                    </div>
                  )}

                  {/* ROUND RESULTS */}
                  {roundResult && (
                    <div className="scoreboard-box">
                      <h3 style={{ textAlign: 'center', marginBottom: '1rem', color: roundResult.isCorrect ? '#4ade80' : '#f87171' }}>
                        {roundResult.isCorrect ? '🎉 Wazir Caught the Chor!' : '😈 Chor Escaped!'}
                      </h3>

                      <div>
                        {roundResult.allPlayers.map((p) => (
                          <div key={p.id} className="score-item">
                            <span>{ROLE_CONFIG[p.role]?.emoji} <strong>{p.name}</strong> ({p.role})</span>
                            <span style={{ fontWeight: '800', color: '#4ade80' }}>+{p.score} pts</span>
                          </div>
                        ))}
                      </div>

                      {isHost && (
                        <button onClick={handleNextRound} className="btn btn-primary" style={{ marginTop: '1rem' }}>
                          🔄 Play Next Round
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* RIGHT COLUMN: CHAT */}
            <div className="glass-card chat-card">
              <div className="chat-header">💬 IN-GAME CHAT</div>

              <div className="chat-messages">
                {messages.map((m) => (
                  <div key={m.id} className={m.isSystem ? 'chat-msg-system' : 'chat-msg'}>
                    {m.isSystem ? (
                      <span>📢 {m.text}</span>
                    ) : (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
                          <strong style={{ color: m.senderId === socket.id ? '#38bdf8' : '#818cf8', fontSize: '0.8rem' }}>{m.sender}</strong>
                          <span style={{ fontSize: '0.65rem', color: '#64748b' }}>{m.time}</span>
                        </div>
                        <div>{m.text}</div>
                      </>
                    )}
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>

              <form onSubmit={handleSendMessage} className="chat-form">
                <input
                  type="text"
                  placeholder="Say something..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  className="input-field"
                  style={{ fontSize: '0.85rem' }}
                />
                <button type="submit" className="btn btn-primary" style={{ width: 'auto', padding: '0.5rem 1rem' }}>
                  Send
                </button>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
