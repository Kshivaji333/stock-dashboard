import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const [timeLeft, setTimeLeft] = useState("Calculating...");

  const fetchData = async () => {
    try {
      const response = await axios.get('/api/data');
      setData(response.data);
      setIsPaused(response.data.isPaused);
      setLoading(false);
    } catch (error) {
      console.error("Error fetching data:", error);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  // Timer Logic
  useEffect(() => {
    const timerInterval = setInterval(() => {
      if (isPaused) {
        setTimeLeft("Paused");
        return;
      }
      const now = new Date();
      const minutes = now.getMinutes();
      const seconds = now.getSeconds();
      const minutesPastTen = minutes % 10;
      const minutesRemaining = 9 - minutesPastTen;
      const secondsRemaining = 59 - seconds;
      const formattedTime = `${minutesRemaining}:${secondsRemaining < 10 ? '0' : ''}${secondsRemaining}`;
      setTimeLeft(formattedTime);
    }, 1000);
    return () => clearInterval(timerInterval);
  }, [isPaused]);

  const handleControl = async (endpoint, label) => {
    setActionStatus(`Executing: ${label}...`);
    try {
      await axios.get(`/api/control/${endpoint}`);
      setActionStatus(`Success: ${label}`);
      fetchData();
      setTimeout(() => setActionStatus(""), 3000);
    } catch (error) {
      setActionStatus(`Error: ${label}`);
    }
  };

  // --- FIXED CLICK HANDLER ---
  const handleCardClick = (growwLink, symbol) => {
    if (growwLink) {
        // If it's a search link or a direct link, prepend domain
        window.open(`https://groww.in${growwLink}`, '_blank');
    } else {
        // Absolute fallback if backend fails completely
        window.open(`https://groww.in/search?q=${symbol}`, '_blank');
    }
  };

  if (loading) return <div className="loading">Connecting to Server...</div>;
  
  if (!data || !data.targetStocks || data.targetStocks.length === 0) {
      return (
        <div className="dashboard">
             <header className="header">
                <h1>🚀 Stock Tracker</h1>
             </header>
             <div className="empty-state">
                <h2>Ready to Start</h2>
                <p>System is paused. Click below to initialize today's tracking.</p>
                <button className="btn btn-resume" onClick={() => handleControl('resume', "Starting System")}>
                    ▶ START TRACKING
                </button>
             </div>
        </div>
      )
  }

  return (
    <div className="dashboard">
      <header className="header">
        <h1>🚀 10m Volume & Groww Tracker</h1>
        
        <div className="control-panel">
            <button 
                className={`btn ${isPaused ? 'btn-resume' : 'btn-pause'}`} 
                onClick={() => handleControl(isPaused ? 'resume' : 'pause', isPaused ? "Resuming" : "Pausing")}
            >
                {isPaused ? "▶ RESUME TRACKING" : "⏸ PAUSE TRACKING"}
            </button>
            <button className="btn btn-fetch" onClick={() => handleControl('force-fetch', "Force Fetch")}>
                ⚡ Fetch Now
            </button>
            <button className="btn btn-restart" onClick={() => {
                if(window.confirm("Are you sure? This will wipe today's history.")) 
                    handleControl('restart-day', "Restarting Day");
            }}>
                🔄 Restart Day
            </button>
        </div>
        
        <div className="system-status">
            {actionStatus && <span className="action-msg">{actionStatus}</span>}
            <div className="status-row">
                <span className="meta-info">Status: {isPaused ? <span className="red">PAUSED</span> : <span className="green">RUNNING</span>}</span>
                <span className="meta-info timer-box">
                    Fetching in: <span className="timer-val">{timeLeft}</span>
                </span>
            </div>
        </div>
      </header>

      <div className="cards-container">
        {data.targetStocks.map((symbol) => {
          const growwInfo = data.growwData ? data.growwData[symbol] : null;
          const growwLink = growwInfo?.growwLink; 
          
          const latestUpdate = data.history.length > 0 
            ? data.history[data.history.length - 1].updates.find(u => u.symbol === symbol)
            : null;

          const isDisappeared = latestUpdate?.status === "Disappeared";

          return (
            <div 
                className={`stock-card ${isDisappeared ? 'card-disappeared' : ''} clickable-card`} 
                key={symbol}
                onClick={() => handleCardClick(growwLink, symbol)}
                title="Click to open in Groww"
            >
              <div className="card-header">
                <h2>{symbol}</h2>
                <span className={`status-badge ${isDisappeared ? 'status-red' : 'status-green'}`}>
                  {isDisappeared ? "⚠️ GONE" : "● ACTIVE"}
                </span>
              </div>
              
              <div className="stat-row">
                <span className="label">Volume:</span>
                <span className="value">{latestUpdate ? latestUpdate.volume.toLocaleString() : "Loading..."}</span>
              </div>
              
              <div className="stat-row">
                <span className="label">Change:</span>
                <span className={`value ${latestUpdate && latestUpdate.change.includes('+') ? 'green' : 'red'}`}>
                  {latestUpdate ? latestUpdate.change : "0"}
                </span>
              </div>

              <div className="groww-section">
                <div className={`badge ${growwInfo?.inMostBought ? 'badge-green' : 'badge-gray'}`}>
                  {growwInfo?.inMostBought ? "🔥 Groww Top Bought" : "Not in Top List"}
                </div>
                
                {growwInfo?.shareholding && typeof growwInfo.shareholding === 'object' ? (
                  <div className="shareholding">
                    <strong>Shareholding:</strong>
                    <ul>
                      {Object.entries(growwInfo.shareholding).map(([key, val]) => (
                        <li key={key}><span>{key}:</span> <span>{val}</span></li>
                      ))}
                    </ul>
                  </div>
                ) : (
                    <div className="shareholding-error">
                        {typeof growwInfo?.shareholding === 'string' ? growwInfo.shareholding : "No Data"}
                    </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="history-section">
        <h3>📊 History Log</h3>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                {data.targetStocks.map(s => <th key={s}>{s}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.history.slice().reverse().map((snap, index) => (
                <tr key={index}>
                  <td className="time-col">{snap.time}</td>
                  {data.targetStocks.map(symbol => {
                    const stockData = snap.updates.find(u => u.symbol === symbol);
                    const isGone = stockData?.status === "Disappeared";
                    return (
                      <td key={symbol} className={isGone ? "cell-disappeared" : ""}>
                         {isGone ? <span className="red">Gone</span> : (
                             <div>
                                 <div className="cell-vol">{stockData?.volume.toLocaleString()}</div>
                                 <div className={`cell-change ${stockData?.change.includes('+') ? 'green' : 'red'}`}>{stockData?.change}</div>
                             </div>
                         )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default App;