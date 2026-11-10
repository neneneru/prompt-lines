/* Prompt Lines 1.2.4. Original textareas and host parsing stay intact. */
(() => {
    'use strict';
    const API_VERSION = '1.2.4';
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
    function blockRanges(value) {
        return Array.from(value.matchAll(/\/\*[\s\S]*?\*\//g), match => ({
            start: match.index, end: match.index + match[0].length,
            simple: !match[0].includes('\n') && !match[0].slice(2, -2).includes('/*')
        }));
    }
    function reversibleBlock(value, block, syntax) {
        if (!block.simple) return false;
        const body = value.slice(block.start + 2, block.end - 2);
        const inner = tagTargets(body, syntax, false);
        return inner.length === 1 && !inner[0].off &&
            blank(body.slice(0, inner[0].start)) && blank(body.slice(inner[0].end));
    }
    function tagTargets(value, config = '//', restoreLines = true) {
        const syntax = syntaxOf(config);
        // Inline removal must be confirmed by the host, not inferred from its name.
        if (!syntax.marker || syntax.block !== 'any') return [];
        const ranges = commentRanges(value, syntax);
        const blocks = blockRanges(value);
        const blockAt = new Map(blocks.map(block => [block.start, block]));
        const lastBlockEnd = blocks.length ? blocks[blocks.length - 1].end : 0;
        const unfinished = value.indexOf('/*', lastBlockEnd);
        const targets = [];
        const protectedRows = new Set();
        const stack = [];
        const closing = {'(': ')', '[': ']', '{': '}', '<': '>'};
        let offset = 0;
        value.split('\n').forEach((line, row) => {
            const lineStart = offset;
            const lineEnd = offset + line.length;
            offset = lineEnd + 1;
            // The host finds block markers even after a line comment or backslash.
            // Never introduce a closing marker downstream of an unfinished block.
            let unsafe = stack.length > 0 || (unfinished >= 0 && lineEnd > unfinished);
            for (const match of line.matchAll(/\/\*|\*\//g)) {
                if (!ranges.blockHidden[lineStart + match.index]) unsafe = true;
            }
            let segmentStart = lineStart;
            let activeEnd = lineEnd;
            const segments = [];
            const cuts = [];
            for (let at = lineStart; at < lineEnd; at++) {
                if (ranges.blockHidden[at]) {
                    const block = blockAt.get(at);
                    if (!block || !block.simple) unsafe = true;
                    if (block) at = Math.min(lineEnd, block.end) - 1;
                    continue;
                }
                // Native line comments cannot be re-enabled with a block wrapper.
                if (ranges.hidden[at]) {
                    // Whitespace trimmed before a later marker must not conceal an earlier block target.
                    if (blank(value[at])) continue;
                    activeEnd = at; break;
                }
                const char = value[at];
                if (char === '\\') { at++; continue; }
                if (value.startsWith('/*', at) || value.startsWith('*/', at)) { unsafe = true; break; }
                if (closing[char]) stack.push(closing[char]);
                else if (')]}>'.includes(char)) {
                    if (stack.pop() !== char) unsafe = true;
                } else if (char === ',' && !stack.length) cuts.push(at);
            }
            if (stack.length) unsafe = true;
            for (const at of cuts) {
                segments.push({start: segmentStart, end: at});
                segmentStart = at + 1;
            }
            segments.push({start: segmentStart, end: activeEnd});
            if (unsafe) { protectedRows.add(row); return; }
            for (const segment of segments) {
                let {start, end} = segment;
                while (start < end && blank(value[start])) start++;
                while (end > start && blank(value[end - 1])) end--;
                if (start === end) continue;
                const contained = blocks.filter(block => block.start < end && block.end > start);
                const block = contained.length === 1 && contained[0];
                if (block && block.simple && block.start === start && block.end === end) {
                    // Only unwrap a self-contained group that can be toggled back intact.
                    if (!reversibleBlock(value, block, syntax)) continue;
                    targets.push({start, end, row, off: true});
                } else if (!contained.length && !ranges.hidden.slice(start, end).some(Boolean)) {
                    targets.push({start, end, row, off: false});
                }
            }
        });
        if (restoreLines) targets.push(...lineRestoreTargets(value, syntax, protectedRows));
        return targets.sort((a, b) => a.start - b.start);
    }
    function lineRestoreTargets(value, syntax, protectedRows) {
        const targets = [];
        const ranges = commentRanges(value, syntax);
        const blocks = blockRanges(value);
        const lastBlockEnd = blocks.length ? blocks[blocks.length - 1].end : 0;
        const unfinished = value.indexOf('/*', lastBlockEnd);
        const markerPattern = syntax.markers.map(marker => marker === '//' ? '\\/\\/' : '#').join('|');
        let offset = 0;
        value.split('\n').forEach((line, row) => {
            const lineStart = offset;
            const lineEnd = offset + line.length;
            offset = lineEnd + 1;
            if (protectedRows.has(row)) return;
            const match = new RegExp(`^(${SPACE}*)(${markerPattern})`).exec(line);
            if (!match || (unfinished >= 0 && lineEnd > unfinished)) return;
            const markerStart = match[1].length;
            const markerLength = match[2].length;
            if (ranges.blockHidden[lineStart + markerStart] || blocks.some(block =>
                block.start < lineEnd && block.end > lineStart && !block.simple)) return;
            const inner = line.slice(0, markerStart) + line.slice(markerStart + markerLength);
            const peers = tagTargets(inner, syntax, false);
            if (!peers.length) return;
            const innerRanges = commentRanges(inner, syntax);
            const covered = Array(inner.length).fill(false);
            for (const peer of peers) for (let at = peer.start; at < peer.end; at++) covered[at] = true;
            // Reject any active expression that we cannot preserve as a complete group.
            for (let at = 0; at < inner.length; at++) {
                if (!covered[at] && !innerRanges.hidden[at] && inner[at] !== ',' && !blank(inner[at])) return;
            }
            const sourcePosition = position => lineStart + position + (position >= markerStart ? markerLength : 0);
            const sourcePeers = peers.map(peer => ({start: sourcePosition(peer.start), end: sourcePosition(peer.end), row, off: peer.off}));
            const plan = {start: lineStart + markerStart, end: lineStart + markerStart + markerLength, peers: sourcePeers};
            sourcePeers.forEach((peer, selected) => targets.push({...peer, off: true, lineRestore: plan, selected}));
        });
        return targets;
    }
    function editsForTag(target) {
        if (!target) return [];
        if (target.lineRestore) {
            const plan = target.lineRestore;
            const edits = [{start: plan.start, end: plan.end, text: ''}];
            plan.peers.forEach((peer, index) => {
                // Enable only the chosen group; all other groups must remain muted.
                if (index === target.selected ? !peer.off : peer.off) return;
                edits.push(...editsForTag(peer));
            });
            return edits;
        }
        return target.off ? [
            {start: target.start, end: target.start + 2, text: ''},
            {start: target.end - 2, end: target.end, text: ''}
        ] : [
            {start: target.start, end: target.start, text: '/*'},
            {start: target.end, end: target.end, text: '*/'}
        ];
    }
    function joinsCommentBoundary(text, blocks, offset) {
        const removed = new Set();
        for (const block of blocks) {
            for (const at of [block.start, block.start + 1, block.end - 2, block.end - 1]) removed.add(at - offset);
        }
        let previous = -1;
        for (let at = 0; at < text.length; at++) {
            if (removed.has(at)) continue;
            if (previous >= 0 && at !== previous + 1 && ['//', '/*', '*/'].includes(text[previous] + text[at])) return true;
            previous = at;
        }
        return false;
    }
    function linesOf(value, config = '//') {
        const syntax = syntaxOf(config);
        const ranges = commentRanges(value, syntax);
        const blocks = blockRanges(value);
        const simpleBlocks = new Map(syntax.block === 'any' ? blocks.filter(block => reversibleBlock(value, block, syntax)).map(block => [block.start, block]) : []);
        let offset = 0;
        let inBlock = false;
        return value.split('\n').map((text, index) => {
            const start = offset;
            offset += text.length + 1;
            // Also protect incomplete block boundaries while the user is editing.
            const rowBlocks = blocks.filter(block => block.start < start + text.length && block.end > start);
            let blocked = inBlock || rowBlocks.some(block => !simpleBlocks.has(block.start));
            for (let i = 0; i < text.length; i++) {
                const simple = simpleBlocks.get(start + i);
                if (simple) { i = simple.end - start - 1; continue; }
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
            // Commas left between muted groups do not make a prompt row active.
            const allMuted = blank(active) || (rowBlocks.length > 0 && blank(active.replace(/,/g, '')));
            // Unwrapping adjacent blocks must not turn their text into a new comment marker.
            if (!blocked && rowBlocks.length && joinsCommentBoundary(text, rowBlocks, start)) blocked = true;
            return {text, index, start, blocked, parts, active, blocks: rowBlocks,
                empty: blank(text), off: !blank(text) && allMuted,
                comment: match ? {at: start + match[1].length, marker: match[2]} : null};
        });
    }
    function enabledRowText(line, syntax) {
        const markerPattern = syntax.markers.map(marker => marker === '//' ? '\\/\\/' : '#').join('|');
        const leading = new RegExp(`^(${SPACE}*)(?:${markerPattern})`);
        let text = line.text;
        for (let match; (match = leading.exec(text));) {
            text = match[1] + text.slice(match[0].length);
        }
        // Row-on deliberately resets individual mute states instead of remembering them.
        if (line.blocks.length) text = text.replace(/\/\*([\s\S]*?)\*\//g, '$1');
        return text;
    }
    function rowEdit(line, text) {
        if (text === line.text) return null;
        let start = 0, oldEnd = line.text.length, newEnd = text.length;
        while (start < oldEnd && start < newEnd && line.text[start] === text[start]) start++;
        while (oldEnd > start && newEnd > start && line.text[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
        return {start: line.start + start, end: line.start + oldEnd, text: text.slice(start, newEnd)};
    }
    function enableRow(line, syntax) {
        if (!line || line.empty || line.blocked || !syntax.marker) return null;
        return rowEdit(line, enabledRowText(line, syntax));
    }
    function disableRow(line, syntax) {
        if (!line || line.empty || line.blocked || !syntax.marker) return null;
        const plain = enabledRowText(line, syntax);
        const indent = new RegExp(`^${SPACE}*`).exec(plain)[0].length;
        const text = plain.slice(0, indent) + syntax.marker + plain.slice(indent);
        return rowEdit(line, text);
    }
    function editForRow(line, syntax) {
        if (!line || line.empty || line.blocked || !syntax.marker) return null;
        if (line.off || line.comment) return enableRow(line, syntax);
        return disableRow(line, syntax);
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
            if (mode === 'enable') {
                const edit = enableRow(row, syntax);
                return edit ? [edit] : [];
            }
            if (mode === 'disable') {
                const edit = disableRow(row, syntax);
                return edit ? [edit] : [];
            }
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
        module.exports = {linesOf, editFor, mapPosition, isCommented, editsForMode, applyTextEdits, mapEdits, syntaxOf, commentRanges, blockRanges, tagTargets, editsForTag};
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
            cursor: ta.style.cursor,
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
        brand.title = 'Prompt Lines 1.2.4 · Alt＋クリックでカンマ区切りのタグを切替';
        brand.setAttribute('aria-hidden', 'true');
        const divider = make('span', 'plc-divider');
        divider.setAttribute('aria-hidden', 'true');
        const actions = make('div', 'plc-actions');
        const hint = make('span', 'plc-hint', 'Alt+クリックで個別にコメントアウト');
        hint.title = 'Altを押しながらタグをクリックすると、そのまとまりをオン／オフできます';
        header.append(brand, divider, actions, hint);
        const gutter = make('div', 'plc-gutter');
        gutter.setAttribute('role', 'group');
        gutter.setAttribute('aria-label', '行の有効／無効。オンは有効、オフはコメントアウト');
        const overlay = make('div', 'plc-overlay');
        overlay.setAttribute('aria-hidden', 'true');
        const highlights = make('div', 'plc-highlights');
        const textLayer = make('div', 'plc-text');
        overlay.append(highlights, textLayer);
        const hoverLayer = make('div', 'plc-overlay plc-hover');
        hoverLayer.setAttribute('aria-hidden', 'true');
        const mirror = make('div', 'plc-mirror');
        mirror.setAttribute('aria-hidden', 'true');
        const status = make('div', 'plc-status');
        status.setAttribute('role', 'status');
        host.append(overlay, hoverLayer, gutter, mirror);
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
                try { document.execCommand('insertText', false, replacement); } catch (_) { /* Fall back below. */ }
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
        function targetRects(target) {
            const row = rows[target.row];
            const node = spans[target.row] && spans[target.row].firstChild;
            if (!row || !node) return [];
            const range = document.createRange();
            range.setStart(node, target.start - row.start);
            range.setEnd(node, target.end - row.start);
            return Array.from(range.getClientRects());
        }
        function clickedTag(event) {
            const bounds = ta.getBoundingClientRect();
            if (event.clientX < bounds.left + ta.clientLeft || event.clientX >= bounds.left + ta.clientLeft + ta.clientWidth ||
                event.clientY < bounds.top + ta.clientTop || event.clientY >= bounds.top + ta.clientTop + ta.clientHeight) return null;
            const mirrorBounds = mirror.getBoundingClientRect();
            const x = event.clientX - bounds.left - ta.clientLeft + mirrorBounds.left + ta.scrollLeft;
            const y = event.clientY - bounds.top - ta.clientTop + mirrorBounds.top + ta.scrollTop;
            for (const target of tagTargets(ta.value, capability())) {
                // Hit-test glyphs, independently of spelling tools changing the caret or selection.
                if (targetRects(target).some(rect =>
                    x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top && y <= rect.bottom)) return target;
            }
            return null;
        }
        let pendingAlt = null, suppressAltClick = false;
        let altHeld = false, pointerPosition = null, hoverRaf = 0;
        const pointerEvents = typeof window.PointerEvent === 'function';
        const samePointer = event => pendingAlt &&
            (!pointerEvents || pendingAlt.pointerId === event.pointerId);
        const consume = event => {
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        function drawHover() {
            hoverLayer.replaceChildren();
            ta.style.cursor = original.cursor;
            hint.classList.remove('plc-hint-ready');
            if (!altHeld || !pointerPosition || composing || ta.disabled || ta.readOnly || ta.value !== lastValue) return;
            const target = clickedTag(pointerPosition);
            if (!target) return;
            ta.style.cursor = 'pointer';
            hint.classList.add('plc-hint-ready');
            const mirrorBounds = mirror.getBoundingClientRect();
            for (const rect of targetRects(target)) {
                const mark = make('i', 'plc-tag-hover');
                mark.style.left = `${rect.left - mirrorBounds.left - ta.scrollLeft - 1}px`;
                mark.style.top = `${rect.top - mirrorBounds.top - ta.scrollTop}px`;
                mark.style.width = `${rect.right - rect.left + 2}px`;
                mark.style.height = `${rect.bottom - rect.top}px`;
                hoverLayer.append(mark);
            }
        }
        function scheduleHover() {
            if (!hoverRaf && !destroyed) hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; drawHover(); });
        }
        // A lost release must not leave another prompt's controller owning the next gesture.
        listen(window, pointerEvents ? 'pointerdown' : 'mousedown', () => {
            pendingAlt = null; suppressAltClick = false;
        }, true);
        listen(window, 'scroll', scheduleHover, {capture: true, passive: true});
        listen(ta, pointerEvents ? 'pointermove' : 'mousemove', event => {
            pointerPosition = {clientX: event.clientX, clientY: event.clientY};
            altHeld = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
            scheduleHover();
        }, {passive: true});
        listen(ta, pointerEvents ? 'pointerleave' : 'mouseleave', () => { pointerPosition = null; scheduleHover(); });
        listen(window, 'keydown', event => {
            if (event.key === 'Escape') {
                pendingAlt = null; altHeld = false; pointerPosition = null; scheduleHover(); return;
            }
            altHeld = (event.key === 'Alt' || event.altKey) && !event.ctrlKey && !event.metaKey && !event.shiftKey;
            scheduleHover();
        });
        listen(window, 'keyup', event => {
            altHeld = event.key !== 'Alt' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
            scheduleHover();
        });
        // Capture only a recognized Alt gesture before the browser's spelling UI handles it.
        // Normal editing and the user's spellcheck setting are left untouched.
        listen(ta, pointerEvents ? 'pointerdown' : 'mousedown', event => {
            pendingAlt = null; suppressAltClick = false;
            if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0 ||
                event.detail > 1 || event.isPrimary === false || composing || event.isComposing || ta.disabled || ta.readOnly) return;
            const cap = capability();
            if (!cap.marker || syntaxOf(cap).block !== 'any') return;
            render();
            const target = clickedTag(event);
            if (!target) return;
            pointerPosition = {clientX: event.clientX, clientY: event.clientY};
            altHeld = true;
            drawHover();
            pendingAlt = {target, value: ta.value, x: event.clientX, y: event.clientY,
                pointerId: event.pointerId, moved: false};
            suppressAltClick = true;
            consume(event);
        }, true);
        listen(window, pointerEvents ? 'pointermove' : 'mousemove', event => {
            if (samePointer(event) && Math.hypot(event.clientX - pendingAlt.x, event.clientY - pendingAlt.y) > 4) pendingAlt.moved = true;
        }, true);
        listen(window, pointerEvents ? 'pointerup' : 'mouseup', event => {
            if (!samePointer(event)) return;
            const gesture = pendingAlt; pendingAlt = null;
            consume(event);
            if (gesture.moved || ta.value !== gesture.value || composing || ta.disabled || ta.readOnly) return;
            const target = clickedTag(event);
            if (!target || target.start !== gesture.target.start || target.end !== gesture.target.end || target.off !== gesture.target.off) return;
            apply(editsForTag(target), ta, event);
        }, true);
        if (pointerEvents) listen(window, 'pointercancel', event => { if (samePointer(event)) pendingAlt = null; }, true);
        listen(window, 'blur', () => { pendingAlt = null; altHeld = false; pointerPosition = null; scheduleHover(); });
        listen(ta, 'click', event => {
            if (suppressAltClick) { suppressAltClick = false; consume(event); }
        }, true);
        for (const [mode, icon, label] of [['enable', '✓', '全有効'], ['disable', '−', '全無効'], ['invert', '⇄', '反転']]) {
            const button = make('button', 'plc-action');
            button.type = 'button'; button.dataset.mode = mode;
            const glyph = make('span', 'plc-action-icon', icon); glyph.setAttribute('aria-hidden', 'true');
            button.append(glyph, document.createTextNode(label));
            button.title = `${label}（行の有効化は個別コメントも解除。空行・保護範囲は変更しません）`;
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
                    // The switch tracks active groups; only native-removed text gets a strike.
                    visibleSpans[i].classList.toggle('plc-commented', commented && !!cap.marker && blank(row.active));
                });
                const eligible = rows.filter(row => !row.empty && !row.blocked);
                controls.forEach(button => { button.disabled = !cap.marker || composing || ta.disabled || ta.readOnly || !eligible.length; });
                const tagAvailable = !!cap.marker && syntaxOf(cap).block === 'any';
                // Keep the discoverability label visible even while host detection is pending.
                // Availability is enforced by the gesture handler, not by hiding the label.
                hint.hidden = false;
                hint.setAttribute('aria-disabled', String(!tagAvailable));
                hint.title = tagAvailable ? 'Altを押しながらタグをクリックすると、そのまとまりをオン／オフできます' :
                    '本体の部分コメント機能を確認できないため、Alt＋クリックは現在利用できません';
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
            for (const prop of ['left', 'top', 'width', 'height']) hoverLayer.style[prop] = overlay.style[prop];
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
            drawHover();
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
                if (hoverRaf) cancelAnimationFrame(hoverRaf);
                listeners.forEach(fn => fn()); if (observer) observer.disconnect();
                nativeText(true);
                gutter.remove(); mirror.remove(); overlay.remove(); hoverLayer.remove(); status.remove(); header.remove();
                ta.style.paddingLeft = original.padding; ta.style.cursor = original.cursor; host.style.position = original.position;
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
