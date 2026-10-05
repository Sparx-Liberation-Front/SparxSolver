"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res, err) => function __init() {
    if (err) throw err[0];
    try {
      return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
    } catch (e) {
      throw err = [e], e;
    }
  };
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // src/engineCore.ts
  var toolDeclarations, systemInstruction, fallbackModels;
  var init_engineCore = __esm({
    "src/engineCore.ts"() {
      "use strict";
      toolDeclarations = [
        {
          name: "playwright_click",
          description: "Click an element on the page using a CSS selector.",
          parameters: {
            type: "OBJECT",
            properties: { selector: { type: "STRING", description: "The CSS selector of the element to click." } },
            required: ["selector"]
          }
        },
        {
          name: "playwright_fill",
          description: "Fill an answer slot with a value. The engine will automatically click the slot, then find and click the correct tile or keypad button. Use this for ALL answer slots - numbers, fractions, operators like +, -, etc.",
          parameters: {
            type: "OBJECT",
            properties: {
              selector: { type: "STRING", description: 'The CSS selector of the answer slot (e.g. [data-ai-id="15"]).' },
              value: { type: "STRING", description: 'The value to enter, e.g. "5", "-22", "+", "-", "1/5".' }
            },
            required: ["selector", "value"]
          }
        },
        {
          name: "calculate_answer",
          description: "Use this tool to write out your step-by-step mathematical working, determine the final answer, and estimate a realistic time range in seconds (min and max) that an average human student would take to solve this specific question BEFORE you fill any slots.",
          parameters: {
            type: "OBJECT",
            properties: {
              step_by_step_working: { type: "STRING", description: 'Concise, correct working out with one step per line. Wrap every mathematical expression in $...$ for KaTeX. Include a final line beginning with "Check:" that substitutes the answer back into the original question.' },
              final_answer: { type: "STRING", description: "The final calculated answer." },
              min_human_delay_seconds: { type: "INTEGER", description: "Minimum estimated seconds an average human student would take to solve this question (e.g. 10)." },
              max_human_delay_seconds: { type: "INTEGER", description: "Maximum estimated seconds an average human student would take to solve this question (e.g. 30)." }
            },
            required: ["step_by_step_working", "final_answer", "min_human_delay_seconds", "max_human_delay_seconds"]
          }
        },
        {
          name: "get_bookwork_answer",
          description: "Look up a previously saved answer for a given bookwork code. Call this FIRST on bookwork check screens before looking at tiles.",
          parameters: {
            type: "OBJECT",
            properties: {
              bookwork_code: { type: "STRING", description: 'The bookwork code shown on the page, e.g. "4B" or "12".' }
            },
            required: ["bookwork_code"]
          }
        },
        {
          name: "get_screenshot_and_html",
          description: "Takes a screenshot and gets the interactive elements of the current page. ALWAYS call this first to see the screen and choose selectors.",
          parameters: {
            type: "OBJECT",
            properties: {
              selector: { type: "STRING", description: "Optional CSS selector to scope the HTML." }
            }
          }
        },
        {
          name: "task_done",
          description: "Call this when you have successfully solved the current screen.",
          parameters: {
            type: "OBJECT",
            properties: {
              message: { type: "STRING", description: "A final summary of what was done." },
              memory_for_next_part: { type: "STRING", description: "Important facts or answers to remember for the next part." },
              bookwork_code: { type: "STRING", description: 'The bookwork code (e.g. "34") shown on the page.' },
              answer: { type: "STRING", description: "The final answer you entered for this question." }
            }
          }
        }
      ];
      systemInstruction = [
        "You are a Sparx Maths agent. There are TWO types of screen you will encounter:",
        "-- TYPE 1: BOOKWORK CHECK --",
        "Detected when the page shows a bookwork code (e.g. '4B' or 'Bookwork check') asking 'Which of these answers did you write down for bookwork code 4B?'.",
        "How to handle:",
        "1) Call get_screenshot_and_html to view the screen.",
        "2) Read the bookwork code requested (e.g. '4B' or '12').",
        "3) Call get_bookwork_answer(bookwork_code) to retrieve the saved answer for that code.",
        "4) Compare the retrieved answer against all interactive elements / options on the screen. Match by value, LaTeX expression, or text (e.g. '5', 'x = 2', '1/2', '3.14').",
        "5) Click the button / option matching the saved answer using playwright_click.",
        "6) If a 'Submit' or 'Continue' button appears, click it with playwright_click.",
        "7) Call task_done only after the lookup returned found:true.",
        "IMPORTANT: Do NOT call calculate_answer on bookwork check screens. Always look up and select the stored bookwork answer. Never finish a check with an unverified or missing bookwork record.",
        "-- TYPE 2: NORMAL QUESTION --",
        "Detected when the page shows a new maths question to solve.",
        "GRAPH QUESTIONS: If a graph, chart, coordinate grid, canvas, SVG, or plotted image is visible, inspect the graph crop carefully. Read the axis labels, scale, origin, grid spacing, plotted points, intercepts, and line direction explicitly before calculating. Do not estimate from visual size alone; cross-check coordinates against tick spacing and state the coordinates in your working. If a label or point is unreadable, do not guess: inspect the DOM text or request another screenshot first.",
        "How to handle: 1) Call get_screenshot_and_html. 2) Call calculate_answer with full working AND realistic min/max estimated human solving time in seconds (e.g. min: 12, max: 25). 3) Use playwright_fill and playwright_click to enter the answer and submit it. 4) Call task_done with bookwork_code AND answer.",
        "-- FILLING SLOTS (playwright_fill rules) --",
        "The engine auto-handles clicking tiles or typing. For equations like y=mx+c, there are SEPARATE slots for gradient, sign (+/-), and intercept - fill each independently.",
        "If isTextInput:true appears in interactiveElements, it is a plain text box - call playwright_fill with the value.",
        "CRITICAL: Call playwright_fill EXACTLY ONCE per answer slot! DO NOT call playwright_fill again on a slot that has already been filled - doing so appends duplicate digits onto the existing answer.",
        "CRITICAL: Calling playwright_fill WILL interact with keypad/tiles automatically if the slot opens a virtual keypad. NEVER assume a question is done without filling all required slots!",
        'Use data-ai-id selectors (e.g. [data-ai-id="15"]). WARNING: IDs regenerate on every get_screenshot_and_html call.',
        "-- task_done requirements --",
        "ALWAYS provide a non-empty bookwork_code and answer when finishing a normal question, so the answer is saved for future bookwork checks. If either is missing, inspect the screenshot again and recover it before calling task_done.",
        "FORMATTING: Format mathematical expressions in answer and working using KaTeX / LaTeX syntax, e.g. '$x = 2$', '$\\frac{1}{2}$', '$y = 3x + 5$', '$15.4$'. Keep working compact: one operation per line, no essay paragraphs, and finish with a 'Check:' substitution line."
      ].join("\n");
      fallbackModels = [
        "gemini-3.8-flash",
        "gemini-3.7-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.5-pro"
      ];
    }
  });

  // src/browserBridge.ts
  var require_browserBridge = __commonJS({
    "src/browserBridge.ts"(exports, module) {
      init_engineCore();
      (function() {
        if (window.SparxEngineInjected) return;
        window.SparxEngineInjected = true;
        console.log("[SparxEngine] Shared Engine Bridge active.");
        let automationRunning = false;
        let currentApiKeys = [];
        let currentKeyIndex = 0;
        let currentModelIndex = 0;
        let bookworks = [];
        let previousMemory = "";
        let currentCalculation = null;
        let agentSettings = {
          minDelaySeconds: 2,
          maxDelaySeconds: 20,
          requestTimeoutSeconds: 45,
          retryDelaySeconds: 2,
          maxRequestAttempts: 3
        };
        function notifyBookworks() {
          notifyFlutter("bookwork_sync", { bookworks });
        }
        function waitForHumanDelay() {
          const min = Math.max(0, Math.min(agentSettings.minDelaySeconds, agentSettings.maxDelaySeconds));
          const max = Math.max(min, agentSettings.maxDelaySeconds);
          const seconds = Math.floor(Math.random() * (max - min + 1)) + min;
          notifyFlutter("status", { text: `Thinking time: ${seconds}s`, level: "info" });
          return new Promise((resolve) => {
            let remaining = seconds;
            const tick = () => {
              if (!automationRunning || remaining <= 0) {
                resolve();
                return;
              }
              notifyFlutter("status", { text: `Thinking time: ${remaining}s`, level: "info" });
              remaining -= 1;
              setTimeout(tick, 1e3);
            };
            tick();
          });
        }
        function notifyFlutter(type, payload) {
          if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
            window.flutter_inappwebview.callHandler("SparxBridge", { type, payload });
          }
        }
        const _origLog = console.log;
        const _origWarn = console.warn;
        const _origError = console.error;
        console.log = function(...args) {
          _origLog.apply(console, args);
          notifyFlutter("log", { text: `[JS] ${args.map((a) => typeof a === "object" ? JSON.stringify(a) : a).join(" ")}`, level: "info" });
        };
        console.warn = function(...args) {
          _origWarn.apply(console, args);
          notifyFlutter("log", { text: `[JS WARN] ${args.map((a) => typeof a === "object" ? JSON.stringify(a) : a).join(" ")}`, level: "warn" });
        };
        console.error = function(...args) {
          _origError.apply(console, args);
          notifyFlutter("log", { text: `[JS ERR] ${args.map((a) => typeof a === "object" ? JSON.stringify(a) : a).join(" ")}`, level: "error" });
        };
        function scanAndTagDOM(containerSelector) {
          let root = document.body;
          if (containerSelector) {
            const found = document.querySelector(containerSelector);
            if (found) root = found;
          }
          let idCounter = 1;
          const interactiveElements = [];
          const clickables = root.querySelectorAll('button, [role="button"], [tabindex="0"], [tabindex="-1"], input, textarea, a, [role="option"], [role="listbox"] *');
          clickables.forEach((node) => {
            const id = String(idCounter++);
            node.setAttribute("data-ai-id", id);
            const annotation = node.querySelector(".katex-mathml annotation");
            let text = annotation ? (annotation.textContent || "").trim() : (node.innerText || "").trim().replace(/\n/g, " ");
            const ariaLabel = node.getAttribute("aria-label") || "";
            const tag = node.tagName.toLowerCase();
            const isTextInput = tag === "input" || tag === "textarea" || node.isContentEditable;
            if (text || ariaLabel || isTextInput) {
              interactiveElements.push({
                data_ai_id: id,
                selector: `[data-ai-id="${id}"]`,
                tag,
                text,
                ariaLabel,
                isTextInput
              });
            }
          });
          return {
            htmlSnippet: root.innerHTML.substring(0, 1e4),
            interactiveElements
          };
        }
        async function captureCanvasScreenshot() {
          try {
            const canvas = document.createElement("canvas");
            const width = window.innerWidth || document.documentElement.clientWidth || 800;
            const height = window.innerHeight || document.documentElement.clientHeight || 600;
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            ctx.fillStyle = "#0F0F1A";
            ctx.fillRect(0, 0, width, height);
            ctx.fillStyle = "#FFFFFF";
            ctx.font = "14px sans-serif";
            const bodyText = document.body.innerText || "";
            const lines = bodyText.split("\n").filter((l) => l.trim().length > 0).slice(0, 30);
            let y = 30;
            lines.forEach((line) => {
              ctx.fillText(line.substring(0, 80), 20, y);
              y += 20;
            });
            return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
          } catch (e) {
            return null;
          }
        }
        function normalise(s) {
          return s.replace(/\s+/g, "").replace(/[\u2212\u2013\u2014\u2015\u2796\u2010\u2011]/g, "-").replace(/^\{/, "").replace(/\}$/, "").replace(/\\frac\{(\d+)\}\{(\d+)\}/g, "$1/$2");
        }
        function triggerFullClick(el) {
          el.focus();
          try {
            const touch = new Touch({
              identifier: Date.now(),
              target: el,
              clientX: 0,
              clientY: 0
            });
            ["touchstart", "touchend"].forEach((type) => {
              el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
            });
          } catch (e) {
          }
          ["pointerdown", "mousedown", "focus", "pointerup", "mouseup", "click"].forEach((type) => {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          });
          if (typeof el.click === "function") {
            try {
              el.click();
            } catch (e) {
            }
          }
        }
        function executeClick(selector) {
          let el = document.querySelector(selector);
          if (!el) {
            const textMatch = Array.from(document.querySelectorAll('button, [role="button"], a')).find((node) => {
              const txt = (node.innerText || "").trim().toLowerCase();
              return txt === "answer" || txt === "submit" || txt === "continue" || txt === "check";
            });
            if (textMatch) el = textMatch;
          }
          if (!el) return { error: `Selector ${selector} not found.` };
          const btnParent = el.closest('button, [role="button"]');
          triggerFullClick(el);
          if (btnParent && btnParent !== el) {
            triggerFullClick(btnParent);
          }
          return { status: "Clicked successfully." };
        }
        async function executeFill(selector, value) {
          const val = String(value).trim();
          if (selector.includes("__new_")) {
            return {
              error: "Invalid selector: __new_ IDs point to keypad buttons, not answer slots. Call get_screenshot_and_html first for numeric data-ai-id."
            };
          }
          const el = document.querySelector(selector);
          if (!el) return { error: `Selector ${selector} not found.` };
          const tag = el.tagName.toLowerCase();
          const isEditable = tag === "input" || tag === "textarea" || el.isContentEditable;
          if (isEditable) {
            const active = document.activeElement;
            if (active && active !== el) active.blur();
            await new Promise((r) => setTimeout(r, 100));
            triggerFullClick(el);
            await new Promise((r) => setTimeout(r, 200));
            const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            const tracker = el._valueTracker;
            if (tracker) tracker.setValue("");
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            if (setter) {
              setter.call(el, val);
            } else {
              el.value = val;
            }
            for (let i = 0; i < val.length; i++) {
              triggerKeyEvents(el, val[i]);
            }
            el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
            el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            await new Promise((r) => setTimeout(r, 200));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
            return { status: `Typed "${val}" directly into editable field.` };
          } else {
            triggerFullClick(el);
            await new Promise((r) => setTimeout(r, 600));
            const active = document.activeElement;
            if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
              const activeTag = active.tagName.toLowerCase();
              const proto = activeTag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
              const tracker = active._valueTracker;
              if (tracker) tracker.setValue("");
              const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
              if (setter) {
                setter.call(active, val);
              } else {
                active.value = val;
              }
              for (let i = 0; i < val.length; i++) {
                triggerKeyEvents(active, val[i]);
              }
              active.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
              active.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
              await new Promise((r) => setTimeout(r, 200));
              active.dispatchEvent(new Event("blur", { bubbles: true }));
              return { status: `Typed "${val}" into focused active element after slot click.` };
            }
            const candidates = Array.from(document.querySelectorAll('button, [role="button"], [tabindex="0"], [tabindex="-1"]'));
            let idCounter = Date.now();
            const tiles = candidates.map((node) => {
              const annotation = node.querySelector(".katex-mathml annotation");
              let text = annotation ? (annotation.textContent || "").trim() : (node.innerText || "").trim().replace(/\s+/g, "");
              let existingId = node.getAttribute("data-ai-id");
              const id = existingId || `__t_${idCounter++}`;
              if (!existingId) node.setAttribute("data-ai-id", id);
              return { el: node, text, selector: `[data-ai-id="${id}"]` };
            }).filter((t) => t.text.length > 0);
            const clearTile = tiles.find((t) => {
              const txt = t.text.toLowerCase();
              return txt === "clear" || txt === "delete" || txt === "backspace" || txt === "c" || txt === "\u232B" || txt === "del";
            });
            if (clearTile) {
              triggerFullClick(clearTile.el);
              await new Promise((r) => setTimeout(r, 150));
            }
            const normVal = normalise(val);
            const exact = tiles.find((t) => normalise(t.text) === normVal);
            if (exact) {
              triggerFullClick(exact.el);
              return { status: `Filled "${val}" by clicking tile "${exact.text}".` };
            }
            let allMatched = true;
            for (const char of val.split("")) {
              const normChar = normalise(char);
              const charTile = tiles.find((t) => normalise(t.text) === normChar);
              if (charTile) {
                triggerFullClick(charTile.el);
                await new Promise((r) => setTimeout(r, 200));
              } else {
                allMatched = false;
              }
            }
            if (allMatched) {
              return { status: `Filled "${val}" character-by-character using keypad buttons.` };
            }
            const stripLatex = (s) => s.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "$1/$2").replace(/\\sqrt\{([^}]+)\}/g, "sqrt($1)").replace(/\\left|\\right|\\cdot|\\times/g, "").replace(/[{}\\]/g, "").replace(/\s+/g, "");
            const normValStripped = stripLatex(normVal);
            const idMatch = tiles.find((t) => normalise(t.text) === normVal) || tiles.find((t) => stripLatex(normalise(t.text)) === normValStripped) || tiles.find((t) => stripLatex(normalise(t.text)).includes(normValStripped) && normValStripped.length > 1);
            if (idMatch) {
              triggerFullClick(idMatch.el);
              return { status: `Filled "${val}" by ID-based tile click.` };
            }
            return { error: `Could not find input element or matching keypad buttons for "${val}".` };
          }
        }
        async function callGeminiAPI(apiKey, modelName, contents2) {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), agentSettings.requestTimeoutSeconds * 1e3);
          const requestBody = {
            contents: contents2,
            tools: [{ functionDeclarations: toolDeclarations }],
            systemInstruction: { parts: [{ text: systemInstruction }] }
          };
          let res;
          try {
            res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(requestBody),
              signal: controller.signal
            });
          } finally {
            clearTimeout(timeout);
          }
          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`API ${res.status}: ${errText}`);
          }
          return await res.json();
        }
        async function runAgentLoop() {
          let contents = [];
          let promptText = "Start task. Call get_screenshot_and_html first. Determine if BOOKWORK CHECK or NORMAL QUESTION.";
          if (previousMemory) promptText += `

MEMORY: ${previousMemory}`;
          let currentPrompt = [{ text: promptText }];
          let isDone = false;
          currentCalculation = null;
          while (automationRunning && !isDone) {
            contents.push({ role: "user", parts: currentPrompt });
            let response = null;
            let success = false;
            let requestAttempts = 0;
            while (automationRunning && !success) {
              const apiKey = currentApiKeys[currentKeyIndex];
              const model = fallbackModels[currentModelIndex];
              try {
                requestAttempts += 1;
                notifyFlutter("log", { text: `Querying ${model} (Key ${currentKeyIndex + 1}/${currentApiKeys.length})...`, level: "info" });
                response = await callGeminiAPI(apiKey, model, contents);
                success = true;
              } catch (err) {
                notifyFlutter("log", { text: `Key/Model Error (${err.message}). Cycling key/model...`, level: "warn" });
                if (requestAttempts >= agentSettings.maxRequestAttempts) {
                  requestAttempts = 0;
                  currentKeyIndex = (currentKeyIndex + 1) % currentApiKeys.length;
                  if (currentKeyIndex === 0) currentModelIndex = (currentModelIndex + 1) % fallbackModels.length;
                }
                await new Promise((r) => setTimeout(r, agentSettings.retryDelaySeconds * 1e3));
              }
            }
            if (!automationRunning) break;
            const candidate = response?.candidates?.[0];
            if (candidate?.content) {
              contents.push(candidate.content);
            }
            const funcCalls = candidate?.content?.parts?.filter((p) => p.functionCall).map((p) => p.functionCall);
            if (!funcCalls || funcCalls.length === 0) {
              currentPrompt = [{ text: "Please call a tool or task_done." }];
              continue;
            }
            const call = funcCalls[0];
            notifyFlutter("log", { text: `\u{1F916} AI Tool: ${call.name}(${JSON.stringify(call.args)})`, level: "action" });
            let resultData = {};
            if (call.name === "get_screenshot_and_html") {
              resultData = scanAndTagDOM(call.args?.selector);
            } else if (call.name === "playwright_click") {
              resultData = executeClick(call.args.selector);
            } else if (call.name === "playwright_fill") {
              resultData = await executeFill(call.args.selector, call.args.value);
            } else if (call.name === "playwright_evaluate") {
              try {
                const evalRes = eval(call.args.script);
                resultData = { result: String(evalRes) };
              } catch (e) {
                resultData = { error: e.message };
              }
            } else if (call.name === "calculate_answer") {
              currentCalculation = {
                working: String(call.args.step_by_step_working || ""),
                answer: String(call.args.final_answer || "")
              };
              await waitForHumanDelay();
              resultData = { status: `Working saved: ${call.args.final_answer}` };
            } else if (call.name === "get_bookwork_answer") {
              const code = String(call.args.bookwork_code || "").trim().toLowerCase();
              const match = bookworks.find((b) => b.code.toLowerCase() === code);
              if (match) {
                resultData = { found: true, bookwork_code: match.code, answer: match.answer };
              } else {
                resultData = { found: false, message: `No saved answer for code "${code}".` };
              }
            } else if (call.name === "task_done") {
              if (call.args.bookwork_code && call.args.answer) {
                const code = String(call.args.bookwork_code).trim();
                const entry = {
                  code,
                  answer: String(call.args.answer),
                  working: currentCalculation?.working || "",
                  info: "",
                  savedAt: (/* @__PURE__ */ new Date()).toISOString()
                };
                const existingIndex = bookworks.findIndex((item) => item.code.toLowerCase() === code.toLowerCase());
                if (existingIndex >= 0) bookworks[existingIndex] = { ...bookworks[existingIndex], ...entry };
                else bookworks.push(entry);
                notifyFlutter("bookwork_add", entry);
                notifyBookworks();
              }
              previousMemory = call.args.memory_for_next_part || "";
              isDone = true;
              notifyFlutter("log", { text: `\u2713 Question Finished: ${call.args.message || "Done"}`, level: "success" });
              resultData = { status: "Task complete." };
            }
            currentPrompt = [{
              functionResponse: {
                name: call.name,
                response: { output: resultData }
              }
            }];
            await new Promise((r) => setTimeout(r, 1e3));
          }
        }
        window.SparxEngine = {
          startAutomation: async function(apiKeys, settings) {
            if (automationRunning) return;
            automationRunning = true;
            currentApiKeys = apiKeys;
            agentSettings = { ...agentSettings, ...settings || {} };
            currentKeyIndex = 0;
            currentModelIndex = 0;
            notifyFlutter("log", { text: "Starting Sparx AI Agent loop...", level: "success" });
            while (automationRunning) {
              await runAgentLoop();
              await new Promise((r) => setTimeout(r, 2e3));
            }
          },
          stopAutomation: function() {
            automationRunning = false;
            notifyFlutter("log", { text: "Automation stopped.", level: "warn" });
          },
          getBookworks: function() {
            notifyBookworks();
            return bookworks;
          },
          setBookworks: function(entries) {
            if (Array.isArray(entries)) {
              bookworks = entries.map((entry) => ({
                code: String(entry.code || "").trim(),
                answer: String(entry.answer || ""),
                working: String(entry.working || ""),
                info: String(entry.info || ""),
                savedAt: String(entry.savedAt || "")
              })).filter((entry) => entry.code.length > 0);
            }
            notifyBookworks();
          },
          deleteBookwork: function(code) {
            bookworks = bookworks.filter((item) => item.code.toLowerCase() !== String(code).trim().toLowerCase());
            notifyBookworks();
          },
          clearBookworks: function() {
            bookworks = [];
            notifyBookworks();
          },
          updateBookworkInfo: function(code, info) {
            const entry = bookworks.find((item) => item.code.toLowerCase() === String(code).trim().toLowerCase());
            if (entry) entry.info = String(info || "");
            notifyBookworks();
          }
        };
      })();
    }
  });
  require_browserBridge();
})();
