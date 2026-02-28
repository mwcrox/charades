const SCREENS = {
    categories: document.getElementById("screen-categories"),
    countdown: document.getElementById("screen-countdown"),
    game: document.getElementById("screen-game"),
    results: document.getElementById("screen-results"),
};

const ui = {
    // modal / overlays
    motionModal: document.getElementById("motion-modal"),
    modalEnable: document.getElementById("modal-enable"),
    rotateOverlay: document.getElementById("rotate-overlay"),

    // category screen
    categoryList: document.getElementById("category-list"),

    // countdown
    countdownNumber: document.getElementById("countdown-number"),

    // gameplay
    timer: document.getElementById("timer"),
    categoryName: document.getElementById("category-name"),
    word: document.getElementById("word"),
    overlay: document.getElementById("status-overlay"),
    overlayText: document.getElementById("status-text"),

    // results
    score: document.getElementById("score"),
    resultsList: document.getElementById("results-list"),
    backBtn: document.getElementById("btn-back"),
};

const CONFIG = {
    indexFile: "categories/1_categories.json", // <-- your renamed index file

    countdownSeconds: 5,
    roundSeconds: 60,

    // STRONG thresholds (relative to neutral)
    // We calibrate neutral when round starts and also after each word.
    // Then we require returning to neutral before next word appears.
    neutralToleranceDeg: 8,     // must be within this to be "neutral"
    correctThresholdDeg: 35,    // tilt toward sky
    passThresholdDeg: -35,      // tilt toward floor

    overlayMs: 420,
};

let audioCtx = null;
function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}
function beep({ freq = 440, duration = 0.12, type = "sine", gain = 0.06 } = {}) {
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
    countdownTick() { beep({ freq: 660, duration: 0.08, gain: 0.07 }); },
    roundStart() { beep({ freq: 880, duration: 0.18, gain: 0.08 }); },
    correct() { beep({ freq: 1040, duration: 0.12, gain: 0.08 }); setTimeout(() => beep({ freq: 1320, duration: 0.10, gain: 0.07 }), 70); },
    pass() { beep({ freq: 240, duration: 0.16, type: "square", gain: 0.06 }); },
    roundEnd() { beep({ freq: 330, duration: 0.20, gain: 0.08 }); setTimeout(() => beep({ freq: 220, duration: 0.25, gain: 0.08 }), 160); },
};

// ---------- state ----------
let categoriesIndex = [];
let currentCategory = null;

let words = [];
let deck = [];
let deckIndex = 0;

let countdownTimer = null;
let roundTimer = null;
let roundEndsAt = 0;

let gameActive = false;
let used = []; // { word, result: "correct"|"bad" }
let score = 0;

// Motion / tilt gating
let neutralRef = null;        // { beta, gamma } baseline "forehead neutral"
let tiltState = "NEED_NEUTRAL"; // NEED_NEUTRAL -> ARMED -> (ACTION) -> NEED_NEUTRAL
let pendingAdvance = false;   // after action, wait for neutral before next word

// ---------- helpers ----------
function showScreen(name) {
    Object.values(SCREENS).forEach(s => s.classList.remove("active"));
    SCREENS[name].classList.add("active");
}

function isLandscape() {
    return window.matchMedia("(orientation: landscape)").matches;
}

function updateRotateOverlay() {
    const mustShow = !isLandscape();
    ui.rotateOverlay.classList.toggle("active", mustShow);
    ui.rotateOverlay.setAttribute("aria-hidden", mustShow ? "false" : "true");
}

function clearTimers() {
    if (countdownTimer) clearInterval(countdownTimer);
    if (roundTimer) clearInterval(roundTimer);
    countdownTimer = null;
    roundTimer = null;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function setOverlay(text, kind) {
    ui.overlayText.textContent = text;
    ui.overlayText.style.borderColor = kind === "correct" ? "rgba(46,204,113,0.6)" : "rgba(255,59,59,0.6)";
    ui.overlayText.style.background = kind === "correct" ? "rgba(46,204,113,0.22)" : "rgba(255,59,59,0.22)";
    ui.overlay.classList.add("show");
    ui.overlay.setAttribute("aria-hidden", "false");
    setTimeout(() => {
        ui.overlay.classList.remove("show");
        ui.overlay.setAttribute("aria-hidden", "true");
    }, CONFIG.overlayMs);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[c]));
}

// ---------- loading categories ----------
async function loadCategoriesIndex() {
    const res = await fetch(CONFIG.indexFile, { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load category index");
    const data = await res.json();
    if (!Array.isArray(data.categories)) throw new Error("Invalid index format");
    categoriesIndex = data.categories;
}

function renderCategories() {
    ui.categoryList.innerHTML = "";
    categoriesIndex.forEach(cat => {
        const btn = document.createElement("button");
        btn.className = "category-btn";
        btn.type = "button";
        btn.innerHTML = escapeHtml(cat.name);
        btn.addEventListener("click", () => startCategory(cat));
        ui.categoryList.appendChild(btn);
    });
}

async function loadCategoryWords(file) {
    const res = await fetch(`categories/${file}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load category file: ${file}`);
    const data = await res.json();
    if (!Array.isArray(data.words)) throw new Error("Invalid category format");
    return data.words.map(w => (typeof w === "string" ? w.trim() : "")).filter(Boolean);
}

// ---------- permission / start ----------
async function requestMotionPermission() {
    // iOS requires this from a user gesture
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
        const resp = await DeviceOrientationEvent.requestPermission();
        if (resp !== "granted") throw new Error("Motion permission not granted");
    }
}

async function tryLockLandscape() {
    try {
        if (screen.orientation && screen.orientation.lock) {
            await screen.orientation.lock("landscape");
        }
    } catch (_) { }
}

// ---------- game flow ----------
async function startCategory(cat) {
    if (!isLandscape()) {
        updateRotateOverlay();
        return;
    }

    currentCategory = cat;
    ui.categoryName.textContent = cat.name;

    words = await loadCategoryWords(cat.file);
    if (!words.length) {
        alert("That category has no words.");
        return;
    }

    deck = shuffle([...words]);
    deckIndex = 0;

    used = [];
    score = 0;

    showScreen("countdown");
    runCountdownAndStart();
}

function runCountdownAndStart() {
    clearTimers();

    let remaining = CONFIG.countdownSeconds;
    ui.countdownNumber.textContent = String(remaining);
    sounds.countdownTick();

    countdownTimer = setInterval(() => {
        if (!isLandscape()) { updateRotateOverlay(); return; }

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
    roundEndsAt = Date.now() + CONFIG.roundSeconds * 1000;
    ui.timer.textContent = String(CONFIG.roundSeconds);

    // reset tilt state
    neutralRef = null;
    tiltState = "NEED_NEUTRAL";
    pendingAdvance = false;

    // first word
    showCurrentWord();

    roundTimer = setInterval(() => {
        if (!gameActive) return;
        if (!isLandscape()) { updateRotateOverlay(); return; }

        const msLeft = roundEndsAt - Date.now();
        const sLeft = Math.max(0, Math.ceil(msLeft / 1000));
        ui.timer.textContent = String(sLeft);

        if (msLeft <= 0) endRound();
    }, 200);
}

function showCurrentWord() {
    if (deckIndex >= deck.length) {
        deck = shuffle([...words]);
        deckIndex = 0;
    }
    ui.word.textContent = deck[deckIndex];
}

function endRound() {
    if (!gameActive) return;
    gameActive = false;
    clearTimers();
    sounds.roundEnd();

    // Include current word if not yet recorded this turn (counts as incomplete/bad)
    const current = ui.word.textContent?.trim();
    if (current && !used.some(u => u.word === current)) {
        used.push({ word: current, result: "bad" });
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
        li.className = item.result === "correct" ? "correct" : "bad";
        ui.resultsList.appendChild(li);
    });
}

// ---------- strict tilt logic (neutral -> action -> back to neutral -> next word) ----------
function deltaFromNeutral(beta, gamma) {
    if (!neutralRef) return { db: 0, dg: 0, mag: 0 };

    const db = beta - neutralRef.beta;
    const dg = gamma - neutralRef.gamma;

    // Use whichever axis has the bigger change (landscape can swap behavior)
    const mag = Math.abs(db) > Math.abs(dg) ? db : dg;
    return { db, dg, mag };
}

function onDeviceOrientation(e) {
    if (!gameActive) return;
    if (!isLandscape()) return;

    const beta = e.beta;
    const gamma = e.gamma;
    if (typeof beta !== "number" || typeof gamma !== "number") return;

    // Calibrate neutral when we first get stable readings in gameplay
    if (!neutralRef) {
        neutralRef = { beta, gamma };
        tiltState = "ARMED";      // once baseline captured, we can accept an action
        return;
    }

    const { mag } = deltaFromNeutral(beta, gamma);
    const inNeutral = Math.abs(mag) <= CONFIG.neutralToleranceDeg;

    // After an action, we must return to neutral before advancing
    if (pendingAdvance) {
        if (inNeutral) {
            pendingAdvance = false;
            // Re-calibrate neutral at the exact "forehead" position again
            neutralRef = { beta, gamma };
            tiltState = "ARMED";
            deckIndex += 1;
            showCurrentWord();
        }
        return;
    }

    // If not armed, wait for neutral
    if (tiltState === "NEED_NEUTRAL") {
        if (inNeutral) tiltState = "ARMED";
        return;
    }

    // Armed: allow one action if thresholds hit
    if (tiltState === "ARMED") {
        if (mag >= CONFIG.correctThresholdDeg) {
            // Correct (screen to sky)
            const current = ui.word.textContent;
            used.push({ word: current, result: "correct" });
            score += 1;
            sounds.correct();
            setOverlay("Correct!", "correct");

            // Now wait until back to neutral before next word
            pendingAdvance = true;
            tiltState = "NEED_NEUTRAL";
            return;
        }

        if (mag <= CONFIG.passThresholdDeg) {
            // Pass (screen to floor)
            const current = ui.word.textContent;
            used.push({ word: current, result: "bad" });
            sounds.pass();
            setOverlay("Pass", "bad");

            pendingAdvance = true;
            tiltState = "NEED_NEUTRAL";
            return;
        }
    }
}

// ---------- init ----------
async function init() {
    // listen for orientation changes
    window.addEventListener("orientationchange", updateRotateOverlay);
    window.addEventListener("resize", updateRotateOverlay);
    updateRotateOverlay();

    // motion events
    window.addEventListener("deviceorientation", onDeviceOrientation, { passive: true });

    // modal enable
    ui.modalEnable.addEventListener("click", async () => {
        try {
            ensureAudio();
            if (audioCtx.state === "suspended") await audioCtx.resume();

            await requestMotionPermission();
            await tryLockLandscape();

            ui.motionModal.classList.remove("active"); // hide modal
            showScreen("categories");                  // now show categories

            updateRotateOverlay();
        } catch (err) {
            alert("Could not enable motion. Check iOS permission and HTTPS/localhost.");
            console.error(err);
        }
    });

    // back button
    ui.backBtn.addEventListener("click", () => {
        clearTimers();
        gameActive = false;
        showScreen("categories");
    });

    // load categories
    try {
        await loadCategoriesIndex();
        renderCategories();
    } catch (err) {
        console.error(err);
        ui.categoryList.innerHTML = `<div style="color:rgba(246,248,255,0.8);font-weight:800;">
      Failed to load categories index. Check <b>${CONFIG.indexFile}</b>.
    </div>`;
    }

    // Start with ONLY the modal visible
    // (No screen should show until permission granted.)
    Object.values(SCREENS).forEach(s => s.classList.remove("active"));
    ui.motionModal.classList.add("active");
}

init();