import { toolDeclarations, systemInstruction, fallbackModels } from './engineCore';

(function() {
    if ((window as any).SparxEngineInjected) return;
    (window as any).SparxEngineInjected = true;

    console.log('[SparxEngine] Shared Engine Bridge active.');

    let automationRunning = false;
    let currentApiKeys: string[] = [];
    let currentKeyIndex = 0;
    let currentModelIndex = 0;
    type MobileBookwork = { code: string; answer: string; working: string; info: string; savedAt: string };
    let bookworks: MobileBookwork[] = [];
    let previousMemory = "";
    let currentCalculation: { working: string; answer: string } | null = null;
    let agentSettings = {
        minDelaySeconds: 2,
        maxDelaySeconds: 20,
        requestTimeoutSeconds: 45,
        retryDelaySeconds: 2,
        maxRequestAttempts: 3
    };

    function notifyBookworks() {
        notifyFlutter('bookwork_sync', { bookworks });
    }

    function waitForHumanDelay() {
        const min = Math.max(0, Math.min(agentSettings.minDelaySeconds, agentSettings.maxDelaySeconds));
        const max = Math.max(min, agentSettings.maxDelaySeconds);
        const seconds = Math.floor(Math.random() * (max - min + 1)) + min;
        notifyFlutter('status', { text: `Thinking time: ${seconds}s`, level: 'info' });
        return new Promise<void>(resolve => {
            let remaining = seconds;
            const tick = () => {
                if (!automationRunning || remaining <= 0) {
                    resolve();
                    return;
                }
                notifyFlutter('status', { text: `Thinking time: ${remaining}s`, level: 'info' });
                remaining -= 1;
                setTimeout(tick, 1000);
            };
            tick();
        });
    }

    function notifyFlutter(type: string, payload: any) {
        if ((window as any).flutter_inappwebview && (window as any).flutter_inappwebview.callHandler) {
            (window as any).flutter_inappwebview.callHandler('SparxBridge', { type: type, payload: payload });
        }
    }

    // Intercept console logs -> Stream live to Flutter UI
    const _origLog = console.log;
    const _origWarn = console.warn;
    const _origError = console.error;

    console.log = function(...args: any[]) {
        _origLog.apply(console, args);
        notifyFlutter('log', { text: `[JS] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`, level: 'info' });
    };
    console.warn = function(...args: any[]) {
        _origWarn.apply(console, args);
        notifyFlutter('log', { text: `[JS WARN] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`, level: 'warn' });
    };
    console.error = function(...args: any[]) {
        _origError.apply(console, args);
        notifyFlutter('log', { text: `[JS ERR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`, level: 'error' });
    };

    function scanAndTagDOM(containerSelector?: string) {
        let root: Element = document.body;
        if (containerSelector) {
            const found = document.querySelector(containerSelector);
            if (found) root = found;
        }

        let idCounter = 1;
        const interactiveElements: any[] = [];
        const clickables = root.querySelectorAll('button, [role="button"], [tabindex="0"], [tabindex="-1"], input, textarea, a, [role="option"], [role="listbox"] *');

        clickables.forEach(node => {
            const id = String(idCounter++);
            node.setAttribute('data-ai-id', id);

            const annotation = node.querySelector('.katex-mathml annotation');
            let text = annotation ? (annotation.textContent || '').trim() : ((node as HTMLElement).innerText || '').trim().replace(/\n/g, ' ');
            const ariaLabel = node.getAttribute('aria-label') || '';
            const tag = node.tagName.toLowerCase();
            const isTextInput = tag === 'input' || tag === 'textarea' || (node as HTMLElement).isContentEditable;

            if (text || ariaLabel || isTextInput) {
                interactiveElements.push({
                    data_ai_id: id,
                    selector: `[data-ai-id="${id}"]`,
                    tag: tag,
                    text: text,
                    ariaLabel: ariaLabel,
                    isTextInput: isTextInput
                });
            }
        });

        return {
            htmlSnippet: root.innerHTML.substring(0, 10000),
            interactiveElements: interactiveElements
        };
    }

    async function captureCanvasScreenshot(): Promise<string | null> {
        try {
            const canvas = document.createElement('canvas');
            const width = window.innerWidth || document.documentElement.clientWidth || 800;
            const height = window.innerHeight || document.documentElement.clientHeight || 600;
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;

            ctx.fillStyle = '#0F0F1A';
            ctx.fillRect(0, 0, width, height);

            ctx.fillStyle = '#FFFFFF';
            ctx.font = '14px sans-serif';
            const bodyText = document.body.innerText || '';
            const lines = bodyText.split('\n').filter(l => l.trim().length > 0).slice(0, 30);
            let y = 30;
            lines.forEach(line => {
                ctx.fillText(line.substring(0, 80), 20, y);
                y += 20;
            });

            return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
        } catch (e) {
            return null;
        }
    }

    function normalise(s: string) {
        return s
            .replace(/\s+/g, '')
            .replace(/[\u2212\u2013\u2014\u2015\u2796\u2010\u2011]/g, '-')
            .replace(/^\{/, '').replace(/\}$/, '')
            .replace(/\\frac\{(\d+)\}\{(\d+)\}/g, '$1/$2');
    }

    function triggerFullClick(el: HTMLElement) {
        el.focus();

        // Dispatch Touch Events for Mobile WebViews
        try {
            const touch = new Touch({
                identifier: Date.now(),
                target: el,
                clientX: 0,
                clientY: 0
            });
            ['touchstart', 'touchend'].forEach(type => {
                el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
            });
        } catch (e) {}

        // Dispatch Mouse Events
        ['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click'].forEach(type => {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        });

        // Fall back to native element method call
        if (typeof el.click === 'function') {
            try { el.click(); } catch (e) {}
        }
    }

    function executeClick(selector: string) {
        let el = document.querySelector(selector) as HTMLElement | null;
        if (!el) {
            // Attempt text-based fallback matching for 'Answer', 'Submit', 'Continue'
            const textMatch = Array.from(document.querySelectorAll('button, [role="button"], a')).find(node => {
                const txt = ((node as HTMLElement).innerText || '').trim().toLowerCase();
                return txt === 'answer' || txt === 'submit' || txt === 'continue' || txt === 'check';
            });
            if (textMatch) el = textMatch as HTMLElement;
        }

        if (!el) return { error: `Selector ${selector} not found.` };

        // If target is inside a button wrapper, trigger both child and closest button parent
        const btnParent = el.closest('button, [role="button"]') as HTMLElement | null;
        triggerFullClick(el);
        if (btnParent && btnParent !== el) {
            triggerFullClick(btnParent);
        }

        return { status: 'Clicked successfully.' };
    }

    async function executeFill(selector: string, value: string) {
        const val = String(value).trim();
        if (selector.includes('__new_')) {
            return {
                error: 'Invalid selector: __new_ IDs point to keypad buttons, not answer slots. Call get_screenshot_and_html first for numeric data-ai-id.'
            };
        }

        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el) return { error: `Selector ${selector} not found.` };

        const tag = el.tagName.toLowerCase();
        const isEditable = tag === 'input' || tag === 'textarea' || el.isContentEditable;

        if (isEditable) {
            const active = document.activeElement as HTMLElement | null;
            if (active && active !== el) active.blur();
            await new Promise(r => setTimeout(r, 100));

            triggerFullClick(el);
            await new Promise(r => setTimeout(r, 200));

            const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            const tracker = (el as any)._valueTracker;
            if (tracker) tracker.setValue('');

            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) {
                setter.call(el, val);
            } else {
                (el as any).value = val;
            }

            for (let i = 0; i < val.length; i++) {
                triggerKeyEvents(el, val[i]);
            }

            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            await new Promise(r => setTimeout(r, 200));
            el.dispatchEvent(new Event('blur', { bubbles: true }));

            return { status: `Typed "${val}" directly into editable field.` };
        } else {
            // Step 2: Click slot to open keypad or drawer
            triggerFullClick(el);
            await new Promise(r => setTimeout(r, 600));

            // Step 3: Check if focused element is typeable
            const active = document.activeElement as HTMLElement | null;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
                const activeTag = active.tagName.toLowerCase();
                const proto = activeTag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
                const tracker = (active as any)._valueTracker;
                if (tracker) tracker.setValue('');
                
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) {
                    setter.call(active, val);
                } else {
                    (active as any).value = val;
                }

                for (let i = 0; i < val.length; i++) {
                    triggerKeyEvents(active, val[i]);
                }

                active.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                active.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                await new Promise(r => setTimeout(r, 200));
                active.dispatchEvent(new Event('blur', { bubbles: true }));

                return { status: `Typed "${val}" into focused active element after slot click.` };
            }

            // Step 4: Scan for keypad tiles / buttons (including Clear/Delete/Backspace)
            const candidates = Array.from(document.querySelectorAll('button, [role="button"], [tabindex="0"], [tabindex="-1"]'));
            let idCounter = Date.now();
            const tiles = candidates.map(node => {
                const annotation = node.querySelector('.katex-mathml annotation');
                let text = annotation ? (annotation.textContent || '').trim() : ((node as HTMLElement).innerText || '').trim().replace(/\s+/g, '');
                let existingId = node.getAttribute('data-ai-id');
                const id = existingId || `__t_${idCounter++}`;
                if (!existingId) node.setAttribute('data-ai-id', id);
                return { el: node as HTMLElement, text: text, selector: `[data-ai-id="${id}"]` };
            }).filter(t => t.text.length > 0);

            // If a Clear/Delete/Backspace button exists on the open keypad, click it to avoid appending extra digits
            const clearTile = tiles.find(t => {
                const txt = t.text.toLowerCase();
                return txt === 'clear' || txt === 'delete' || txt === 'backspace' || txt === 'c' || txt === '⌫' || txt === 'del';
            });
            if (clearTile) {
                triggerFullClick(clearTile.el);
                await new Promise(r => setTimeout(r, 150));
            }

            const normVal = normalise(val);
            const exact = tiles.find(t => normalise(t.text) === normVal);

            if (exact) {
                triggerFullClick(exact.el);
                return { status: `Filled "${val}" by clicking tile "${exact.text}".` };
            }

            // Step 5: Try character-by-character tile clicks
            let allMatched = true;
            for (const char of val.split('')) {
                const normChar = normalise(char);
                const charTile = tiles.find(t => normalise(t.text) === normChar);
                if (charTile) {
                    triggerFullClick(charTile.el);
                    await new Promise(r => setTimeout(r, 200));
                } else {
                    allMatched = false;
                }
            }

            if (allMatched) {
                return { status: `Filled "${val}" character-by-character using keypad buttons.` };
            }

            // Step 6: ID-based click fallback (LaTeX stripping)
            const stripLatex = (s: string) => s
                .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '$1/$2')
                .replace(/\\sqrt\{([^}]+)\}/g, 'sqrt($1)')
                .replace(/\\left|\\right|\\cdot|\\times/g, '')
                .replace(/[{}\\]/g, '')
                .replace(/\s+/g, '');

            const normValStripped = stripLatex(normVal);
            const idMatch = tiles.find(t => normalise(t.text) === normVal) ||
                            tiles.find(t => stripLatex(normalise(t.text)) === normValStripped) ||
                            tiles.find(t => stripLatex(normalise(t.text)).includes(normValStripped) && normValStripped.length > 1);

            if (idMatch) {
                triggerFullClick(idMatch.el);
                return { status: `Filled "${val}" by ID-based tile click.` };
            }

            return { error: `Could not find input element or matching keypad buttons for "${val}".` };
        }
    }

    async function callGeminiAPI(apiKey: string, modelName: string, contents: any[]) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), agentSettings.requestTimeoutSeconds * 1000);
        const requestBody = {
            contents: contents,
            tools: [{ functionDeclarations: toolDeclarations }],
            systemInstruction: { parts: [{ text: systemInstruction }] }
        };

        let res: Response;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
        let contents: any[] = [];
        let promptText = "Start task. Call get_screenshot_and_html first. Determine if BOOKWORK CHECK or NORMAL QUESTION.";
        if (previousMemory) promptText += `\n\nMEMORY: ${previousMemory}`;

        let currentPrompt: any[] = [{ text: promptText }];
        let isDone = false;
        currentCalculation = null;

        while (automationRunning && !isDone) {
            contents.push({ role: 'user', parts: currentPrompt });

            let response: any = null;
            let success = false;

            let requestAttempts = 0;
            while (automationRunning && !success) {
                const apiKey = currentApiKeys[currentKeyIndex];
                const model = fallbackModels[currentModelIndex];

                try {
                    requestAttempts += 1;
                    notifyFlutter('log', { text: `Querying ${model} (Key ${currentKeyIndex + 1}/${currentApiKeys.length})...`, level: 'info' });
                    response = await callGeminiAPI(apiKey, model, contents);
                    success = true;
                } catch (err: any) {
                    notifyFlutter('log', { text: `Key/Model Error (${err.message}). Cycling key/model...`, level: 'warn' });
                    if (requestAttempts >= agentSettings.maxRequestAttempts) {
                        requestAttempts = 0;
                        currentKeyIndex = (currentKeyIndex + 1) % currentApiKeys.length;
                        if (currentKeyIndex === 0) currentModelIndex = (currentModelIndex + 1) % fallbackModels.length;
                    }
                    await new Promise(r => setTimeout(r, agentSettings.retryDelaySeconds * 1000));
                }
            }

            if (!automationRunning) break;

            const candidate = response?.candidates?.[0];
            if (candidate?.content) {
                contents.push(candidate.content);
            }

            const funcCalls = candidate?.content?.parts?.filter((p: any) => p.functionCall).map((p: any) => p.functionCall);

            if (!funcCalls || funcCalls.length === 0) {
                currentPrompt = [{ text: "Please call a tool or task_done." }];
                continue;
            }

            const call = funcCalls[0];
            notifyFlutter('log', { text: `🤖 AI Tool: ${call.name}(${JSON.stringify(call.args)})`, level: 'action' });

            let resultData: any = {};

            if (call.name === 'get_screenshot_and_html') {
                resultData = scanAndTagDOM(call.args?.selector);
            } else if (call.name === 'playwright_click') {
                resultData = executeClick(call.args.selector);
            } else if (call.name === 'playwright_fill') {
                resultData = await executeFill(call.args.selector, call.args.value);
            } else if (call.name === 'playwright_evaluate') {
                try {
                    const evalRes = eval(call.args.script);
                    resultData = { result: String(evalRes) };
                } catch (e: any) {
                    resultData = { error: e.message };
                }
            } else if (call.name === 'calculate_answer') {
                currentCalculation = {
                    working: String(call.args.step_by_step_working || ''),
                    answer: String(call.args.final_answer || '')
                };
                await waitForHumanDelay();
                resultData = { status: `Working saved: ${call.args.final_answer}` };
            } else if (call.name === 'get_bookwork_answer') {
                const code = String(call.args.bookwork_code || '').trim().toLowerCase();
                const match = bookworks.find(b => b.code.toLowerCase() === code);
                if (match) {
                    resultData = { found: true, bookwork_code: match.code, answer: match.answer };
                } else {
                    resultData = { found: false, message: `No saved answer for code "${code}".` };
                }
            } else if (call.name === 'task_done') {
                if (call.args.bookwork_code && call.args.answer) {
                    const code = String(call.args.bookwork_code).trim();
                    const entry: MobileBookwork = {
                        code,
                        answer: String(call.args.answer),
                        working: currentCalculation?.working || '',
                        info: '',
                        savedAt: new Date().toISOString()
                    };
                    const existingIndex = bookworks.findIndex(item => item.code.toLowerCase() === code.toLowerCase());
                    if (existingIndex >= 0) bookworks[existingIndex] = { ...bookworks[existingIndex], ...entry };
                    else bookworks.push(entry);
                    notifyFlutter('bookwork_add', entry);
                    notifyBookworks();
                }
                previousMemory = call.args.memory_for_next_part || "";
                isDone = true;
                notifyFlutter('log', { text: `✓ Question Finished: ${call.args.message || 'Done'}`, level: 'success' });
                resultData = { status: 'Task complete.' };
            }

            currentPrompt = [{
                functionResponse: {
                    name: call.name,
                    response: { output: resultData }
                }
            }];

            await new Promise(r => setTimeout(r, 1000));
        }
    }

    (window as any).SparxEngine = {
        startAutomation: async function(apiKeys: string[], settings?: Partial<typeof agentSettings>) {
            if (automationRunning) return;
            automationRunning = true;
            currentApiKeys = apiKeys;
            agentSettings = { ...agentSettings, ...(settings || {}) };
            currentKeyIndex = 0;
            currentModelIndex = 0;
            notifyFlutter('log', { text: 'Starting Sparx AI Agent loop...', level: 'success' });

            while (automationRunning) {
                await runAgentLoop();
                await new Promise(r => setTimeout(r, 2000));
            }
        },

        stopAutomation: function() {
            automationRunning = false;
            notifyFlutter('log', { text: 'Automation stopped.', level: 'warn' });
        },

        getBookworks: function() {
            notifyBookworks();
            return bookworks;
        },

        setBookworks: function(entries: MobileBookwork[]) {
            if (Array.isArray(entries)) {
                bookworks = entries.map(entry => ({
                    code: String(entry.code || '').trim(),
                    answer: String(entry.answer || ''),
                    working: String(entry.working || ''),
                    info: String(entry.info || ''),
                    savedAt: String(entry.savedAt || '')
                })).filter(entry => entry.code.length > 0);
            }
            notifyBookworks();
        },

        deleteBookwork: function(code: string) {
            bookworks = bookworks.filter(item => item.code.toLowerCase() !== String(code).trim().toLowerCase());
            notifyBookworks();
        },

        clearBookworks: function() {
            bookworks = [];
            notifyBookworks();
        },

        updateBookworkInfo: function(code: string, info: string) {
            const entry = bookworks.find(item => item.code.toLowerCase() === String(code).trim().toLowerCase());
            if (entry) entry.info = String(info || '');
            notifyBookworks();
        }
    };
})();
