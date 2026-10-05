const apiKeysEl = document.getElementById("apiKeys");
const toggleKeys = document.getElementById("toggleKeys");
const defaultSettings = {
    minDelaySeconds: 2,
    maxDelaySeconds: 20,
    requestTimeoutSeconds: 45,
    retryDelaySeconds: 2,
    maxRequestAttempts: 3
};

function getSettingsFromForm() {
    return Object.fromEntries(Object.keys(defaultSettings).map(key => [
        key,
        Math.max(0, Number(document.getElementById(key).value) || defaultSettings[key])
    ]));
}

function setSettingsForm(settings) {
    Object.keys(defaultSettings).forEach(key => {
        document.getElementById(key).value = settings[key] ?? defaultSettings[key];
    });
}

chrome.storage.local.get(
    ["apiKeys", "aiSettings"],
    async data => {
        apiKeysEl.value = data.apiKeys ?? "";
        let settings = data.aiSettings || defaultSettings;
        try {
            const response = await fetch("http://localhost:3000/settings");
            if (response.ok) settings = (await response.json()).settings;
        } catch (e) {}
        setSettingsForm(settings);
    }
);

document.getElementById("saveSettings").onclick = async () => {
    const settings = getSettingsFromForm();
    const saved = document.getElementById("settingsSaved");
    try {
        const response = await fetch("http://localhost:3000/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settings)
        });
        if (!response.ok) throw new Error("Server rejected settings");
        const serverSettings = (await response.json()).settings;
        setSettingsForm(serverSettings);
        await chrome.storage.local.set({ apiKeys: apiKeysEl.value, aiSettings: serverSettings });
        saved.textContent = "Saved";
        setTimeout(() => { saved.textContent = ""; }, 2000);
    } catch (error) {
        saved.textContent = "Server offline: saved locally";
        await chrome.storage.local.set({ apiKeys: apiKeysEl.value, aiSettings: settings });
    }
};

toggleKeys.onchange = () => {
    if (toggleKeys.checked) {
        apiKeysEl.classList.remove("censored");
    } else {
        apiKeysEl.classList.add("censored");
    }
};

const start = document.getElementById("start");

start.onclick = async () => {
    const keysArray = apiKeysEl.value.split('\n').map(k => k.trim()).filter(k => k);

    if (start.classList.contains("start")) {
        if (keysArray.length === 0) {
            alert("Please enter at least one Gemini API key first!");
            return;
        }

        start.disabled = true;
        start.innerText = "Connecting...";

        try {
            const res = await fetch("http://localhost:3000/start", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ apiKeys: keysArray, settings: getSettingsFromForm() })
            });

            if (!res.ok) {
                const text = await res.text();
                alert(`Failed to start server automation: ${text}`);
                start.disabled = false;
                start.innerText = "Start Automation";
                return;
            }

            start.classList.replace("start", "stop");
            start.innerText = "Stop Automation";
            start.disabled = false;
        } catch (err) {
            alert(`Error connecting to local server (http://localhost:3000). Is 'npm start' running?\n\nDetails: ${err.message}`);
            start.disabled = false;
            start.innerText = "Start Automation";
        }

    } else {
        start.disabled = true;
        start.innerText = "Stopping...";

        try {
            await fetch("http://localhost:3000/stop", {
                method: "GET",
                headers: {
                    "Content-Type": "application/json"
                }
            });
        } catch (err) {}

        start.classList.replace("stop", "start");
        start.innerText = "Start Automation";
        start.disabled = false;
    }
};


// Poll for status
const statusIndicator = document.getElementById("statusIndicator");
setInterval(async () => {
    try {
        const res = await fetch("http://localhost:3000/status");
        const data = await res.json();
        
        statusIndicator.innerText = `Status: ${data.status.text}`;
        statusIndicator.className = `status-${data.status.level}`;
        
        // Sync button state if needed (e.g. if server stopped externally)
        if (!data.running && start.classList.contains("stop")) {
            start.classList.replace("stop", "start");
            start.innerText = "Start Automation";
        } else if (data.running && start.classList.contains("start")) {
            start.classList.replace("start", "stop");
            start.innerText = "Stop Automation";
        }
    } catch (e) {
        statusIndicator.innerText = "Status: Server Offline";
        statusIndicator.className = "status-warn";
    }
}, 1000);

let currentBookworkMemory = {};
let openBookworkCode = null;

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function normaliseBookwork(value, code) {
    if (typeof value === "string") {
        return { code, answer: value, working: "", info: "" };
    }
    return {
        code: value.code || code,
        answer: value.answer || "",
        working: value.working || "",
        info: value.info || "",
        savedAt: value.savedAt || ""
    };
}

function mathMarkup(value) {
    const text = escapeHtml(value);
    if (text.includes("$") || text.includes("\\(") || text.includes("\\[")) return text;
    if (/\\(frac|sqrt|times|cdot|pm|leq|geq|text)\b/.test(text)) return `$${text}$`;
    if (/=/.test(text) && !/^Check:/i.test(text)) return `$${text}$`;
    return text;
}

function renderKatex(root) {
    if (!window.renderMathInElement) return;
    try {
        window.renderMathInElement(root, {
            delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '$', right: '$', display: false },
                { left: '\\(', right: '\\)', display: false },
                { left: '\\[', right: '\\]', display: true }
            ],
            throwOnError: false
        });
    } catch (e) {
        console.error("KaTeX rendering error:", e);
    }
}

async function syncBookworks() {
    try {
        await fetch("http://localhost:3000/bookwork", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bookworks: Object.values(currentBookworkMemory) })
        });
    } catch (e) {}
}

function renderBookworkUI(bookworkMap) {
    currentBookworkMemory = Object.fromEntries(
        Object.entries(bookworkMap).map(([code, value]) => [code, normaliseBookwork(value, code)])
    );
    const bwDiv = document.getElementById("bookwork");
    const entries = Object.entries(currentBookworkMemory);
    if (entries.length === 0) {
        bwDiv.innerHTML = "No bookwork detected yet.";
        return;
    }

    bwDiv.innerHTML = entries.map(([code, entry]) => {
        const isOpen = code === openBookworkCode;
        const steps = entry.working.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const savedLabel = entry.savedAt ? new Date(entry.savedAt).toLocaleString() : "Time not recorded";
        return `
            <article class="bw-item ${isOpen ? "is-open" : ""}" data-code="${escapeHtml(code)}">
                <div class="bw-heading">
                    <strong>Code ${escapeHtml(code)}</strong>
                    <button class="clear-single-bw danger-button" data-code="${escapeHtml(code)}">Delete</button>
                </div>
                <div class="bw-answer">${mathMarkup(entry.answer)}</div>
                <small>Saved ${escapeHtml(savedLabel)}</small>
                ${isOpen ? `
                    <div class="bw-working">
                        <strong>Working</strong>
                        ${steps.length ? steps.map(step => `<div class="working-step">${mathMarkup(step)}</div>`).join("") : "<div class=\"working-step\">Working was not captured for this older entry.</div>"}
                    </div>
                    <textarea class="bw-info" data-code="${escapeHtml(code)}" placeholder="Add a note or extra information...">${escapeHtml(entry.info)}</textarea>
                    <div class="bw-controls">
                        <button class="save-info" data-code="${escapeHtml(code)}">Save info</button>
                        <button class="close-info secondary-button" data-code="${escapeHtml(code)}">Close</button>
                    </div>
                ` : "<small>Click to view working and add notes</small>"}
            </article>
        `;
    }).join("");

    renderKatex(bwDiv);

    bwDiv.querySelectorAll(".bw-item").forEach(item => {
        item.onclick = event => {
            if (event.target.closest("button, textarea")) return;
            openBookworkCode = item.dataset.code;
            renderBookworkUI(currentBookworkMemory);
        };
    });
    bwDiv.querySelectorAll(".clear-single-bw").forEach(btn => {
        btn.onclick = async event => {
            event.stopPropagation();
            const code = event.currentTarget.dataset.code;
            delete currentBookworkMemory[code];
            const stored = await chrome.storage.local.get(["deletedBookworks"]);
            const deletedSet = stored.deletedBookworks || {};
            deletedSet[code] = true;
            await chrome.storage.local.set({ bookworkMemory: currentBookworkMemory, deletedBookworks: deletedSet });
            try { await fetch(`http://localhost:3000/bookwork/${encodeURIComponent(code)}`, { method: "DELETE" }); } catch (e) {}
            openBookworkCode = null;
            renderBookworkUI(currentBookworkMemory);
        };
    });
    bwDiv.querySelectorAll(".save-info").forEach(btn => {
        btn.onclick = async event => {
            event.stopPropagation();
            const code = event.currentTarget.dataset.code;
            currentBookworkMemory[code].info = bwDiv.querySelector(`.bw-info[data-code="${CSS.escape(code)}"]`).value;
            await chrome.storage.local.set({ bookworkMemory: currentBookworkMemory });
            await syncBookworks();
            renderBookworkUI(currentBookworkMemory);
        };
    });
    bwDiv.querySelectorAll(".close-info").forEach(btn => {
        btn.onclick = event => {
            event.stopPropagation();
            openBookworkCode = null;
            renderBookworkUI(currentBookworkMemory);
        };
    });
}

async function openServerExport(format) {
    await syncBookworks();
    await chrome.tabs.create({
        url: `http://localhost:3000/bookwork/export/${format}`
    });
}

document.getElementById("exportMarkdown").onclick = async () => {
    try {
        await openServerExport("markdown");
    } catch (error) {
        console.error("Markdown export failed:", error);
        alert("Could not open the Markdown export. Make sure the local server is running.");
    }
};

document.getElementById("exportHtml").onclick = async () => {
    try {
        await openServerExport("html");
    } catch (error) {
        console.error("HTML export failed:", error);
        alert("Could not open the HTML export. Make sure the local server is running.");
    }
};

document.getElementById("clearAllBw").onclick = async () => {
    const allCodes = Object.keys(currentBookworkMemory);
    const deletedSet = Object.fromEntries(allCodes.map(code => [code, true]));
    currentBookworkMemory = {};
    await chrome.storage.local.set({ bookworkMemory: {}, deletedBookworks: deletedSet });
    try { await fetch("http://localhost:3000/bookwork", { method: "DELETE" }); } catch (e) {}
    renderBookworkUI({});
};

setInterval(async () => {
    try {
        const res = await fetch("http://localhost:3000/bookwork");
        const data = await res.json();
        if (!data.bookworks) return;
        chrome.storage.local.get(["bookworkMemory", "deletedBookworks"], storedData => {
            const existing = Object.fromEntries(Object.entries(storedData.bookworkMemory || {}).map(([code, value]) => [code, normaliseBookwork(value, code)]));
            const deletedSet = storedData.deletedBookworks || {};
            let updated = false;
            data.bookworks.forEach(serverEntry => {
                if (deletedSet[serverEntry.code]) return;
                const next = normaliseBookwork(serverEntry, serverEntry.code);
                if (JSON.stringify(existing[serverEntry.code]) !== JSON.stringify(next)) {
                    existing[serverEntry.code] = next;
                    updated = true;
                }
            });
            if (updated) {
                chrome.storage.local.set({ bookworkMemory: existing });
                renderBookworkUI(existing);
            }
        });
    } catch (e) {}
}, 2000);

async function loadBookworkMemory() {
    const storedData = await chrome.storage.local.get(["bookworkMemory", "deletedBookworks"]);
    const localMemory = Object.fromEntries(
        Object.entries(storedData.bookworkMemory || {}).map(([code, value]) => [code, normaliseBookwork(value, code)])
    );
    const deletedSet = storedData.deletedBookworks || {};

    try {
        const response = await fetch("http://localhost:3000/bookwork");
        if (response.ok) {
            const data = await response.json();
            (data.bookworks || []).forEach(entry => {
                if (!deletedSet[entry.code]) localMemory[entry.code] = normaliseBookwork(entry, entry.code);
            });
        }
    } catch (e) {}

    currentBookworkMemory = localMemory;
    await chrome.storage.local.set({ bookworkMemory: currentBookworkMemory });
    renderBookworkUI(currentBookworkMemory);
    await syncBookworks();
}

loadBookworkMemory();





