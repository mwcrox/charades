/* ================================
   Button Charades - Landscape Phone Version
   ================================ */

const SCREENS = {
    categories: document.getElementById("screen-categories"),
    countdown: document.getElementById("screen-countdown"),
    game: document.getElementById("screen-game"),
    results: document.getElementById("screen-results"),
};

const ui = {
    rotateOverlay: document.getElementById("rotate-overlay"),

    categoryList: document.getElementById("category-list"),
    countdownNumber: document.getElementById("countdown-number"),

    timer: document.getElementById("timer"),
    categoryName: document.getElementById("category-name"),
    word: document.getElementById("word"),
    passBtn: document.getElementById("btn-pass"),
    correctBtn: document.getElementById("btn-correct"),

    overlay: document.getElementById("status-overlay"),
    overlayText: document.getElementById("status-text"),

    score: document.getElementById("score"),
    resultsList: document.getElementById("results-list"),
    backBtn: document.getElementById("btn-back"),
};

/* ================================
   CONFIGURATION
   ================================ */

const CONFIG = {
    indexFile: "categories/1_categories.json",
    countdownSeconds: 5,
    roundSeconds: 60,
    overlayMs: 500,
};

/* ================================
   AUDIO
   ================================ */

let audioCtx = null;

function ensureAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
}

async function unlockAudio() {
    ensureAudio();
    if (audioCtx.state === "suspended") {
        await audioCtx.resume();
    }
}

function beep({ freq = 440, duration = 0.12, type = "sine", gain = 0.07 } = {}) {
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
    countdownTick() { beep({ freq: 660, duration: 0.08 }); },
    roundStart() { beep({ freq: 880, duration: 0.18 }); },
    correct() {
        beep({ freq: 1040, duration: 0.12 });
        setTimeout(() => beep({ freq: 1320, duration: 0.1 }), 80);
    },
    pass() { beep({ freq: 240, duration: 0.16, type: "square" }); },
    roundEnd() {
        beep({ freq: 330, duration: 0.2 });
        setTimeout(() => beep({ freq: 220, duration: 0.25 }), 160);
    },
};

/* ================================
   STATE
   ================================ */

let categoriesIndex = [];
let currentCategory = null;

let words = [];
let deck = [];
let deckIndex = 0;

let countdownTimer = null;
let roundTimer = null;
let roundEndsAt = 0;

let gameActive = false;
let used = [];
let score = 0;

/* ================================
   HELPERS
   ================================ */

function showScreen(name) {
    Object.values(SCREENS).forEach(s => s.classList.remove("active"));
    SCREENS[name].classList.add("active");
}

function isLandscape() {
    return window.matchMedia("(orientation: landscape)").matches;
}

function updateRotateOverlay() {
    ui.rotateOverlay.classList.toggle("active", !isLandscape());
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

/* ================================
   CATEGORY LOADING
   ================================ */

async function loadCategoriesIndex() {
    const res = await fetch(CONFIG.indexFile, { cache: "no-store" });
    const data = await res.json();
    categoriesIndex = data.categories || [];
}

function renderCategories() {
    ui.categoryList.innerHTML = "";

    categoriesIndex.forEach(cat => {
        const btn = document.createElement("button");
        btn.className = "category-btn";
        btn.textContent = cat.name;
        btn.onclick = () => startCategory(cat);
        ui.categoryList.appendChild(btn);
    });
}

async function loadCategoryWords(file) {
    const res = await fetch(`categories/${file}`, { cache: "no-store" });
    const data = await res.json();
    return (data.words || []).filter(Boolean);
}

/* ================================
   GAME FLOW
   ================================ */

async function startCategory(cat) {
    updateRotateOverlay();
    if (!isLandscape()) return;

    await unlockAudio();

    currentCategory = cat;
    ui.categoryName.textContent = cat.name;

    words = await loadCategoryWords(cat.file);
    deck = shuffle([...words]);
    deckIndex = 0;

    used = [];
    score = 0;

    showScreen("countdown");
    runCountdown();
}

function runCountdown() {
    let remaining = CONFIG.countdownSeconds;
    ui.countdownNumber.textContent = remaining;
    sounds.countdownTick();

    countdownTimer = setInterval(() => {
        remaining--;

        if (remaining > 0) {
            ui.countdownNumber.textContent = remaining;
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

    showCurrentWord();

    roundEndsAt = Date.now() + CONFIG.roundSeconds * 1000;
    ui.timer.textContent = CONFIG.roundSeconds;

    roundTimer = setInterval(() => {
        const msLeft = roundEndsAt - Date.now();
        const sLeft = Math.max(0, Math.ceil(msLeft / 1000));
        ui.timer.textContent = sLeft;

        if (msLeft <= 0) endRound();
    }, 200);
}

function showCurrentWord() {
    if (deckIndex >= deck.length) {
        deck = shuffle([...words]);
        deckIndex = 0;
    }

    ui.word.textContent = deck[deckIndex] || "No words found";
}

function answerCurrentWord(type) {
    if (!gameActive) return;

    const current = ui.word.textContent;

    if (type === "correct") {
        used.push({ word: current, result: "correct" });
        score++;
        sounds.correct();
        setOverlay("Correct!", "correct");
    } else {
        used.push({ word: current, result: "bad" });
        sounds.pass();
        setOverlay("Pass", "bad");
    }

    deckIndex++;
    showCurrentWord();
}

function endRound() {
    if (!gameActive) return;

    gameActive = false;
    clearTimers();
    sounds.roundEnd();

    const current = ui.word.textContent;
    if (current && current !== "No words found" && !used.some(u => u.word === current)) {
        used.push({ word: current, result: "bad" });
    }

    renderResults();
    showScreen("results");
}

function renderResults() {
    ui.score.textContent = score;
    ui.resultsList.innerHTML = "";

    used.forEach(item => {
        const li = document.createElement("li");
        li.textContent = item.word;
        li.className = item.result === "correct" ? "correct" : "bad";
        ui.resultsList.appendChild(li);
    });
}

function setOverlay(text, type) {
    ui.overlayText.textContent = text;
    ui.overlay.className = `status-overlay show ${type}`;

    setTimeout(() => {
        ui.overlay.className = "status-overlay";
    }, CONFIG.overlayMs);
}

/* ================================
   INIT
   ================================ */

async function init() {
    window.addEventListener("resize", updateRotateOverlay);
    window.addEventListener("orientationchange", updateRotateOverlay);

    ui.passBtn.onclick = () => answerCurrentWord("pass");
    ui.correctBtn.onclick = () => answerCurrentWord("correct");

    ui.backBtn.onclick = () => {
        clearTimers();
        gameActive = false;
        showScreen("categories");
        updateRotateOverlay();
    };

    await loadCategoriesIndex();
    renderCategories();

    showScreen("categories");
    updateRotateOverlay();
}

init();