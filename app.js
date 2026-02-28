/* Tilt Charades - Mobile web app
   - iOS requires user gesture permission for motion sensors
   - Serve over HTTPS (or localhost)
*/

const SCREENS = {
    categories: document.getElementById("screen-categories"),
    countdown: document.getElementById("screen-countdown"),
    game: document.getElementById("screen-game"),
    results: document.getElementById("screen-results"),
};

const ui = {
    enableMotion: document.getElementById("btn-enable-motion"),
    categoryList: document.getElementById("category-list"),
    countdownNumber: document.getElementById("countdown-number"),
    timer: document.getElementById("timer"),
    categoryName: document.getElementById("category-name"),
    word: document.getElementById("word"),
    overlay: document.getElementById("status-overlay"),
    overlayText: document.getElementById("status-text"),
    score: document.getElementById("score"),
    resultsList: document.getElementById("results-list"),
    backBtn: document.getElementById("btn-back"),
};

const CONFIG = {
    countdownSeconds: 5,
    roundSeconds: 60,

    // Tilt thresholds (degrees)
    // beta is front-to-back tilt: 0 = flat, 90 = upright portrait, negative = other direction
    // We'll use a "relative" interpretation: when holding phone to forehead, beta tends to be around 80-100.
    // We'll detect a "tilt up" vs "tilt down" relative to a calibrated baseline.
    tiltDeltaCorrect: 18,
    tiltDeltaPass: -18,

    // Debounce so one tilt doesn't trigger multiple times
    actionCooldownMs: 900,

    // How long to show correct/pass overlay
    overlayMs: 450,
};

let audioCtx = null;

// --- Game state ---
let categoriesIndex = [];
let currentCategory = null; // { name, file }
let words = [];
let deck = [];
let deckIndex = 0;

let baselineBeta = null; // calibration baseline
let lastActionAt = 0;
let gameActive = false;

let countdownTimer = null;
let roundTimer = null;
let roundEndsAt = 0;

let used = []; // [{ word, result: "correct"|"pass" }], includes current word when ended (handled)
let score = 0;

// Wake Lock (keeps screen on during round where supported)
let wakeLock = null;

// ---------------- UI helpers ----------------
function showScreen(name) {
    Object.values(SCREENS).forEach(s => s.classList.remove("active"));
    SCREENS[name].classList.add("active");
}

function setOverlay(text, type) {
    ui.overlayText.textContent = text;
    ui.overlayText.style.borderColor = type === "correct" ? "rgba(46,204,113,0.55)" : "rgba(255,77,77,0.55)";
    ui.overlayText.style.background =
        type === "correct" ? "rgba(46,204,113,0.20)" : "rgba(255,77,77,0.20)";
    ui.overlay.classList.add("show");
    ui.overlay.setAttribute("aria-hidden", "false");
    setTimeout(() => {
        ui.overlay.classList.remove("show");
        ui.overlay.setAttribute("aria-hidden", "true");
    }, CONFIG.overlayMs);
}

// ---------------- Audio (no external files) ----------------
function ensureAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
}

function beep({ freq = 440, duration = 0.12, type = "sine", gain = 0.05 } = {}) {
    ensureAudio();
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
}

const sounds = {
    countdownTick() { beep({ freq: 660, duration: 0.08, gain: 0.06 }); },
    roundStart() { beep({ freq: 880, duration: 0.18, gain: 0.07 }); },
    correct() { beep({ freq: 1040, duration: 0.12, gain: 0.07 }); setTimeout(() => beep({ freq: 1320, duration: 0.10, gain: 0.06 }), 80); },
    pass() { beep({ freq: 240, duration: 0.14, type: "square", gain: 0.05 }); },
    roundEnd() { beep({ freq: 330, duration: 0.20, gain: 0.07 }); setTimeout(() => beep({ freq: 220, duration: 0.24, gain: 0.07 }), 160); },
};

// ---------------- Categories loading ----------------
async function loadCategoriesIndex() {
    // Single index file. Add categories here (or use the optional Node generator).
    const res = await fetch("categories/1_categories.json", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load categories index");
    const data = await res.json();

    if (!Array.isArray(data.categories)) throw new Error("Invalid categories.json format");

    categoriesIndex = data.categories;
}

function renderCategories() {
    ui.categoryList.innerHTML = "";

    categoriesIndex.forEach(cat => {
        const btn = document.createElement("button");
        btn.className = "category-btn";
        btn.type = "button";
        btn.innerHTML = `<div>${escapeHtml(cat.name)}</div><span>Tap to start</span>`;
        btn.addEventListener("click", () => startCategory(cat));
        ui.categoryList.appendChild(btn);
    });

    if (categoriesIndex.length === 0) {
        ui.categoryList.innerHTML = `<p class="hint">No categories found. Add JSON files in /categories and list them in categories.json.</p>`;
    }
}

async function loadCategoryWords(file) {
    const res = await fetch(`categories/${file}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load category: ${file}`);
    const data = await res.json();

    if (!Array.isArray(data.words)) throw new Error(`Invalid category file format: ${file}`);

    // Normalize words: trim, remove blanks, ensure strings
    return data.words
        .map(w => (typeof w === "string" ? w.trim() : ""))
        .filter(Boolean);
}

// ---------------- Game flow ----------------
async function startCategory(cat) {
    try {
        currentCategory = cat;
        ui.categoryName.textContent = cat.name;

        words = await loadCategoryWords(cat.file);
        if (words.length < 1) {
            alert("This category has no words.");
            return;
        }

        // Randomize deck each round:
        deck = shuffle([...words]);
        deckIndex = 0;

        used = [];
        score = 0;

        // Go to countdown
        showScreen("countdown");
        await maybeLockOrientation();
        await requestWakeLock();

        runCountdownAndStart();
    } catch (err) {
        console.error(err);
        alert("Could not start category. Check console for details.");
    }
}

function runCountdownAndStart() {
    clearTimers();
    baselineBeta = null;

    let remaining = CONFIG.countdownSeconds;
    ui.countdownNumber.textContent = String(remaining);

    // Audible “about to start” sound: tick each second
    sounds.countdownTick();

    countdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining > 0) {
            ui.countdownNumber.textContent = String(remaining);
            sounds.countdownTick();
        } else {
            clearInterval(countdownTimer);
            countdownTimer = null;
            sounds.roundStart();
            beginRound();
        }
    }, 1000);
}

function beginRound() {
    showScreen("game");
    gameActive = true;
    lastActionAt = 0;

    // Start with first word
    deckIndex = 0;
    showNextWord();

    // Round timer
    roundEndsAt = Date.now() + CONFIG.roundSeconds * 1000;
    ui.timer.textContent = String(CONFIG.roundSeconds);

    roundTimer = setInterval(() => {
        const msLeft = roundEndsAt - Date.now();
        const sLeft = Math.max(0, Math.ceil(msLeft / 1000));
        ui.timer.textContent = String(sLeft);

        if (msLeft <= 0) {
            endRound();
        }
    }, 200);
}

function endRound() {
    if (!gameActive) return;
    gameActive = false;

    clearTimers();
    sounds.roundEnd();
    releaseWakeLock();

    // Include current word in results if it exists and wasn't already recorded this turn.
    const currentWord = ui.word.textContent?.trim();
    if (currentWord && !used.some(u => u.word === currentWord && u._current === true)) {
        // mark as "pass" by default? The user asked: include current word being tried.
        // We'll label it "pass" so it's red (common behavior).
        used.push({ word: currentWord, result: "pass", _current: true });
    }

    renderResults();
    showScreen("results");
}

function renderResults() {
    ui.score.textContent = String(score);
    ui.resultsList.innerHTML = "";

    used.forEach(item => {
        const li = document.createElement("li");
        li.textContent = item.word;

        if (item.result === "correct") li.className = "correct";
        else li.className = "passed";

        ui.resultsList.appendChild(li);
    });
}

function showNextWord() {
    if (deckIndex >= deck.length) {
        // If we run out of words, reshuffle and continue so the round always works.
        deck = shuffle([...words]);
        deckIndex = 0;
    }
    ui.word.textContent = deck[deckIndex];
}

// ---------------- Tilt handling ----------------
function onDeviceOrientation(e) {
    // beta: front-to-back tilt in degrees. Range approx [-180, 180]
    // We calibrate baseline when gameplay starts and we get first stable reading.
    if (!gameActive) return;

    const beta = e.beta;
    if (typeof beta !== "number") return;

    // Calibration
    if (baselineBeta === null) {
        baselineBeta = beta;
        return;
    }

    const now = Date.now();
    if (now - lastActionAt < CONFIG.actionCooldownMs) return;

    const delta = beta - baselineBeta;

    // Tilt up (towards user looking up) can vary depending on how held.
    // With baseline, we trigger when beta increases enough, and pass when decreases enough.
    if (delta >= CONFIG.tiltDeltaCorrect) {
        handleAction("correct");
    } else if (delta <= CONFIG.tiltDeltaPass) {
        handleAction("pass");
    }
}

function handleAction(type) {
    if (!gameActive) return;
    lastActionAt = Date.now();

    const current = ui.word.textContent;

    if (type === "correct") {
        score += 1;
        used.push({ word: current, result: "correct" });
        sounds.correct();
        setOverlay("Correct!", "correct");
    } else {
        used.push({ word: current, result: "pass" });
        sounds.pass();
        setOverlay("Pass", "pass");
    }

    deckIndex += 1;
    // Small delay so overlay reads clearly, then next word
    setTimeout(() => {
        if (!gameActive) return;
        showNextWord();

        // Recalibrate baseline a bit so repeated small movements don't drift
        // (we re-baseline on the next motion event naturally, but keep stable)
        // We'll nudge baseline toward current posture by setting it to null, re-learn next event.
        baselineBeta = null;
    }, CONFIG.overlayMs * 0.9);
}

// ---------------- Permissions / platform helpers ----------------
async function enableMotionIfNeeded() {
    // iOS 13+: DeviceMotion / DeviceOrientation permission is required.
    // Some browsers only expose DeviceOrientationEvent.requestPermission.
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
        try {
            const resp = await DeviceOrientationEvent.requestPermission();
            if (resp !== "granted") {
                alert("Motion permission not granted. Tilt controls won’t work.");
            }
        } catch (err) {
            console.error(err);
            alert("Could not request motion permission.");
        }
    }
}

async function maybeLockOrientation() {
    // Optional: attempt to lock to landscape (common for heads-up style)
    // Only works in some browsers and usually requires fullscreen / user gesture.
    try {
        if (screen.orientation && screen.orientation.lock) {
            // Try landscape; ignore failure.
            await screen.orientation.lock("landscape");
        }
    } catch (_) { }
}

async function requestWakeLock() {
    try {
        if ("wakeLock" in navigator && navigator.wakeLock.request) {
            wakeLock = await navigator.wakeLock.request("screen");
        }
    } catch (_) {
        wakeLock = null;
    }
}

function releaseWakeLock() {
    try {
        if (wakeLock) wakeLock.release();
    } catch (_) { }
    wakeLock = null;
}

// ---------------- Utils ----------------
function clearTimers() {
    if (countdownTimer) clearInterval(countdownTimer);
    if (roundTimer) clearInterval(roundTimer);
    countdownTimer = null;
    roundTimer = null;
}

function shuffle(arr) {
    // Fisher-Yates
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[c]));
}

// ---------------- Init ----------------
async function init() {
    // Hook up motion listener (works after permission on iOS)
    window.addEventListener("deviceorientation", onDeviceOrientation, { passive: true });

    ui.enableMotion.addEventListener("click", async () => {
        await enableMotionIfNeeded();
        // Also resume audio context on user gesture to allow sounds
        ensureAudio();
        if (audioCtx.state === "suspended") await audioCtx.resume();
        alert("Motion enabled (if supported). You can start a category now.");
    });

    ui.backBtn.addEventListener("click", () => {
        clearTimers();
        gameActive = false;
        releaseWakeLock();
        showScreen("categories");
    });

    // Load categories
    try {
        await loadCategoriesIndex();
        renderCategories();
    } catch (err) {
        console.error(err);
        ui.categoryList.innerHTML = `<p class="hint">Failed to load categories. Make sure /categories/categories.json exists.</p>`;
    }

    showScreen("categories");
}

init();