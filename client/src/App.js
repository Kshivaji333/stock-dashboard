import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import './App.css';

function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const [timeLeft, setTimeLeft] = useState("Calculating...");
  
  // Controls button lock
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Refs for cleanup
  const fetchTimeoutRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const timerIntervalRef = useRef(null);

  const fetchData = useCallback(async () => {
    try {
      const response = await axios.get('/api/data');
      const scanning = Boolean(response.data.isScanning);

      setData(response.data);
      setIsPaused(Boolean(response.data.isPaused));
      setIsProcessing(scanning);
      setConnectionError(false);
      setActionStatus((prev) => {
        if (scanning) return "System is working...";
        return prev === "System is working..." ? "" : prev;
      });
      setLoading(false);
    } catch (error) {
      console.error("Error fetching data:", error);
      // FAIL-SAFE: If server is down/crashed, unlock buttons so user isn't stuck
      setIsProcessing(false);
      setConnectionError(true);
      setLoading(false);
      setActionStatus("Connection lost. Retrying...");
    }
  }, []);

  // Poll every 3 seconds for faster UI updates
  useEffect(() => {
    fetchData();
    pollIntervalRef.current = setInterval(fetchData, 3000);
    
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [fetchData]); 

  // Timer Logic
  useEffect(() => {
    timerIntervalRef.current = setInterval(() => {
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
      setTimeLeft(`${minutesRemaining}:${secondsRemaining < 10 ? '0' : ''}${secondsRemaining}`);
    }, 1000);
    
    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, [isPaused]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current);
      }
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, []);

  const handleControl = async (endpoint, label) => {
    if (isProcessing) return; // Prevent double click
    
    setIsProcessing(true); // Lock immediately
    setActionStatus(`Executing: ${label}...`);
    
    try {
      await axios.get(`/api/control/${endpoint}`);
      setActionStatus(`Triggered: ${label}`);
      
      // Clear any existing timeout before setting new one
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current);
      }
      
      fetchTimeoutRef.current = setTimeout(() => {
        fetchData();
        fetchTimeoutRef.current = null;
      }, 500);
    } catch (error) {
      console.error(`Error executing ${label}:`, error);
      setActionStatus(`Error: ${label}`);
      setIsProcessing(false); // Unlock on error
    }
  };

  const handleCardClick = (growwLink, symbol) => {
    const url = growwLink ? `https://groww.in${growwLink}` : `https://groww.in/search?q=${symbol}`;
    const newWindow = window.open(url, '_blank', 'noopener,noreferrer');
    if (newWindow) newWindow.opener = null;
  };

  if (loading) {
    return <div className="loading">Connecting to Server...</div>;
  }
  
  if (connectionError && !data) {
    return (
      <div className="loading">
        <div>Connection lost. Retrying...</div>
        <div style={{ fontSize: '0.9rem', marginTop: '10px', color: '#8b949e' }}>
          Please check if the server is running
        </div>
      </div>
    );
  }
  
  if (!data || !data.targetStocks || data.targetStocks.length === 0) {
    return (
      <div className="dashboard">
        <header className="header"><h1>Stock Tracker</h1></header>
        <div className="empty-state">
          <h2>Ready to Start</h2>
          <p>
            {data?.isStale 
              ? "New trading day detected. Initialize tracking to refresh data." 
              : "System is paused. Initialize tracking below."}
          </p>
          <button 
            className="btn btn-resume" 
            disabled={isProcessing}
            onClick={() => handleControl('resume', "Starting System")}
          >
            {isProcessing ? "STARTING..." : "START TRACKING"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <header className="header">
        <h1>10m Volume & Groww Tracker</h1>
        
        <div className="control-panel">
          <button 
            className={`btn ${isPaused ? 'btn-resume' : 'btn-pause'}`} 
            disabled={isProcessing}
            onClick={() => handleControl(isPaused ? 'resume' : 'pause', isPaused ? "Resuming" : "Pausing")}
          >
            {isProcessing ? "PLEASE WAIT..." : (isPaused ? "RESUME TRACKING" : "PAUSE TRACKING")}
          </button>
          
          <button 
            className="btn btn-fetch" 
            disabled={isProcessing}
            onClick={() => handleControl('force-fetch', "Force Fetch")}
          >
            {isProcessing ? "FETCHING..." : "FETCH NOW"}
          </button>

          <button 
            className="btn btn-restart" 
            disabled={isProcessing}
            onClick={() => {
              if (window.confirm("Are you sure? This will wipe history and restart the day.")) {
                handleControl('restart-day', "Restarting Day");
              }
            }}
          >
            RESTART DAY
          </button>
        </div>
        
        <div className="system-status">
          {actionStatus && <span className="action-msg">{actionStatus}</span>}
          <div className="status-row">
            <span className="meta-info">
              Status: {isPaused ? <span className="red">PAUSED</span> : <span className="green">RUNNING</span>}
            </span>
            <span className="meta-info timer-box">
              Fetch in: <span className="timer-val">{timeLeft}</span>
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
                  {isDisappeared ? "GONE" : "ACTIVE"}
                </span>
              </div>
              
              <div className="stat-row">
                <span className="label">Volume:</span>
                <span className="value">
                  {latestUpdate 
                    ? (typeof latestUpdate.volume === 'number' 
                        ? latestUpdate.volume.toLocaleString() 
                        : latestUpdate.volume)
                    : "Loading..."}
                </span>
              </div>
              
              <div className="stat-row">
                <span className="label">Change:</span>
                <span className={`value ${latestUpdate && latestUpdate.change.includes('+') ? 'green' : 'red'}`}>
                  {latestUpdate ? latestUpdate.change : "0"}
                </span>
              </div>
              
              <div className="groww-section">
                <div className={`badge ${growwInfo?.inMostBought ? 'badge-green' : 'badge-gray'}`}>
                  {growwInfo?.inMostBought ? "Groww Top Bought" : "Not in Top List"}
                </div>
                
                {growwInfo?.shareholding && typeof growwInfo.shareholding === 'object' ? (
                  <div className="shareholding">
                    <strong>Shareholding:</strong>
                    <ul>
                      {Object.entries(growwInfo.shareholding).map(([key, val]) => (
                        <li key={key}>
                          <span>{key}:</span> <span>{val}</span>
                        </li>
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
        <h3>History Log</h3>
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
                        {isGone ? (
                          <span className="red">Gone</span>
                        ) : (
                          <div>
                            <div className="cell-vol">
                              {stockData?.volume 
                                ? (typeof stockData.volume === 'number' 
                                    ? stockData.volume.toLocaleString() 
                                    : stockData.volume)
                                : "N/A"}
                            </div>
                            <div className={`cell-change ${stockData?.change.includes('+') ? 'green' : 'red'}`}>
                              {stockData?.change || "0"}
                            </div>
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