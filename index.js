// index.js
const express = require('express');
const cors = require('cors');
const { JSDOM } = require('jsdom');
const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

let browser, page;
let initialized = false;
let fetching = false;
let cache = null;

// ----------- Parser -----------

function parseRoomHeader(row) {
  const headerText = row.textContent.replace(/\s+/g, ' ').trim();
  const roomNameLink = row.querySelector('a[data-href*="/stats/mkw/list/r"]');
  const trackLink = row.querySelector('a[data-href*="ct.wiimm.de"]');

  let type = "unknown";
  if (headerText.toLowerCase().includes('private room')) type = "private";
  else if (headerText.toLowerCase().includes('worldwide room')) type = "worldwide";

  let created = "unknown";
  const createdMatch = headerText.match(/\(created\s+(.*?)\)/);
  if (createdMatch) created = createdMatch[1];

  let last_track = "—unknown—";
  if (trackLink) last_track = trackLink.textContent.trim();
  else {
    const shaMatch = headerText.match(/SHA1:\s*([\da-f]{40})/);
    if (shaMatch) last_track = "SHA1: " + shaMatch[1];
  }

  return {
    room_id: roomNameLink ? roomNameLink.textContent.trim() : 'Unknown',
    type,
    created,
    last_track
  };
}
__name(parseRoomHeader, "parseRoomHeader");

function parsePlayerRow(row) {
  const columns = row.querySelectorAll('td');
  if (columns.length < 9) return null;

  const fcLink = columns[0].querySelector('a[data-href*="/stats/mkw/list/p"]');
  const miiNameSpan = columns[8].querySelector('span.mii-font');
  if (!fcLink || !miiNameSpan) return null;

  const roleText = columns[1].textContent.replace(/\d+\.\s*/, '').trim();

  return {
    pid: (columns[0].title || '').replace('pid=', '').trim(),
    fc: fcLink.textContent.trim(),
    role: roleText,
    region: columns[2].textContent.trim(),
    room_mode: columns[3].textContent.trim(),
    world: columns[4].textContent.trim(),
    conn_fail: columns[5].textContent.trim(),
    ev: columns[6].textContent.trim(),
    eb: columns[7].textContent.trim(),
    name: miiNameSpan.textContent.trim()
  };
}
__name(parsePlayerRow, "parsePlayerRow");

function parseFromHtml(html) {
  const dom = new JSDOM(html);
  const rows = dom.window.document.querySelectorAll('.table11 tr');
  let allRooms = [];
  let currentRoom = null;

  for (const row of rows) {
    if (row.id && row.id.startsWith('r')) {
      if (currentRoom) allRooms.push(currentRoom);
      currentRoom = { ...parseRoomHeader(row), players: [] };
    } else if (currentRoom && (row.classList.contains('tr0') || row.classList.contains('tr1'))) {
      const player = parsePlayerRow(row);
      if (player) currentRoom.players.push(player);
    }
  }
  if (currentRoom) allRooms.push(currentRoom);
  return allRooms;
}
__name(parseFromHtml, "parseFromHtml");

// ----------- Puppeteer -----------

async function initBrowser() {
  console.log("Launching Chromium...");

  const executablePath = await chromium.executablePath;

  // KORRIGIERT: Der Fallback '/usr/bin/chromium-browser' wurde entfernt.
  // Wir verlassen uns *nur* auf chrome-aws-lambda.
  if (!executablePath) {
    throw new Error("Chromium executable not found, chrome-aws-lambda setup failed.");
  }
  
  browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: executablePath,
    headless: chromium.headless // Wichtig: Muss headless sein
  });

  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36'
  );

  initialized = true;
  console.log("Browser ready.");
}
__name(initBrowser, "initBrowser");

// ----------- Local fallback -----------
function tryLocalFallback() {
  const file = path.join(process.cwd(), 'wiimmfi.html');
  if (!fs.existsSync(file)) return null;
  console.log('Using local fallback file.');
  const html = fs.readFileSync(file, 'utf8');
  const rooms = parseFromHtml(html);
  console.log(`Parsed ${rooms.length} rooms offline.`);
  return rooms;
}
__name(tryLocalFallback, "tryLocalFallback");

// ----------- Main endpoint -----------

app.get('/', async (req, res) => {
  // Sofort den Cache senden, wenn vorhanden
  if (cache) {
    res.status(200).send(cache);
  }

  // Wenn gerade ein Fetch läuft, kommt die Anfrage auf die "Warteliste"
  // (sie bekommt den Cache, sobald der Fetch fertig ist)
  if (fetching) {
    if (!cache) {
      // Seltener Fall: Erster Start, Cache ist leer, Fetch läuft
      res.status(503).send(JSON.stringify({ error: "Server is warming up, please try again in 30 seconds." }));
    }
    return;
  }
  
  // Nur wenn *nicht* schon gefetcht wird, einen neuen Fetch starten.
  fetching = true;

  try {
    if (!initialized) await initBrowser();

    console.log("Navigating to Wiimmfi...");
    await page.goto('https://wiimmfi.de/stats/mkw', {
      timeout: 120000,
      waitUntil: 'networkidle2'
    });

    const html = await page.content();
    if (!html.includes('table11')) {
      console.warn("No tables found, falling back to local HTML.");
      const fallback = tryLocalFallback();
      cache = JSON.stringify(fallback || [], null, 2);
    } else {
        const rooms = parseFromHtml(html);
        cache = JSON.stringify(rooms, null, 2);
        console.log(`Fetched ${rooms.length} rooms.`);
    }
    
    // Wenn die Antwort noch nicht gesendet wurde (weil der Cache leer war),
    // sende sie jetzt.
    if (!res.headersSent) {
        res.status(200).send(cache);
    }

  } catch (e) {
    console.error("Error during scraping:", e);
    // Nur den Fallback verwenden, wenn der Cache noch nie befüllt wurde
    if (!cache) {
        const fallback = tryLocalFallback();
        cache = JSON.stringify(fallback || [], null, 2);
        if (!res.headersSent) {
            res.status(200).send(cache);
        }
    }
  } finally {
    fetching = false;
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`→ GET http://localhost:${PORT}/`);
});

// Clean shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
});
