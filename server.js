const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fs = require('fs');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 5000;
const DATA_FILE = path.join(__dirname, 'daily_data.json');
const NSE_URL = 'https://www.nseindia.com/market-data/top-gainers-losers';
const GROWW_URL = 'https://groww.in/stocks/most-bought-stocks-on-groww';

// --- GLOBAL CONTROL SWITCH ---
// CHANGE: Default is TRUE (Paused) so it doesn't run automatically
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

// --- SCRAPERS ---
async function scrapeNSE() {
    console.log("Launching browser for NSE...");
    // REPLACE THIS LINE IN BOTH SCRAPER FUNCTIONS
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Vital for Render's memory limits
            '--disable-gpu'
        ]
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
        await page.goto(NSE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('#topgainer-Table', { timeout: 10000 });

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
        await browser.close();
        return [];
    }
}

async function scrapeGroww(targetSymbols) {
    console.log("Launching browser for Groww...");
    // REPLACE THIS LINE IN BOTH SCRAPER FUNCTIONS
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Vital for Render's memory limits
            '--disable-gpu'
        ]
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    const growwData = {};

    try {
        await page.goto(GROWW_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        const mostBoughtList = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a.seeMore_companyNameLink__lvbvi')).map(link => ({
                name: link.innerText.trim(),
                link: link.getAttribute('href')
            }));
        });

        for (const symbol of targetSymbols) {
            const normalizedTarget = normalize(symbol);
            const match = mostBoughtList.find(g => {
                const gName = normalize(g.name);
                return gName.includes(normalizedTarget) || normalizedTarget.includes(gName);
            });

            if (match) {
                const stockPage = await browser.newPage();
                try {
                    await stockPage.goto(`https://groww.in${match.link}`, { waitUntil: 'networkidle2' });
                    try { await stockPage.waitForSelector('.shp76Row', { timeout: 5000 }); } catch (e) { }

                    const shareholding = await stockPage.evaluate(() => {
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
                await stockPage.close();
            } else {
                growwData[symbol] = { inMostBought: false, shareholding: null };
            }
        }
        await browser.close();
        return growwData;
    } catch (error) {
        console.error("Groww Error:", error);
        await browser.close();
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

    // CHANGE: Create the FIRST history entry immediately so volume shows on UI
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
        history: [initialSnapshot] // Save with initial history
    });
    console.log("✅ Day Initialized with Baseline Volume.");
}

async function trackProgress() {
    // *** PAUSE CHECK ***
    if (isTrackingPaused) {
        console.log("⏸️ Tracking is PAUSED. Skipping cycle.");
        return;
    }

    let data = getStoredData();
    if (!data.targetStocks || data.targetStocks.length === 0) {
        // If no data exists, run startDay but respect pause
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
// Only runs if not paused
cron.schedule('15 9 * * *', () => {
    if (!isTrackingPaused) startDay();
});
cron.schedule('*/10 9-15 * * *', () => {
    const h = new Date().getHours();
    if (h >= 9 && h <= 15) trackProgress();
});

// --- APIs ---
app.get('/api/data', (req, res) => res.json({ ...getStoredData(), isPaused: isTrackingPaused }));

app.get('/api/control/pause', (req, res) => {
    isTrackingPaused = true;
    console.log("⏸️ SYSTEM PAUSED BY USER");
    res.json({ message: "Paused", isPaused: true });
});

app.get('/api/control/resume', (req, res) => {
    isTrackingPaused = false;
    console.log("▶️ SYSTEM RESUMED BY USER");
    // If we resume and there is no data, start the day
    const data = getStoredData();
    if (!data.targetStocks || data.targetStocks.length === 0) {
        startDay();
    } else {
        trackProgress(); // Run one check immediately on resume
    }
    res.json({ message: "Resumed", isPaused: false });
});

app.get('/api/control/force-fetch', async (req, res) => {
    console.log("⚡ FORCE FETCH TRIGGERED");
    const wasPaused = isTrackingPaused;
    isTrackingPaused = false;
    await trackProgress();
    isTrackingPaused = wasPaused;
    res.json({ message: "Fetch Complete" });
});

app.get('/api/control/restart-day', async (req, res) => {
    console.log("🔄 RESTART DAY TRIGGERED");
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
    // We do NOT auto-start startDay() here anymore. 
    // It waits for user to click "Start" or "Restart Day" if file is empty.
    if (!fs.existsSync(DATA_FILE)) {
        console.log("ℹ️ No data file. Waiting for user to Start Tracking.");
    }
});