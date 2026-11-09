/* Prompt Lines 1.1.4. Original textareas and host parsing stay intact. */
(() => {
    'use strict';
    const API_VERSION = '1.1.4';
    // Match Python's Unicode whitespace, excluding LF (the physical line separator).
    const SPACE = '[\\t \\r\\f\\v\\u001c-\\u001f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
    const blank = text => new RegExp(`^(?:${SPACE}|\\n)*$`).test(text);
    function syntaxOf(config = '//') {
        const raw = typeof config === 'string' ? {marker: config} : (config || {});
        const marker = ['//', '#'].includes(raw.marker) ? raw.marker : null;
        return {
            marker,
            markers: marker ? (raw.markers || (marker === '//' ? ['//', '#'] : ['#'])) : [],
            inline: raw.inline !== false,
            block: raw.block || (marker === '//' ? 'any' : 'none'),
            dangling: !!raw.dangling,
            trimBefore: raw.trimBefore === undefined ? marker === '//' : !!raw.trimBefore,
            newlineReplacement: !!raw.newlineReplacement
        };
    }
    function commentRanges(value, config = '//') {
        const syntax = syntaxOf(config);
        const hidden = Array(value.length).fill(false);
        const blockHidden = Array(value.length).fill(false);
        let units = value.split('').map((char, source) => ({char, source}));
        if (!syntax.marker) return {hidden, blockHidden, effective: value};
        function remove(pattern, replacement = '', block = false) {
            const current = units.map(unit => unit.char).join('');
            const next = [];
            let previous = 0;
            for (const match of current.matchAll(pattern)) {
                const start = match.index;
                const end = start + match[0].length;
                for (let i = previous; i < start; i++) next.push(units[i]);
                for (const unit of units.slice(start, end)) {
                    if (unit.source !== null) {
                        hidden[unit.source] = true;
                        if (block) blockHidden[unit.source] = true;
                    }
                }
                for (const char of replacement) next.push({char, source: null});
                previous = end;
            }
            for (let i = previous; i < units.length; i++) next.push(units[i]);
            units = next;
        }
        // Core removes recognized block comments BEFORE looking for line comments.
        if (syntax.block === 'any') remove(/\/\*[\s\S]*?\*\//g, '', true);
        else if (syntax.block === 'line') remove(/(?:^|(?<=\n))\/\*[\s\S]*?\*\/(?:\n|$)/g, '\n', true);
        const markerPattern = syntax.markers.map(marker => marker === '//' ? '\\/\\/' : '#').join('|');
        const prefix = syntax.inline ? '' : '(?:^|(?<=\\n))';
        const spaces = syntax.trimBefore || !syntax.inline ? `${SPACE}*` : '';
        const ending = syntax.newlineReplacement ? '[^\\n]*(?:\\n|$)' : '[^\\n]*';
        remove(new RegExp(`${prefix}${spaces}(?:${markerPattern})${ending}`, 'g'), syntax.newlineReplacement ? '\n' : '');
        if (syntax.dangling) remove(/(?:\/\*|\*\/)[^\n]*(?:\n|$)/g, '\n', true);
        return {hidden, blockHidden, effective: units.map(unit => unit.char).join('')};
    }
    function linesOf(value, config = '//') {
        const syntax = syntaxOf(config);
        const ranges = commentRanges(value, syntax);
        let offset = 0;
        let inBlock = false;
        return value.split('\n').map((text, index) => {
            const start = offset;
            offset += text.length + 1;
            // Also protect incomplete block boundaries while the user is editing.
            let blocked = inBlock || ranges.blockHidden.slice(start, start + text.length).some(Boolean);
            for (let i = 0; i < text.length; i++) {
                const pair = text.slice(i, i + 2);
                if (inBlock) {
                    if (pair === '*/') { inBlock = false; blocked = true; i++; }
                } else if (pair === '/*') {
                    inBlock = true; blocked = true; i++;
                } else if (pair === '*/') {
                    blocked = true; i++;
                } else if (syntax.markers.some(marker => text.startsWith(marker, i))) {
                    break;
                }
            }
            const markerPattern = syntax.markers.map(marker => marker === '//' ? '\\/\\/' : '#').join('|');
            const match = markerPattern ? new RegExp(`^(${SPACE}*)(${markerPattern})`).exec(text) : null;
            const parts = [];
            let active = '';
            for (let i = 0; i < text.length; i++) {
                const commented = ranges.hidden[start + i];
                const last = parts[parts.length - 1];
                if (last && last.commented === commented) last.text += text[i];
                else parts.push({text: text[i], commented});
                if (!commented) active += text[i];
            }
            return {text, index, start, blocked, parts, active,
                empty: blank(text), off: !blank(text) && blank(active),
                comment: match ? {at: start + match[1].length, marker: match[2]} : null};
        });
    }
    function editForRow(line, syntax) {
        if (!line || line.empty || line.blocked || !syntax.marker) return null;
        if (line.comment) {
            return {start: line.comment.at, end: line.comment.at + line.comment.marker.length, text: ''};
        }
        const indent = new RegExp(`^${SPACE}*`).exec(line.text)[0].length;
        return {start: line.start + indent, end: line.start + indent, text: syntax.marker};
    }
    function editFor(value, index, config = '//') {
        const syntax = syntaxOf(config);
        return editForRow(linesOf(value, syntax)[index], syntax);
    }
    function mapPosition(position, edit) {
        if (position < edit.start) return position;
        if (position >= edit.end) return position + edit.text.length - (edit.end - edit.start);
        return edit.start + edit.text.length;
    }
    function isCommented(row, config = '//') {
        return !!syntaxOf(config).marker && row.off;
    }
    function editsForMode(value, config, mode) {
        const syntax = syntaxOf(config);
        return linesOf(value, syntax).flatMap(row => {
            if (row.empty || row.blocked) return [];
            const off = isCommented(row, syntax);
            if ((mode === 'enable' && !off) || (mode === 'disable' && off)) return [];
            const edit = editForRow(row, syntax);
            return edit ? [edit] : [];
        });
    }
    function applyTextEdits(value, edits) {
        return [...edits].sort((a, b) => b.start - a.start).reduce(
            (text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), value);
    }
    function mapEdits(position, edits) {
        return [...edits].sort((a, b) => b.start - a.start).reduce(mapPosition, position);
    }
    // Pure functions are exported only to the Node test runner, never as WebUI globals.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {linesOf, editFor, mapPosition, isCommented, editsForMode, applyTextEdits, mapEdits, syntaxOf, commentRanges};
        return;
    }
    if (window.__promptLinesLoaded) return;
    window.__promptLinesLoaded = API_VERSION;
    const SELECTORS = [
        '#txt2img_prompt', '#txt2img_neg_prompt', '#img2img_prompt', '#img2img_neg_prompt',
        '#txt2img_hr_prompt', '#txt2img_hr_negative_prompt', '#txt2img_hr_neg_prompt'
    ];
    const controllers = new Map();
    const root = () => typeof gradioApp === 'function' ? gradioApp() : document;
    function capability() {
        const nodes = root().querySelectorAll('[data-plc-capability]');
        let data;
        for (const node of nodes) {
            try { data = JSON.parse(node.dataset.plcCapability); } catch (_) { continue; }
            if (data && ['//', '#'].includes(data.marker)) break;
        }
        if (typeof opts !== 'undefined' && opts.enable_prompt_comments === false) {
            return {marker: null, reason: 'disabled'};
        }
        return data || {marker: null, reason: 'loading'};
    }
    function makeController(component, ta) {
        const host = ta.parentElement;
        const original = {
            padding: ta.style.paddingLeft, position: host.style.position,
            color: ta.style.getPropertyValue('color'), colorPriority: ta.style.getPropertyPriority('color'),
            caret: ta.style.getPropertyValue('caret-color'), caretPriority: ta.style.getPropertyPriority('caret-color')
        };
        const basePadding = parseFloat(getComputedStyle(ta).paddingLeft) || 0;
        const gutterWidth = 48;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        component.classList.add('plc-component');
        ta.classList.add('plc-input');
        ta.style.paddingLeft = `${basePadding + gutterWidth}px`;
        const make = (tag, cls, text) => {
            const node = document.createElement(tag); node.className = cls;
            if (text) node.textContent = text;
            return node;
        };
        const header = make('div', 'plc-header');
        header.setAttribute('role', 'group');
        header.setAttribute('aria-label', 'Prompt Lines');
        const brand = make('span', 'plc-brand', '//');
        brand.title = 'Prompt Lines';
        brand.setAttribute('aria-hidden', 'true');
        const divider = make('span', 'plc-divider');
        divider.setAttribute('aria-hidden', 'true');
        const actions = make('div', 'plc-actions');
        header.append(brand, divider, actions);
        const gutter = make('div', 'plc-gutter');
        gutter.setAttribute('role', 'group');
        gutter.setAttribute('aria-label', '行の有効／無効。オンは有効、オフはコメントアウト');
        const overlay = make('div', 'plc-overlay');
        overlay.setAttribute('aria-hidden', 'true');
        const highlights = make('div', 'plc-highlights');
        const textLayer = make('div', 'plc-text');
        overlay.append(highlights, textLayer);
        const mirror = make('div', 'plc-mirror');
        mirror.setAttribute('aria-hidden', 'true');
        const status = make('div', 'plc-status');
        status.setAttribute('role', 'status');
        host.append(overlay, gutter, mirror);
        component.prepend(header);
        component.append(status);
        const controls = [];
        let lastValue = null, lastCap = '', lastSyntax = '', lastWidth = -1, lastHeight = -1, lastTheme = '';
        let rows = [], boxes = [], spans = [], visibleSpans = [], composing = false, raf = 0;
        let destroyed = false;
        const listeners = [];
        const listen = (target, name, fn, options) => {
            target.addEventListener(name, fn, options);
            listeners.push(() => target.removeEventListener(name, fn, options));
        };
        function nativeText(visible, foreground) {
            if (visible) {
                if (original.color) ta.style.setProperty('color', original.color, original.colorPriority);
                else ta.style.removeProperty('color');
                if (original.caret) ta.style.setProperty('caret-color', original.caret, original.caretPriority);
                else ta.style.removeProperty('caret-color');
            } else {
                ta.style.setProperty('color', 'transparent', 'important');
                ta.style.setProperty('caret-color', foreground, 'important');
            }
        }
        function themeSignature() {
            return getComputedStyle(component).color + document.documentElement.className +
                (document.body ? document.body.className : '') +
                (window.matchMedia && window.matchMedia('(forced-colors: active)').matches);
        }
        function schedule() {
            if (!raf && !destroyed) raf = requestAnimationFrame(() => { raf = 0; render(); });
        }
        function apply(edits, focusTarget, event) {
            const cap = capability();
            if (composing || !cap.marker || ta.readOnly || ta.disabled || !edits.length) { render(); return; }
            const value = ta.value;
            const expected = applyTextEdits(value, edits);
            const first = Math.min(...edits.map(edit => edit.start));
            const endOfEdit = Math.max(...edits.map(edit => edit.end));
            const replacement = expected.slice(first, endOfEdit + expected.length - value.length);
            const start = ta.selectionStart, end = ta.selectionEnd, direction = ta.selectionDirection;
            const top = ta.scrollTop, left = ta.scrollLeft;
            const keyboard = event.detail === 0 &&
                (document.activeElement === focusTarget || focusTarget.getRootNode().activeElement === focusTarget);
            ta.focus({preventScroll: true});
            ta.setSelectionRange(first, endOfEdit);
            let inputSeen = false;
            const seen = () => { inputSeen = true; };
            ta.addEventListener('input', seen);
            try {
                // A single native editing transaction also keeps bulk actions undoable.
                document.execCommand('insertText', false, replacement);
                if (ta.value === value) ta.setRangeText(replacement, first, endOfEdit, 'preserve');
                if (ta.value !== expected) {
                    lastValue = null; schedule();
                    return; // Never overwrite changes made by a conflicting editor.
                }
                if (!inputSeen) ta.dispatchEvent(new Event('input', {bubbles: true}));
            } finally {
                ta.removeEventListener('input', seen);
            }
            ta.setSelectionRange(mapEdits(start, edits), mapEdits(end, edits), direction);
            ta.scrollTop = top; ta.scrollLeft = left;
            ta.dispatchEvent(new Event('change', {bubbles: true}));
            render();
            if (keyboard) focusTarget.focus({preventScroll: true});
            requestAnimationFrame(() => { ta.scrollTop = top; ta.scrollLeft = left; schedule(); });
        }
        for (const [mode, icon, label] of [['enable', '✓', '全有効'], ['disable', '−', '全無効'], ['invert', '⇄', '反転']]) {
            const button = make('button', 'plc-action');
            button.type = 'button'; button.dataset.mode = mode;
            const glyph = make('span', 'plc-action-icon', icon); glyph.setAttribute('aria-hidden', 'true');
            button.append(glyph, document.createTextNode(label));
            button.title = `${label}（空行・ブロックコメントは変更しません）`;
            button.addEventListener('mousedown', event => event.preventDefault());
            button.addEventListener('click', event => apply(editsForMode(ta.value, capability(), mode), button, event));
            actions.append(button); controls.push(button);
        }
        function render() {
            if (destroyed || !ta.isConnected) return;
            const cap = capability();
            const capKey = JSON.stringify(cap) + composing + ta.disabled + ta.readOnly;
            const changed = ta.value !== lastValue;
            const syntaxKey = JSON.stringify(syntaxOf(cap));
            const syntaxChanged = syntaxKey !== lastSyntax;
            if (changed || syntaxChanged) {
                lastValue = ta.value; lastSyntax = syntaxKey;
                rows = linesOf(ta.value, cap);
                while (boxes.length > rows.length) { boxes.pop().remove(); spans.pop().remove(); visibleSpans.pop().remove(); }
                while (boxes.length < rows.length) {
                    const index = boxes.length;
                    const box = make('input', 'plc-switch');
                    box.type = 'checkbox'; box.setAttribute('role', 'switch');
                    box.dataset.line = String(index + 1);
                    box.addEventListener('mousedown', event => event.preventDefault());
                    box.addEventListener('click', event => {
                        const edit = editFor(ta.value, index, capability());
                        apply(edit ? [edit] : [], box, event);
                    });
                    gutter.append(box); boxes.push(box);
                    spans.push(document.createElement('span'));
                    visibleSpans.push(make('span', 'plc-render-line'));
                }
                mirror.replaceChildren(); textLayer.replaceChildren();
                rows.forEach((row, i) => {
                    spans[i].textContent = row.text || '\u200b';
                    visibleSpans[i].replaceChildren();
                    if (row.parts.length) {
                        row.parts.forEach(part => visibleSpans[i].append(make('span', part.commented ? 'plc-commented' : '', part.text)));
                    } else visibleSpans[i].textContent = '\u200b';
                    mirror.append(spans[i]); textLayer.append(visibleSpans[i]);
                    if (i < rows.length - 1) {
                        mirror.append(document.createTextNode('\n'));
                        textLayer.append(document.createTextNode('\n'));
                    }
                });
            }
            if (changed || syntaxChanged || capKey !== lastCap) {
                lastCap = capKey;
                rows.forEach((row, i) => {
                    const box = boxes[i];
                    const commented = isCommented(row, cap);
                    box.checked = !commented && !row.empty && !row.blocked;
                    box.indeterminate = row.blocked;
                    box.hidden = row.empty;
                    box.disabled = !cap.marker || composing || row.empty || row.blocked || ta.disabled || ta.readOnly;
                    box.setAttribute('aria-label', `${i + 1}行目を有効にする`);
                    box.setAttribute('aria-checked', String(box.checked));
                    box.title = row.blocked ? 'ブロックコメント内・境界の行は保護されています' :
                        row.empty ? '空行' : composing ? '日本語入力の確定後に切り替えできます' :
                        `${i + 1}行目：${commented ? 'オフ（コメントアウト）。クリックで有効化' : 'オン（有効）。クリックでコメントアウト'}`;
                    visibleSpans[i].classList.toggle('plc-commented', commented && !!cap.marker);
                });
                const eligible = rows.filter(row => !row.empty && !row.blocked);
                controls.forEach(button => { button.disabled = !cap.marker || composing || ta.disabled || ta.readOnly || !eligible.length; });
                status.hidden = !!cap.marker;
                status.textContent = cap.reason === 'disabled' ? '設定の「Remove Comments from Prompts」を有効にして、UIを再読込してください。' :
                    cap.reason === 'loading' ? '本体のコメント機能を確認中。表示が変わらない場合はWebUIを再起動してください。' :
                    '対応する本体コメント機能を確認できないため、切替を停止しています。';
            }
            if (!ta.getClientRects().length || ta.clientWidth === 0) return;
            nativeText(true);
            const cs = getComputedStyle(ta);
            const foreground = cs.color;
            component.style.setProperty('--plc-foreground', foreground);
            const rgb = foreground.match(/[\d.]+/g);
            component.dataset.plcTheme = rgb && (+rgb[0] + +rgb[1] + +rgb[2]) / 3 > 150 ? 'dark' : 'light';
            for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
                'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent',
                'fontKerning', 'fontFeatureSettings', 'fontVariationSettings', 'fontStretch',
                'textAlign', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
                'direction', 'wordBreak', 'overflowWrap']) {
                mirror.style[prop] = cs[prop]; textLayer.style[prop] = cs[prop];
            }
            mirror.style.whiteSpace = textLayer.style.whiteSpace = ta.wrap === 'off' ? 'pre' : 'pre-wrap';
            mirror.style.width = textLayer.style.width = `${ta.clientWidth}px`;
            gutter.style.left = `${ta.offsetLeft + ta.clientLeft}px`;
            gutter.style.top = `${ta.offsetTop + ta.clientTop}px`;
            gutter.style.height = `${ta.clientHeight}px`;
            gutter.style.width = `${gutterWidth}px`;
            overlay.style.left = gutter.style.left; overlay.style.top = gutter.style.top;
            overlay.style.width = `${ta.clientWidth}px`; overlay.style.height = `${ta.clientHeight}px`;
            textLayer.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
            lastWidth = ta.clientWidth; lastHeight = ta.clientHeight; lastTheme = themeSignature();
            const mirrorBounds = mirror.getBoundingClientRect();
            const fragments = document.createDocumentFragment();
            const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
            spans.forEach((span, i) => {
                const rects = Array.from(span.getClientRects());
                const rect = rects[0];
                if (!rect) return;
                const y = rect.top - mirrorBounds.top - ta.scrollTop + (rect.height - 18) / 2;
                boxes[i].style.top = `${y}px`;
                boxes[i].style.visibility = y < -9 || y > ta.clientHeight - 9 ? 'hidden' : 'visible';
                if (isCommented(rows[i], cap) && cap.marker) {
                    const first = rect.top - mirrorBounds.top - ta.scrollTop - (lineHeight - rect.height) / 2;
                    const last = rects[rects.length - 1];
                    const height = last.bottom - rect.top + lineHeight - rect.height;
                    if (first + height < 0 || first > ta.clientHeight) return;
                    const highlight = make('i', 'plc-row-muted');
                    highlight.style.top = `${first + 1}px`; highlight.style.height = `${height - 2}px`;
                    fragments.append(highlight);
                }
            });
            highlights.replaceChildren(fragments);
            const forcedColors = window.matchMedia && window.matchMedia('(forced-colors: active)').matches;
            const useOverlay = !composing && !forcedColors;
            overlay.hidden = !useOverlay;
            // Keep the original editor, selection, caret, keyboard and browser undo stack.
            // During composition/high-contrast mode, show native text instead of the paint layer.
            nativeText(!useOverlay, foreground);
        }
        listen(ta, 'input', schedule); listen(ta, 'change', schedule);
        listen(ta, 'scroll', schedule, {passive: true});
        listen(ta, 'compositionstart', () => { composing = true; render(); });
        listen(ta, 'compositionend', () => { composing = false; schedule(); });
        listen(window, 'resize', schedule);
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
        if (observer) observer.observe(ta);
        render();
        return {
            poll() {
                if (ta.value !== lastValue || JSON.stringify(capability()) + composing + ta.disabled + ta.readOnly !== lastCap ||
                    ta.clientWidth !== lastWidth || ta.clientHeight !== lastHeight || themeSignature() !== lastTheme) schedule();
            },
            destroy() {
                destroyed = true; if (raf) cancelAnimationFrame(raf);
                listeners.forEach(fn => fn()); if (observer) observer.disconnect();
                nativeText(true);
                gutter.remove(); mirror.remove(); overlay.remove(); status.remove(); header.remove();
                ta.style.paddingLeft = original.padding; host.style.position = original.position;
                ta.classList.remove('plc-input'); component.classList.remove('plc-component');
                component.style.removeProperty('--plc-foreground'); delete component.dataset.plcTheme;
            }
        };
    }
    function scan() {
        for (const [ta, controller] of controllers) {
            if (!ta.isConnected) { controller.destroy(); controllers.delete(ta); }
            else controller.poll();
        }
        for (const selector of SELECTORS) {
            const component = root().querySelector(selector);
            const ta = component && component.querySelector('textarea');
            if (ta && !controllers.has(ta)) controllers.set(ta, makeController(component, ta));
        }
    }
    if (typeof onUiLoaded === 'function') onUiLoaded(scan);
    if (typeof onUiUpdate === 'function') onUiUpdate(scan);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan, {once: true});
    else scan();
    // Includes external style-paste and Gradio value assignments without synthetic input.
    setInterval(scan, 500);
})();
