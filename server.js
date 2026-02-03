const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fs = require('fs');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000; // Use Render's port
const DATA_FILE = path.join(__dirname, 'daily_data.json');
const NSE_URL = 'https://www.nseindia.com/market-data/top-gainers-losers';
const GROWW_URL = 'https://groww.in/stocks/most-bought-stocks-on-groww';

let isTrackingPaused = true; 

// --- HELPER: Read/Write Data File ---
function getStoredData() {
    if (!fs.existsSync(DATA_FILE)) return { targetStocks: [], growwData: {}, history: [] };
    const rawData = fs.readFileSync(DATA_FILE);
    try {
        return JSON.parse(rawData);
    } catch (e) {
        return { targetStocks: [], growwData: {}, history: [] };
    }
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function normalize(str) {
    if (!str) return "";
    return str.toUpperCase().replace(/LTD|LIMITED/g, '').replace(/[^A-Z0-9]/g, '');
}

// --- OPTIMIZED BROWSER LAUNCHER (FIXED FOR RENDER) ---
async function getBrowser() {
    return await puppeteer.launch({ 
        headless: "new", 
        // INCREASE TIMEOUT: Give Render 2 minutes to start Chrome (vs default 30s)
        timeout: 120000, 
        // KEY FIX: Pipe logs to stdout. This often fixes the "WS Endpoint" timeout on Render
        dumpio: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Vital for Render's memory limits
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', 
            '--disable-gpu'
        ] 
    });
}

// --- SCRAPERS ---
async function scrapeNSE() {
    console.log("Launching browser for NSE...");
    const browser = await getBrowser();
    
    try {
        const page = await browser.newPage();
        
        // Block images/fonts to save memory
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(NSE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('#topgainer-Table', { timeout: 15000 });

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
        console.error("NSE Scraping Error:", error.message);
        if(browser) await browser.close();
        return [];
    }
}

async function scrapeGroww(targetSymbols) {
    console.log("Launching browser for Groww...");
    const browser = await getBrowser();
    const growwData = {};

    try {
        const page = await browser.newPage();
        
        // Block resources
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(GROWW_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        const mostBoughtList = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a.seeMore_companyNameLink__lvbvi')).map(link => ({
                name: link.innerText.trim(),
                link: link.getAttribute('href')
            }));
        });

        // OPTIMIZATION: Reuse the SAME page/tab instead of opening new ones
        for (const symbol of targetSymbols) {
            const normalizedTarget = normalize(symbol);
            const match = mostBoughtList.find(g => {
                const gName = normalize(g.name);
                return gName.includes(normalizedTarget) || normalizedTarget.includes(gName);
            });

            if (match) {
                try {
                    await page.goto(`https://groww.in${match.link}`, { waitUntil: 'domcontentloaded' });
                    
                    // Fast wait
                    try { await page.waitForSelector('.shp76Row', { timeout: 3000 }); } catch (e) {}
                    
                    const shareholding = await page.evaluate(() => {
                        const pattern = {};
                        document.querySelectorAll('.shp76Row').forEach(row => {
                            const cat = row.querySelector('.bodyLarge')?.innerText;
                            const val = row.querySelector('.shp76TextRight')?.innerText;
                            if (cat && val) pattern[cat] = val;
                        });
                        return pattern;
                    });
                    growwData[symbol] = { inMostBought: true, growwName: match.name, shareholding: Object.keys(shareholding).length > 0 ? shareholding : "Not Found" };
                } catch (e) {
                    growwData[symbol] = { inMostBought: true, growwName: match.name, shareholding: "Error" };
                }
            } else {
                growwData[symbol] = { inMostBought: false, shareholding: null };
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

// --- MAIN LOGIC ---
async function startDay() {
    console.log("--- INITIALIZING DAY ---");
    const allStocks = await scrapeNSE();
    allStocks.sort((a, b) => b.volume - a.volume);
    const top5 = allStocks.slice(0, 5).map(s => s.symbol);

    if (top5.length === 0) { console.log("❌ No data from NSE."); return; }

    const growwDetails = await scrapeGroww(top5);

    const initialSnapshot = {
        time: "Market Open",
        updates: top5.map(symbol => {
            const stock = allStocks.find(s => s.symbol === symbol);
            return {
                symbol: symbol,
                volume: stock ? stock.volume : 0,
                status: "Active",
                change: "Base Vol"
            };
        })
    };

    saveData({ 
        date: new Date().toDateString(), 
        targetStocks: top5, 
        growwData: growwDetails, 
        history: [initialSnapshot] 
    });
    console.log("✅ Day Initialized.");
}

async function trackProgress() {
    if (isTrackingPaused) {
        console.log("⏸️ Tracking is PAUSED.");
        return;
    }

    let data = getStoredData();
    if (!data.targetStocks || data.targetStocks.length === 0) {
        if (!isTrackingPaused) await startDay();
        return;
    }

    console.log(`--- TRACKING ${new Date().toLocaleTimeString()} ---`);
    const currentMarketData = await scrapeNSE();
    
    // Groww Update
    const updatedGrowwData = await scrapeGroww(data.targetStocks);
    if (Object.keys(updatedGrowwData).length > 0) data.growwData = updatedGrowwData;

    // History Update
    const snapshot = { time: new Date().toLocaleTimeString(), updates: [] };
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
    console.log("✅ Data Saved.");
}

// --- SCHEDULER ---
cron.schedule('15 9 * * *', () => {
    if(!isTrackingPaused) startDay();
}); 
cron.schedule('*/10 9-15 * * *', () => { 
    const h = new Date().getHours();
    if (h >= 9 && h <= 15) trackProgress();
});

// --- APIs ---
app.get('/api/data', (req, res) => res.json({ ...getStoredData(), isPaused: isTrackingPaused }));

app.get('/api/control/pause', (req, res) => {
    isTrackingPaused = true;
    console.log("⏸️ SYSTEM PAUSED");
    res.json({ message: "Paused", isPaused: true });
});

app.get('/api/control/resume', (req, res) => {
    isTrackingPaused = false;
    console.log("▶️ SYSTEM RESUMED");
    const data = getStoredData();
    if (!data.targetStocks || data.targetStocks.length === 0) {
        startDay();
    } else {
        trackProgress();
    }
    res.json({ message: "Resumed", isPaused: false });
});

app.get('/api/control/force-fetch', async (req, res) => {
    console.log("⚡ FORCE FETCH");
    const wasPaused = isTrackingPaused;
    isTrackingPaused = false; 
    await trackProgress();
    isTrackingPaused = wasPaused; 
    res.json({ message: "Fetch Complete" });
});

app.get('/api/control/restart-day', async (req, res) => {
    console.log("🔄 RESTART DAY");
    await startDay();
    res.json({ message: "Day Reset Complete" });
});

// --- SERVE FRONTEND ---
app.use(express.static(path.join(__dirname, 'client/build')));
app.get(/(.*)/, (req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/data')) {
        return res.status(404).send("API endpoint not found");
    }
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
});

app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (!fs.existsSync(DATA_FILE)) {
        console.log("ℹ️ No data file. Waiting for user to Start Tracking.");
    }
});