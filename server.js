const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fs = require('fs');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const DATA_FILE = path.join(__dirname, 'daily_data.json');
const NSE_URL = 'https://www.nseindia.com/market-data/top-gainers-losers';
const GROWW_URL = 'https://groww.in/stocks/most-bought-stocks-on-groww';

// --- SYSTEM STATE ---
let isTrackingPaused = true;
let isScanning = false; 

// --- TIMEZONE HELPERS (Forces IST) ---
const IST_HOUR_FORMATTER = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
function getISTTime() {
    return new Date().toLocaleTimeString('en-IN', { 
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true 
    });
}
function getISTDate() {
    return new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
}
function getISTHour() {
    return Number(IST_HOUR_FORMATTER.format(new Date()));
}

// --- DATA MANAGEMENT ---
function emptyData() {
    return { date: getISTDate(), targetStocks: [], growwData: {}, history: [] };
}
function isDataStale(data) {
    return !data || !data.date || data.date !== getISTDate();
}
function getStoredData() {
    if (!fs.existsSync(DATA_FILE)) return emptyData();
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(rawData);
        return parsed && typeof parsed === 'object' ? parsed : emptyData();
    } catch (e) {
        console.error("Data read error:", e.message);
        return emptyData();
    }
}
function saveData(data) {
    try {
        const tmpFile = `${DATA_FILE}.tmp`;
        fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
        fs.renameSync(tmpFile, DATA_FILE);
    } catch (e) {
        console.error("Data write error:", e.message);
    }
}
function normalize(str) {
    if (!str) return "";
    return str.toUpperCase().replace(/LTD|LIMITED/g, '').replace(/[^A-Z0-9]/g, '');
}

// --- STABLE BROWSER LAUNCHER ---
async function getBrowser() {
    const isWindows = process.platform === 'win32';
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    
    // CONFIGURATION 1: WINDOWS (Local Development) - Minimal args for maximum stability
    if (isWindows) {
        return await puppeteer.launch({ 
            headless: "new",
            ...(executablePath ? { executablePath } : {}),
            args: ['--no-sandbox', '--window-size=1920,1080']
        });
    }

    // CONFIGURATION 2: LINUX (Render Deployment) - Aggressive memory saving
    return await puppeteer.launch({ 
        headless: "new", 
        timeout: 60000, 
        dumpio: false, 
        ...(executablePath ? { executablePath } : {}),
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', 
            '--disable-gpu',
            '--window-size=1920,1080'
        ] 
    });
}

// --- SCRAPING FUNCTIONS ---
async function scrapeNSE() {
    console.log("Launching browser for NSE...");
    let browser = null;
    try {
        browser = await getBrowser();
        const page = await browser.newPage();
        
        // Basic Stealth
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.nseindia.com/'
        });
        
        // Resource Blocking (Speed + Memory)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // Increased timeout for slow networks
        await page.goto('https://www.nseindia.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.goto(NSE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('#topgainer-Table', { timeout: 30000 });

        const stocks = await page.evaluate(() => {
            const results = [];
            const table = document.getElementById('topgainer-Table');
            if (table) {
                const rows = table.querySelectorAll('tbody tr');
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length > 7) {
                        results.push({
                            symbol: cells[0].innerText.trim(),
                            volume: parseInt(cells[7].innerText.trim().replace(/,/g, ''))
                        });
                    }
                });
            }
            return results;
        });
        await browser.close();
        return stocks;
    } catch (error) {
        console.error("NSE Error:", error.message);
        if(browser) await browser.close();
        return [];
    }
}

async function scrapeGroww(targetSymbols) {
    console.log("Launching browser for Groww...");
    let browser = null;
    const growwData = {};
    try {
        browser = await getBrowser();
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(GROWW_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        const mostBoughtList = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href^="/stocks/"]'));
            const items = anchors
                .map(link => ({ name: link.innerText.trim(), link: link.getAttribute('href') }))
                .filter(item => item.name && item.link);
            const seen = new Set();
            return items.filter(item => {
                const key = `${item.name}|${item.link}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        });

        for (const symbol of targetSymbols) {
            const normalizedTarget = normalize(symbol);
            const match = mostBoughtList.find(g => {
                const gName = normalize(g.name);
                return gName.includes(normalizedTarget) || normalizedTarget.includes(gName);
            });

            if (match) {
                try {
                    await page.goto(`https://groww.in${match.link}`, { waitUntil: 'domcontentloaded' });
                    try { await page.waitForSelector('.shp76Row', { timeout: 5000 }); } catch (e) {}
                    
                    const shareholding = await page.evaluate(() => {
                        const pattern = {};
                        document.querySelectorAll('.shp76Row').forEach(row => {
                            const cat = row.querySelector('.bodyLarge')?.innerText;
                            const val = row.querySelector('.shp76TextRight')?.innerText;
                            if (cat && val) pattern[cat] = val;
                        });
                        return pattern;
                    });
                    
                    growwData[symbol] = { 
                        inMostBought: true, 
                        growwName: match.name, 
                        growwLink: match.link, 
                        shareholding: Object.keys(shareholding).length > 0 ? shareholding : "Not Found" 
                    };
                } catch (e) {
                    growwData[symbol] = { inMostBought: true, growwName: match.name, growwLink: match.link, shareholding: "Error" };
                }
            } else {
                growwData[symbol] = { 
                    inMostBought: false, 
                    growwLink: `/search?q=${symbol}`, 
                    shareholding: null 
                };
            }
        }
        await browser.close();
        return growwData;
    } catch (error) {
        console.error("Groww Error:", error);
        if(browser) await browser.close();
        return {};
    }
}

// --- WORKFLOW LOGIC ---
async function startDay() {
    if (isScanning) return; 
    isScanning = true;
    
    try {
        console.log("--- INITIALIZING DAY ---");
        const allStocks = await scrapeNSE();
        allStocks.sort((a, b) => b.volume - a.volume);
        const top5 = allStocks.slice(0, 5).map(s => s.symbol);

        if (top5.length === 0) { 
            console.log("ERROR: No data from NSE."); 
            return; 
        }

        const growwDetails = await scrapeGroww(top5);
        const initialSnapshot = {
            time: getISTTime(), 
            updates: top5.map(symbol => {
                const stock = allStocks.find(s => s.symbol === symbol);
                return { symbol, volume: stock ? stock.volume : 0, status: "Active", change: "Base Vol" };
            })
        };

        saveData({ date: getISTDate(), targetStocks: top5, growwData: growwDetails, history: [initialSnapshot] });
        console.log("OK: Day initialized.");
    } catch (e) {
        console.error("Critical Error in startDay:", e);
    } finally {
        isScanning = false; // RELEASE LOCK
    }
}

async function trackProgress() {
    if (isTrackingPaused) { console.log("Paused."); return; }
    if (isScanning) { console.log("Scan already in progress."); return; }
    
    isScanning = true; 
    
    try {
        let data = getStoredData();
        if (isDataStale(data)) {
            console.log("Stale data found. Starting new day.");
            isScanning = false; // Unlock before starting day
            if (!isTrackingPaused) await startDay();
            return;
        }
        
        if (!data.targetStocks || data.targetStocks.length === 0) {
            isScanning = false; // Unlock before starting day
            if (!isTrackingPaused) await startDay();
            return;
        }

        console.log(`--- TRACKING ${getISTTime()} ---`);
        const currentMarketData = await scrapeNSE();
        const updatedGrowwData = await scrapeGroww(data.targetStocks);
        if (Object.keys(updatedGrowwData).length > 0) data.growwData = updatedGrowwData;

        const snapshot = { time: getISTTime(), updates: [] };
        data.targetStocks.forEach(symbol => {
            const found = currentMarketData.find(s => s.symbol === symbol);
            let change = "0";
            if (found) {
                if (data.history.length > 0) {
                    const last = data.history[data.history.length - 1].updates.find(u => u.symbol === symbol);
                    if (last && last.volume !== "N/A") {
                        const diff = found.volume - last.volume;
                        change = diff > 0 ? `+${diff}` : `${diff}`;
                    }
                }
                snapshot.updates.push({ symbol, volume: found.volume, status: "Active", change });
            } else {
                snapshot.updates.push({ symbol, volume: "N/A", status: "Disappeared", change: "0" });
            }
        });

        data.history.push(snapshot);
        saveData(data);
        console.log("OK: Data saved.");
    } catch (e) {
        console.error("Critical Error in trackProgress:", e);
    } finally {
        isScanning = false; // RELEASE LOCK
    }
}

// --- SCHEDULER (IST) ---
cron.schedule('15 9 * * *', () => { if(!isTrackingPaused) startDay(); }, { timezone: "Asia/Kolkata" }); 
cron.schedule('*/10 9-15 * * *', () => { 
    const h = getISTHour();
    if (h >= 9 && h <= 15) trackProgress();
}, { timezone: "Asia/Kolkata" });

// --- APIs ---
app.get('/api/data', (req, res) => {
    const data = getStoredData();
    const stale = isDataStale(data);
    const responseData = stale ? emptyData() : data;
    res.json({ ...responseData, isPaused: isTrackingPaused, isScanning, isStale: stale });
}); 

app.get('/api/control/pause', (req, res) => {
    isTrackingPaused = true;
    res.json({ message: "Paused", isPaused: true });
});

app.get('/api/control/resume', (req, res) => {
    isTrackingPaused = false;
    const data = getStoredData();
    if (isDataStale(data) || !data.targetStocks || data.targetStocks.length === 0) startDay();
    else trackProgress();
    res.json({ message: "Resumed", isPaused: false });
});

app.get('/api/control/force-fetch', async (req, res) => {
    if (isScanning) return res.status(429).json({ message: "Scan already running!" });
    
    const wasPaused = isTrackingPaused;
    isTrackingPaused = false; 
    
    // Run async to return response immediately
    trackProgress().finally(() => {
        isTrackingPaused = wasPaused; 
    });

    res.json({ message: "Fetch Triggered" });
});

app.get('/api/control/restart-day', async (req, res) => {
    if (isScanning) return res.status(429).json({ message: "Scan already running!" });
    startDay(); 
    res.json({ message: "Day Reset Triggered" });
});

app.use(express.static(path.join(__dirname, 'client/build')));
app.get(/(.*)/, (req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/data')) return res.status(404).send("API endpoint not found");
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
});

app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (!fs.existsSync(DATA_FILE)) console.log("Info: No data file.");
});
