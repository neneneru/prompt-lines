/* Prompt Lines. Original textareas and host parsing stay intact. */
(() => {
    'use strict';
    const API_VERSION = '1.5.0-preview.6';
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
    // Physical Enter-separated lines, not visual word wrapping.
    function switchText(row, replacement, config) {
        if (typeof replacement !== 'string' || /[\r\n]/.test(replacement)) return null;
        const syntax = syntaxOf(config);
        if (!row || row.blocked) return null;
        if (row.off && syntax.marker) {
            const prefix = row.comment ? row.text.slice(0, row.comment.at - row.start) + row.comment.marker : syntax.marker;
            return prefix + replacement;
        }
        return replacement;
    }
    function rowBody(row) {
        return row.comment && row.off ? row.text.slice(0, row.comment.at - row.start) + row.text.slice(row.comment.at - row.start + row.comment.marker.length) : row.text;
    }
    function captureRows(value, selection, config) {
        const rows = linesOf(value, config), selected = new Set();
        for (const part of selection.split(/[,，、]/)) {
            const match = /^\s*(\d+)\s*(?:[-~〜～–]\s*(\d+)\s*)?$/.exec(part);
            const start = match && Number(match[1]), end = match && Number(match[2] || match[1]);
            if (!match || start < 1 || end < start || end > rows.length || end - start > 999) return {error: '現在の行番号・範囲を入力してください（例：1-3,5-6）。'};
            for (let line = start; line <= end; line++) selected.add(line);
            if (selected.size > 1000) return {error: '一度に反映できるのは1000行までです。'};
        }
        const operations = [];
        for (const line of [...selected].sort((a,b) => a-b)) {
            const row = rows[line - 1];
            if (row.blocked) return {error: `${line}行目は複数行コメントの一部のため登録できません。`};
            operations.push({line, mode:'replace', original:row.text, text:rowBody(row), state:row.off ? 'disable' : 'enable'});
        }
        return {operations};
    }
    function presetOperations(preset) {
        return Array.isArray(preset.operations) ? preset.operations :
            [{line: preset.line, mode: 'replace', original: preset.original, text: preset.text}];
    }
    function validPresets(data) {
        if (!Array.isArray(data)) return [];
        const ids = new Set();
        return data.flatMap(p => {
            if (!p || typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim()) return [];
            const operations = presetOperations(p), lines = new Set();
            if (!operations.length || operations.some(op => !op || !Number.isSafeInteger(op.line) || op.line < 1 ||
                lines.has(op.line) || !lines.add(op.line) || !['replace', 'disable', 'enable'].includes(op.mode) || (op.state !== undefined && !['keep', 'enable', 'disable'].includes(op.state)) ||
                typeof op.original !== 'string' || /[\r\n]/.test(op.original) ||
                (op.mode === 'replace' && (typeof op.text !== 'string' || /[\r\n]/.test(op.text))))) return [];
            ids.add(p.id);
            return [{id: p.id, name: p.name.trim().slice(0, 80), operations: operations.map(op =>
                ({line: op.line, mode: op.mode, original: op.original, ...(op.mode === 'replace' ? {text: op.text, ...(op.state && op.state !== 'keep' ? {state: op.state} : {})} : {})}))}];
        });
    }
    function switchPlan(value, preset, peers, config) {
        const rows = linesOf(value, config), syntax = syntaxOf(config), edits = [], changes = [], seen = new Set();
        if (!syntax.marker) return {error:'行の無効化機能を確認できません。読み込み完了を待ってください。'};
        for (const op of presetOperations(preset)) {
            if (!Number.isSafeInteger(op.line) || op.line < 1 || seen.has(op.line)) return {error:`${op.line}行目が不正または重複しています。`};
            seen.add(op.line);
            const row = rows[op.line - 1];
            if (!row) return {error:`${op.line}行目がありません。`};
            if (row.blocked) return {error:`${op.line}行目は複数行コメントの一部のため変更できません。`};
            if (typeof op.text !== 'string' || !op.text.trim() || /[\r\n]/.test(op.text)) return {error:`${op.line}行目のプロンプトを空欄・改行なしで入力してください。`};
            const state = op.state;
            if (!['enable','disable'].includes(state)) return {error:`${op.line}行目の有効・無効を選び、プリセットを保存し直してください。`};
            let text;
            if (state === 'disable') {
                if (rowBody(row) !== op.text) return {error:`${op.line}行目の内容が一致しないため無効化できません。\n現在：${rowBody(row)}\n登録：${op.text}`};
                text = row.off ? row.text : syntax.marker + row.text;
            } else {
                text = op.text;
                const target = linesOf(text, syntax)[0];
                // Never silently unmute inline tags while enabling a replacement.
                if (target.blocked || target.off) return {error:`${op.line}行目は有効なプロンプト本文を入力してください（行全体のコメントは除いてください）。`};
            }
            changes.push({line:op.line,current:row.text,text,confirm:false});
            if (text !== row.text) edits.push({start:row.start,end:row.start+row.text.length,text});
        }
        return {edits,changes,confirm:false};
    }

    function editorIssues(value, operations, config) {
        const rows = linesOf(value, config), counts = new Map();
        operations.forEach(op => counts.set(op.line, (counts.get(op.line) || 0) + 1));
        return operations.flatMap((op, index) => {
            let message = '';
            if (counts.get(op.line) > 1) message = '行番号が重複しています。';
            else {
                const result = switchPlan(value, {operations:[op]}, [], config);
                if (result.error) {
                    const row = rows[op.line - 1];
                    message = op.state === 'disable' && row && !row.blocked && typeof op.text === 'string' && op.text.trim() && !/[\r\n]/.test(op.text) && rowBody(row) !== op.text
                        ? op.line + '行を無効にする場合は、元の内容との一致が必要です。'
                         : !syntaxOf(config).marker ? '無効化機能が未準備です。'
                        : !Number.isSafeInteger(op.line) || op.line < 1 || !row ? '行番号が不正、または行が存在しません。'
                        : row.blocked ? '複数行コメントの途中です。'
                        : typeof op.text !== 'string' || !op.text.trim() ? 'プロンプトが空欄です。'
                        : /[\r\n]/.test(op.text) ? 'プロンプトに改行が含まれています。'
                        : !['enable','disable'].includes(op.state) ? '有効・無効が未指定です。'
                        : '行全体がコメントアウトされています。';
                }
            }
            return message ? [{index, line:op.line, message}] : [];
        });
    }

    function sequenceInputs(sources) {
        const source=sources.find(item=>item.scope==='txt2img_prompt');
        const other=sources.find(item=>item.scope==='txt2img_neg_prompt');
        const positive=source?.input, negative=other?.input;
        // Use the exact textareas owned by the line controllers, never the first child input.
        if(!source?.ready || !other?.ready || !positive?.isConnected || !negative?.isConnected ||
            positive.tagName!=='TEXTAREA' || negative.tagName!=='TEXTAREA' || positive===negative)
            return {error:'プロンプト欄の読み込みを待ってください。生成していません。'};
        return {source,positive,negative};
    }

    function sequencePlan(prompt, negative, scope, presets, selection, config) {
        if (scope !== 'txt2img_prompt') return {error:'自動生成はポジティブプリセット専用です。'};
        const selected = new Set();
        for (const part of selection.split(/[,，、]/)) {
            const m = /^\s*(\d+)\s*(?:[-~〜～–]\s*(\d+)\s*)?$/.exec(part);
            const start = m && Number(m[1]), end = m && Number(m[2] || m[1]);
            if (!m || start < 1 || end < start || end > presets.length || end - start > 199) return {error:'対象ボタン番号を入力してください（例：1-5 / 2,4）。'};
            for (let n=start; n<=end; n++) selected.add(n);
        }
        if (!selected.size || selected.size > 200) return {error:'対象は1〜200件で指定してください。'};
        const jobs=[]; let current=prompt;
        for (const n of [...selected].sort((a,b)=>a-b)) {
            const preset=presets[n-1], plan=switchPlan(current,preset,presets,config);
            if (plan.error) return {error:`${n} ${preset.name}：${plan.error.split('\n')[0]} 生成していません。`};
            current=applyTextEdits(current,plan.edits);
            jobs.push({id:preset.id,name:preset.name,prompt:current,negative});
        }
        return {scope,prompt,negative,jobs};
    }

    // Pure functions are exported only to the Node test runner, never as WebUI globals.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {sequenceInputs, sequencePlan, editorIssues, captureRows, switchText, switchPlan, validPresets, presetOperations, linesOf, editFor, mapPosition, isCommented, editsForMode, applyTextEdits, mapEdits, syntaxOf, commentRanges, blockRanges, tagTargets, editsForTag};
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
    let storeQueue = Promise.resolve();
    function storeRequest(action, scope, payload = {}) {
        const run = () => new Promise((resolve, reject) => {
            const id = `${Date.now()}-${Math.random()}`, started = Date.now(); let sent = false;
            const timer = setInterval(() => {
                const input = root().querySelector('#plc-store-input textarea, #plc-store-input input');
                const output = root().querySelector('#plc-store-output textarea, #plc-store-output input');
                const host = root().querySelector('#plc-store-submit');
                const button = host && (host.matches('button') ? host : host.querySelector('button'));
                if (!sent && input && output && button) {
                    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, JSON.stringify({id, action, scope, ...payload}));
                    input.dispatchEvent(new Event('input', {bubbles: true}));
                    sent = true; setTimeout(() => button.click(), 0);
                }
                if (sent && output) {
                    try { const result = JSON.parse(output.value); if (result.id === id) { clearInterval(timer); resolve(result); return; } } catch (_) {}
                }
                if (Date.now() - started > 15000) { clearInterval(timer); reject(new Error('設定の保存先に接続できません。WebUIを再起動してください。')); }
            }, 50);
        });
        const result = storeQueue.then(run, run); storeQueue = result.catch(() => {}); return result;
    }

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
        let gutterWidth = 74;
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
        brand.title = `Prompt Lines ${API_VERSION} · Alt＋クリックでカンマ区切りのタグを切替`;
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
        let rows = [], boxes = [], numbers = [], spans = [], visibleSpans = [], composing = false, raf = 0;
        let destroyed = false;
        let feedback = null, feedbackTimer = 0;
        const shakeTimers = new Map();
        function clearFeedback() {
            clearTimeout(feedbackTimer); feedbackTimer = 0; feedback = null;
        }
        function presetFailure(button, message) {
            clearFeedback(); schedule(); showNotice(message);
            clearTimeout(shakeTimers.get(button));
            button.classList.remove('plc-preset-error');
            void button.offsetWidth; // Restart feedback on repeated presses.
            button.classList.add('plc-preset-error');
            shakeTimers.set(button, setTimeout(() => { button.classList.remove('plc-preset-error'); shakeTimers.delete(button); }, 420));
        }
        function presetSuccess(plan, button) {
            clearTimeout(shakeTimers.get(button)); shakeTimers.delete(button);
            button.classList.remove('plc-preset-error');
            clearFeedback();
            feedback = {lines: new Set(plan.changes.map(change => change.line)), started: performance.now(), value: ta.value};
            render();
            feedbackTimer = setTimeout(() => { clearFeedback(); schedule(); }, 900);
        }
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
            if (composing || !cap.marker || ta.readOnly || ta.disabled || !edits.length) { render(); return false; }
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
                    return false; // Never overwrite changes made by a conflicting editor.
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
            requestAnimationFrame(() => { if (!destroyed) { ta.scrollTop = top; ta.scrollLeft = left; schedule(); } });
            return true;
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
        const storageKey = `prompt-lines:switches:v1:${component.id}`;
        const presetStrip = make('div', 'plc-presets');
        presetStrip.setAttribute('aria-label', '登録済みの切替');
        const presetTrack = make('div', 'plc-preset-track');
        presetStrip.append(presetTrack);
        component.insertBefore(presetStrip, header);
        const notice = make('div', 'plc-switch-notice');
        notice.setAttribute('role', 'status'); notice.hidden = true;
        header.after(notice);
        const editor = make('div', 'plc-switch-editor');
        editor.hidden = true;
        editor.setAttribute('aria-label', 'プリセット編集');
        const editorHeadingRow = make('div', 'plc-editor-heading-row');
        editorHeadingRow.append(make('div', 'plc-editor-heading', 'プリセット編集')); editor.append(editorHeadingRow);
        header.after(editor);
        const switchButton = make('button', 'plc-action');
        switchButton.type = 'button'; switchButton.setAttribute('aria-expanded', 'false');
        const switchGlyph = make('span', 'plc-action-icon plc-preset-icon');
        switchGlyph.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9M18 2v8M14 6h8M8 12h4M8 16h8"/></svg>'; switchGlyph.setAttribute('aria-hidden', 'true');
        switchButton.append(switchGlyph, document.createTextNode('登録'));
        actions.append(switchButton);
        let presets = [], editingId = null, layoutWidth = -1;
        function showNotice(message) { notice.textContent = message; notice.hidden = !message; }
        function field(parent, label, tag, type) {
            const wrapper = make('label', 'plc-switch-field');
            const input = make(tag, 'plc-switch-input');
            if (type) input.type = type;
            wrapper.append(make('span', '', label), input); parent.append(wrapper); return input;
        }
        const nameInput = field(editor, 'ボタン名', 'input', 'text'); nameInput.maxLength = 80;
        const rangeControls = make('div', 'plc-range-controls');
        const rangeInput = field(rangeControls, 'まとめて登録', 'input', 'text'); rangeInput.placeholder = '例：1-5 / 1-2,4-5';
        const rangeButton = make('button', '', '反映'); rangeButton.type = 'button'; rangeControls.append(rangeButton); editor.append(rangeControls);
        const operationList = make('div', 'plc-operation-list'); editor.append(operationList);
        let operationInputs = [], validationShown = false;
        function addOperation(op = {}) {
            const container = make('div', 'plc-operation');
            const line = field(container, '行番号', 'input', 'number'); line.min = '1'; line.step = '1'; line.value = op.line || '';
            const text = field(container, '置換内容', 'textarea'); text.rows = 1; text.value = op.text || ''; text.placeholder = 'プロンプト';
            text.setAttribute('aria-label', '置換内容'); line.setAttribute('aria-label', '行番号');
            text.addEventListener('input', schedule);
            text.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) event.preventDefault(); });
            const state = make('button', 'plc-operation-state'); state.type = 'button';
            // Legacy 'keep' remains unchanged in saved data until the user saves this editor.
            const storedState = op.mode === 'replace' ? op.state : op.mode;
            const currentRow = linesOf(ta.value, capability())[Number(op.line) - 1];
            let stateValue = ['enable', 'disable'].includes(storedState) ? storedState : currentRow && currentRow.off ? 'disable' : 'enable';
            function updateState() {
                state.dataset.state = stateValue; container.dataset.state = stateValue;
                const label = stateValue === 'enable' ? '有効' : '無効';
                state.textContent = ''; state.title = `${label}：クリックで有効・無効を切替`;
                state.setAttribute('aria-label', `行の状態：${label}`);
                state.setAttribute('role', 'switch'); state.setAttribute('aria-checked', String(stateValue === 'enable'));
            }
            state.addEventListener('click', () => { stateValue = stateValue === 'enable' ? 'disable' : 'enable'; updateState(); });
            updateState();
            const add = make('button', 'plc-operation-plus'); add.type = 'button'; add.setAttribute('aria-label', '対象行を追加');
            const remove = make('button', 'plc-operation-remove'); remove.type = 'button'; remove.setAttribute('aria-label', 'この操作を削除');
            add.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
            remove.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';
            container.insertBefore(state, text.parentElement); container.append(add, remove);
            add.addEventListener('click', () => addOperation().line.focus());
            const error = make('small', 'plc-operation-error'); error.id = 'plc-error-' + newPresetId(); error.hidden = true; container.append(error);
            const inputs = {container, line, text, error, state: () => stateValue, source: op}; operationInputs.push(inputs);
            let committedLine = String(op.line || '');
            line.addEventListener('change', () => {
                if (line.value === committedLine) return;
                if (operationInputs.some(item => item !== inputs && Number(item.line.value) === Number(line.value))) {
                    showNotice(`${line.value}行目は登録済みです。`); line.value = committedLine; return;
                }
                const captured = captureRows(ta.value, line.value, capability());
                if (captured.error) { showNotice(captured.error); return; }
                const capturedRow = captured.operations[0];
                if (text.value && text.value !== (inputs.source.text || '') && !window.confirm('編集中の置換内容を、指定行の内容で入れ替えますか？')) { line.value = committedLine; return; }
                committedLine = line.value; text.value = capturedRow.text; stateValue = capturedRow.state; inputs.source = capturedRow; updateState(); showNotice(''); schedule();
            });
            remove.addEventListener('click', () => { container.remove(); operationInputs = operationInputs.filter(item => item !== inputs); schedule(); });
            operationList.append(container); schedule(); return inputs;
        }
        const addButton = make('button', 'plc-operation-add', '＋ 行を追加'); addButton.type = 'button'; editor.append(addButton);
        const operationHint = make('small', 'plc-operation-hint');
        for (const [label, description] of [['有効', '置換'], ['無効', '一致を確認して無効化']]) {
            const item = make('span', 'plc-operation-legend');
            item.append(make('span', 'plc-state-label', label), make('span', '', description)); operationHint.append(item);
        }
        editorHeadingRow.append(operationHint);
        const editorActions = make('div', 'plc-editor-actions');
        const saveButton = make('button', 'plc-editor-save', '保存'); saveButton.type = 'button';
        const deleteButton = make('button', 'plc-editor-delete', '削除'); deleteButton.type = 'button';
        editorActions.append(saveButton, deleteButton); editor.append(editorActions);
        const importButton = make('button', 'plc-action plc-import-action', 'JSON読み込み'); importButton.type = 'button';
        const importGlyph = make('span', 'plc-action-icon plc-preset-icon');
        importGlyph.setAttribute('aria-hidden', 'true');
        importGlyph.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/></svg>';
        importButton.prepend(importGlyph);
        const editHint = make('small', 'plc-edit-hint', '登録済みボタンを右クリックで編集');
        const importFile = make('input', 'plc-import-file'); importFile.type = 'file'; importFile.accept = '.json,application/json'; importFile.hidden = true;
        const presetToolbar = make('div', 'plc-preset-toolbar');
        const presetDivider = make('span', 'plc-divider'); presetDivider.setAttribute('aria-hidden','true');
        const storagePath = make('small', 'plc-storage-path', '保存先を確認中…');
        presetToolbar.append(switchButton, editHint, presetDivider, importButton, importFile, storagePath);
        const toolbarBranding = make('div', 'plc-toolbar-branding');
        toolbarBranding.setAttribute('aria-hidden', 'true');
        toolbarBranding.append(brand.cloneNode(true), divider.cloneNode(true)); presetToolbar.prepend(toolbarBranding);
        header.before(presetToolbar);
        presetToolbar.after(editor); editor.after(notice);
        const nameRow = make('div', 'plc-name-row');
        nameInput.parentElement.before(nameRow); nameRow.append(nameInput.parentElement, editorActions);
        const registrationRow = make('div', 'plc-registration-row');
        nameRow.before(registrationRow); registrationRow.append(nameRow, rangeControls);
        function closeEditor() { editor.hidden = true; switchButton.setAttribute('aria-expanded', 'false'); schedule(); }
        function openEditor(preset) {
            editingId = preset ? preset.id : null; validationShown = false;
            nameInput.value = preset ? preset.name : '';
            operationList.replaceChildren(); operationInputs = [];
            const initial = captureRows(ta.value, '1', capability());
            for (const op of preset ? preset.operations : (initial.operations || [{}])) addOperation(op);
            deleteButton.hidden = !preset;
            editor.hidden = false; switchButton.setAttribute('aria-expanded', 'true');
            showNotice(''); if (!serverReady) loadStore();
            operationInputs[0].line.focus({preventScroll: true}); schedule();
        }
        let serverReady = false, serverRevision = 0, storeBusy = false, initialized = false;
        async function loadStore() {
            try {
                const result = await storeRequest('read', component.id);
                if (!result.ok) throw new Error(result.error);
                const loaded = validPresets(result.presets);
                if (loaded.length !== result.presets.length) throw new Error('保存済みの設定を読み取れません。元のファイルは変更していません。');
                presets = loaded; serverRevision = result.revision; serverReady = true;
                storagePath.textContent = /[A-Za-z]:[\\/]/.test(result.path) ? '保存先：%LOCALAPPDATA%\\PromptLines' : `保存先：${result.path.replace(/[\\/]presets\.json$/, '')}`; storagePath.title = result.path;
                renderPresets();
                initialized = true;
            } catch (error) { serverReady = false; showNotice(error.message || '設定を読み込めませんでした。'); }
            schedule();
        }
        async function persist(next) {
            if (!serverReady || storeBusy) { showNotice('設定の読み書きが完了するまでお待ちください。'); return false; }
            storeBusy = true; saveButton.disabled = deleteButton.disabled = true;
            try {
                let result = await storeRequest('write', component.id, {revision: serverRevision, presets: next});
                // A concurrent write to another prompt scope does not invalidate this one.
                if (result.conflict && JSON.stringify(result.presets) === JSON.stringify(presets)) {
                    result = await storeRequest('write', component.id, {revision: result.revision, presets: next});
                }
                if (!result.ok) {
                    if (result.conflict) { presets = validPresets(result.presets); serverRevision = result.revision; renderPresets(); }
                    throw new Error(result.error);
                }
                presets = validPresets(result.presets); serverRevision = result.revision; renderPresets(); return true;
            } catch (error) { showNotice(error.message || '設定を保存できませんでした。'); return false; }
            finally { storeBusy = false; saveButton.disabled = deleteButton.disabled = false; schedule(); }
        }
        function layoutPresets() {
            if (presetStrip.hidden || !presetStrip.clientWidth) return;
            const width = presetStrip.clientWidth;
            if (width === layoutWidth) return;
            layoutWidth = width;
            const buttons = Array.from(presetTrack.children);
            const widths = buttons.map(button => button.getBoundingClientRect().width);
            const needed = widths.reduce((sum, w) => sum + w, 0) + Math.max(0, widths.length - 1) * 8;
            presetTrack.style.width = '';
            if (needed <= width) return;
            const fits = limit => {
                let rows = 1, used = 0;
                for (const w of widths) {
                    if (used && used + 8 + w > limit + 0.1) { rows++; used = w; }
                    else used += (used ? 8 : 0) + w;
                }
                return rows <= 2;
            };
            let low = Math.max(width, ...widths), high = Math.max(low, needed);
            for (let i = 0; i < 20; i++) { const mid = (low + high) / 2; if (fits(mid)) high = mid; else low = mid; }
            presetTrack.style.width = `${Math.ceil(high + 1)}px`;
        }
        function renderPresets() {
            const scroll = presetStrip.scrollLeft;
            presetTrack.replaceChildren();
            presetStrip.hidden = !presets.length;
            for (const preset of presets) {
                const button = make('button', 'plc-preset', `${presets.indexOf(preset)+1} ${preset.name}`); button.type = 'button';
                button.title = preset.operations.map(op => `${op.line}行目：${op.mode === 'disable' ? '無効化' : op.mode === 'enable' ? '有効化' : op.text}`).join('\n') + '\n右クリックまたは Shift＋クリックで編集';
                button.addEventListener('click', event => {
                    if (event.shiftKey) { openEditor(preset); return; }
                    if (composing || !serverReady || storeBusy || !capability().marker || ta.readOnly || ta.disabled) return;
                    const value = ta.value;
                    const plan = switchPlan(value, preset, presets, capability());
                    if (plan.error) {
                        openEditor(preset);
                        presetFailure(button, plan.error.split('\n')[0] + ' 全行未反映です。'); return;
                    }
                    if (plan.confirm && !window.confirm('次の行の内容が変わっています。まとめて変更しますか？\n\n' + plan.changes.filter(change => change.confirm).map(change => `${change.line}行目\n現在：${change.current}\n変更後：${change.text}`).join('\n\n'))) return;
                    if (ta.value !== value) { presetFailure(button, '内容が更新されました。もう一度押してください。'); return; }
                    showNotice('');
                    if (plan.edits.length && !apply(plan.edits, button, event)) {
                        presetFailure(button, '反映を確認できません。現在の内容を確認してください。'); return;
                    }
                    presetSuccess(plan, button);
                });
                button.addEventListener('contextmenu', event => { event.preventDefault(); openEditor(preset); });
                presetTrack.append(button);
            }
            layoutWidth = -1; layoutPresets(); presetStrip.scrollLeft = scroll; schedule();
        }
        listen(switchButton, 'click', () => editor.hidden ? openEditor(null) : closeEditor());
        listen(editor, 'keydown', event => {
            if (event.key === 'Escape') { event.stopPropagation(); closeEditor(); switchButton.focus(); }
        });
        listen(addButton, 'click', () => addOperation().line.focus());
        listen(rangeButton, 'click', () => {
            const captured = captureRows(ta.value, rangeInput.value, capability());
            if (captured.error) { showNotice(captured.error); return; }
            const used = new Set(operationInputs.map(item => Number(item.line.value)));
            for (const op of captured.operations) if (!used.has(op.line)) { addOperation(op); used.add(op.line); }
            showNotice(''); schedule();
        });
        function validateEditor() {
            const rows = linesOf(ta.value, capability());
            const operations = operationInputs.map(inputs => {
                const line = Number(inputs.line.value), row = rows[line - 1];
                return {line, mode:'replace', text:inputs.text.value, state:inputs.state(),
                    original:inputs.source.line === line && typeof inputs.source.original === 'string' ? inputs.source.original : row ? row.text : ''};
            });
            const issues = editorIssues(ta.value, operations, capability());
            operationInputs.forEach((inputs,index) => {
                const issue = issues.find(item => item.index === index);
                inputs.container.classList.toggle('plc-operation-invalid', Boolean(issue));
                inputs.error.textContent = issue ? issue.message : ''; inputs.error.hidden = !issue;
                for (const control of [inputs.line, inputs.text]) {
                    if (issue) { control.setAttribute('aria-invalid','true'); control.setAttribute('aria-describedby',inputs.error.id); }
                    else { control.removeAttribute('aria-invalid'); control.removeAttribute('aria-describedby'); }
                }
            });
            showNotice(issues.length ? '強調した行にエラーがあります。' : '');
            return {operations, issues};
        }
        for (const type of ['input','change','click']) listen(editor, type, event => {
            if (event.type === 'click' && event.target.closest('button') === saveButton) return;
            if (validationShown && !editor.hidden) validateEditor();
        });
        listen(saveButton, 'click', async () => {
            if (composing || !serverReady || storeBusy || !capability().marker || ta.readOnly || ta.disabled) return;
            const name = nameInput.value.trim();
            if (!name) { showNotice('ボタン名が未入力です。'); nameInput.focus(); return; }
            if (!operationInputs.length) { showNotice('操作する行を追加してください。'); return; }
            validationShown = true;
            const {operations, issues} = validateEditor();
            if (issues.length) {
                operationInputs[issues[0].index].text.focus();
                return;
            }
            const old = presets.find(p => p.id === editingId);
            const next = {id: editingId || newPresetId(), name, operations};
            if (await persist(old ? presets.map(p => p.id === old.id ? next : p) : [...presets, next])) { closeEditor(); showNotice(''); }
        });
        function newPresetId() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; }
        listen(importButton, 'click', () => importFile.click());
        listen(importFile, 'change', async () => {
            const file = importFile.files[0]; importFile.value = ''; if (!file) return;
            try {
                const parsed = JSON.parse(await file.text()), raw = Array.isArray(parsed) ? parsed : parsed.presets;
                const incoming = validPresets(raw);
                if (!Array.isArray(raw) || !raw.length || incoming.length !== raw.length) throw new Error();
                // Existing entries are never overwritten. Re-importing an identical entry is a no-op.
                const next = [...presets]; let added = 0;
                for (const item of incoming) {
                    if (next.some(p => p.name === item.name && JSON.stringify(p.operations) === JSON.stringify(item.operations))) continue;
                    next.push({...item, id: next.some(p => p.id === item.id) ? newPresetId() : item.id}); added++;
                }
                if (await persist(next)) showNotice(`${added}件を追加しました。`);
            } catch (_) { showNotice('切替のJSONを読み込めませんでした。保存済みの設定は変更していません。'); }
        });
        listen(deleteButton, 'click', async () => {
            const item = presets.find(p => p.id === editingId);
            if (item && window.confirm(`「${item.name}」を削除しますか？`) && await persist(presets.filter(p => p.id !== item.id))) {
                closeEditor(); showNotice('');
            }
        });
        listen(window, 'focus', () => { if (!storeBusy && (editor.hidden || !serverReady)) loadStore(); });
        renderPresets();
        loadStore();

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
            switchButton.disabled = !serverReady || storeBusy || !cap.marker || composing || ta.disabled || ta.readOnly;
            presetStrip.querySelectorAll('button').forEach(button => { button.disabled = switchButton.disabled; });
            const firstAction = actions.querySelector('button');
            if (firstAction && firstAction.getClientRects().length) {
                const inset = Math.max(12, firstAction.getBoundingClientRect().left - component.getBoundingClientRect().left - component.clientLeft + header.scrollLeft);
                component.style.setProperty('--plc-action-start', `${inset}px`);
            }
            layoutPresets();
            const capKey = JSON.stringify(cap) + composing + ta.disabled + ta.readOnly;
            const changed = ta.value !== lastValue;
            if (feedback && feedback.value !== ta.value) clearFeedback();
            const syntaxKey = JSON.stringify(syntaxOf(cap));
            const syntaxChanged = syntaxKey !== lastSyntax;
            if (changed || syntaxChanged) {
                lastValue = ta.value; lastSyntax = syntaxKey;
                rows = linesOf(ta.value, cap);
                while (boxes.length > rows.length) { numbers.pop().remove(); boxes.pop().remove(); spans.pop().remove(); visibleSpans.pop().remove(); }
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
                    const number = make('span', 'plc-line-number', String(index + 1));
                    number.setAttribute('aria-hidden', 'true');
                    gutter.append(number, box); numbers.push(number); boxes.push(box);
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
            gutterWidth = 60 + Math.max(2, String(rows.length).length) * 7;
            ta.style.paddingLeft = `${basePadding + gutterWidth}px`;
            component.style.setProperty('--plc-number-width', `${gutterWidth - 47}px`);
            component.style.setProperty('--plc-prompt-start', `${ta.offsetLeft + ta.clientLeft + basePadding + gutterWidth}px`);
            const cs = getComputedStyle(ta);
            component.style.setProperty('--plc-gutter-left', `${ta.offsetLeft + ta.clientLeft}px`);
            component.style.setProperty('--plc-prompt-font', cs.fontFamily);
            component.style.setProperty('--plc-prompt-size', cs.fontSize);
            component.style.setProperty('--plc-prompt-line-height', cs.lineHeight === 'normal' ? `${parseFloat(cs.fontSize) * 1.2}px` : cs.lineHeight);
            if (!editor.hidden) for (const item of operationInputs) {
                item.text.style.height = 'auto';
                item.text.style.height = `${item.text.scrollHeight}px`;
            }
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
                numbers[i].style.top = `${y}px`;
                numbers[i].style.visibility = y < -9 || y > ta.clientHeight - 9 ? 'hidden' : 'visible';
                boxes[i].style.top = `${y}px`;
                boxes[i].style.visibility = y < -9 || y > ta.clientHeight - 9 ? 'hidden' : 'visible';
                if (feedback && feedback.lines.has(i + 1)) {
                    const first = rect.top - mirrorBounds.top - ta.scrollTop - (lineHeight - rect.height) / 2;
                    const height = rects[rects.length - 1].bottom - rect.top + lineHeight - rect.height;
                    const flash = make('i', 'plc-row-applied');
                    flash.style.top = `${first}px`; flash.style.height = `${height}px`;
                    flash.style.animationDelay = `-${Math.min(899, performance.now() - feedback.started)}ms`;
                    fragments.append(flash);
                }
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
            sequenceSource() { return {scope:component.id, input:ta, presets:JSON.parse(JSON.stringify(presets)), ready:serverReady && !storeBusy}; },
            poll() {
                if (ta.value !== lastValue || JSON.stringify(capability()) + composing + ta.disabled + ta.readOnly !== lastCap ||
                    ta.clientWidth !== lastWidth || ta.clientHeight !== lastHeight || themeSignature() !== lastTheme) schedule();
            },
            destroy() {
                destroyed = true; clearFeedback(); shakeTimers.forEach(timer => clearTimeout(timer)); shakeTimers.clear(); if (raf) cancelAnimationFrame(raf);
                if (hoverRaf) cancelAnimationFrame(hoverRaf);
                listeners.forEach(fn => fn()); if (observer) observer.disconnect();
                nativeText(true);
                presetStrip.remove(); presetToolbar.remove(); editor.remove(); notice.remove();
                gutter.remove(); mirror.remove(); overlay.remove(); hoverLayer.remove(); status.remove(); header.remove();
                ta.style.paddingLeft = original.padding; ta.style.cursor = original.cursor; host.style.position = original.position;
                ta.classList.remove('plc-input'); component.classList.remove('plc-component');
                component.style.removeProperty('--plc-foreground'); delete component.dataset.plcTheme;
            }
        };
    }
    let sequenceSyncTheme = null;
    let sequencePanel = null, sequenceBusy = false, sequenceToken = '', sequencePolling = false, cancelSequence = false;
    const sequencePending = new Map();
    const element = id => root().querySelector('#'+id);
    const textbox = id => root().querySelector('#'+id+' textarea, #'+id+' input');
    function setBridge(id,value) {
        const input=textbox(id); if (!input) throw new Error('自動生成の準備ができていません。WebUIを再起動してください。');
        const proto=input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true}));
    }
    function bridgeButton(id) { const el=element(id); return el && (el.matches('button')?el:el.querySelector('button')); }
    window.promptLinesSequenceReady = raw => {
        let ack; try {ack=JSON.parse(raw);} catch (_) {return;}
        const pending=sequencePending.get(ack.requestId);
        if (pending) {sequencePending.delete(ack.requestId);pending(ack);}
    };
    function sequencePrepare(data) {
        return new Promise((resolve,reject)=>{
            const requestId=crypto.randomUUID();
            const timeout=setTimeout(()=>{sequencePending.delete(requestId);const error=new Error('開始を確認できません。WebUIを再読み込みしてから再試行してください。');error.uncertain=true;reject(error);},15000);
            sequencePending.set(requestId,ack=>{clearTimeout(timeout);resolve(ack);});
            try {setBridge('plc-sequence-request',JSON.stringify({...data,requestId}));
                // Input hydration happens before the hidden native Gradio callback is submitted.
                requestAnimationFrame(()=>{const button=bridgeButton('plc-sequence-arm');if(button)button.click();});
            } catch(e) {clearTimeout(timeout);sequencePending.delete(requestId);reject(e);}
        });
    }
    async function readSequenceStatus(cancel=false) {
        const requestId=crypto.randomUUID();setBridge('plc-sequence-status-in',JSON.stringify({requestId,token:sequenceToken,cancel}));
        await new Promise(resolve=>requestAnimationFrame(resolve)); bridgeButton('plc-sequence-poll')?.click();
        const started=Date.now();
        while(Date.now()-started<10000) {
            try {const value=JSON.parse(textbox('plc-sequence-status-out')?.value||'');if(value.requestId===requestId)return value;}catch(_){}
            await new Promise(resolve=>setTimeout(resolve,100));
        }
        throw new Error('状態を確認できません。ReForge側の進捗も確認してください。');
    }
    function mountSequence() {
        const box=element('txt2img_generate_box'), native=bridgeButton('txt2img_generate');
        if (!box || !native || !textbox('plc-sequence-request')) return;
        if (sequencePanel?.isConnected) {sequenceSyncTheme?.();return;}
        const panel=document.createElement('div');panel.className='plc-sequence-panel';sequencePanel=panel;
        const row=document.createElement('div');row.className='plc-sequence-controls';
        const range=document.createElement('input');range.type='text';range.className='plc-switch-input';range.placeholder='例：1-5 / 1-2,4-5';range.setAttribute('aria-label','対象ボタン番号');
        const start=document.createElement('button');start.type='button';start.className='plc-sequence-start';start.textContent='自動生成';
        const stop=document.createElement('button');stop.type='button';stop.className='plc-sequence-stop';stop.textContent='停止';stop.hidden=true;
        const status=document.createElement('div');status.className='plc-sequence-status';status.setAttribute('role','status');status.textContent='各プリセットにバッチ設定を使用';
        const rangeLabel=document.createElement('label');rangeLabel.className='plc-sequence-label';rangeLabel.htmlFor='plc-sequence-range';rangeLabel.textContent='指定プリセットを自動生成';range.id='plc-sequence-range';
        row.append(stop,rangeLabel,range);panel.append(start,row,status);box.after(panel);
        // Read native dimensions only; never resize or reparent the host's controls.
        const matchNativeButton=()=>{
            if(!panel.isConnected)return;
            const rect=native.getBoundingClientRect();
            if(rect.height>0){const height=rect.height+'px';if(start.style.height!==height)start.style.height=height;}
            const style=getComputedStyle(native);
            start.style.font=style.font;start.style.borderRadius=style.borderRadius;
        };
        sequenceSyncTheme=()=>{
            const reference=root().querySelector('#txt2img_prompt .plc-range-controls .plc-switch-input');
            if(!reference)return;
            const theme=getComputedStyle(reference);
            // Mirror the already themed range field, overriding broad host input rules.
            for(const key of ['color','background-color','border-color','border-radius','font-family','font-size']) {
                const value=theme.getPropertyValue(key);
                if(value && range.style.getPropertyValue(key)!==value)range.style.setProperty(key,value,'important');
            }
            range.style.setProperty('caret-color',theme.color,'important');
        };
        sequenceSyncTheme();
        matchNativeButton();
        if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(()=>{if(!panel.isConnected){observer.disconnect();return;}matchNativeButton();});observer.observe(native);}
        let allowNative=false;
        native.addEventListener('click',event=>{
            if(sequenceBusy && !allowNative){event.preventDefault();event.stopImmediatePropagation();}
        },true);
        const promptHost=element('tab_txt2img');
        promptHost?.addEventListener('keydown',event=>{if(sequenceBusy&&event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();event.stopImmediatePropagation();}},true);
        stop.addEventListener('click',()=>{cancelSequence=true;stop.disabled=true;status.textContent='停止を要求しています…';});
        async function monitor() {
            if(sequencePolling)return; sequencePolling=true;
            try {
                while(sequenceBusy && sequenceToken) {
                    try {
                        const result=await readSequenceStatus(cancelSequence);cancelSequence=false;
                        status.textContent=result.message;
                        if(result.status==='unknown'){status.textContent='生成状態が不明です。ReForge本体の進捗を確認してください。';break;}
                        if(['done','error','stopped'].includes(result.status))break;
                    } catch(e) {status.textContent=e.message;}
                    await new Promise(resolve=>setTimeout(resolve,1000));
                }
            } finally {sequencePolling=false;sequenceBusy=false;start.disabled=false;range.disabled=false;stop.hidden=true;stop.disabled=false;}
        }
        start.addEventListener('click',async()=>{
            if(sequenceBusy)return;
            const inputs=sequenceInputs([...controllers.values()].map(c=>c.sequenceSource()));
            if(inputs.error){status.textContent=inputs.error;return;}
            const {source,positive,negative}=inputs;
            const plan=sequencePlan(positive.value,negative.value,'txt2img_prompt',source.presets,range.value,capability());
            if(plan.error){status.textContent=plan.error;return;}
            sequenceBusy=true;start.disabled=true;range.disabled=true;status.textContent='確認中…';
            const preparingHost=element('tab_txt2img');const wasInert=preparingHost?.inert||false;
            if(preparingHost)preparingHost.inert=true;
            try {
                const ack=await sequencePrepare(plan);if(!ack.ok)throw new Error(ack.error);
                sequenceToken=ack.token;
                if(!positive.isConnected || !negative.isConnected || positive.value!==plan.prompt || negative.value!==plan.negative) {
                    await readSequenceStatus(true);throw new Error('プロンプトが更新されました。生成していません。');
                }
                // This is the host's ordinary submit event, after the native output/then acknowledgement.
                allowNative=true;native.click();allowNative=false;stop.hidden=false;
                monitor();
            } catch(e) {allowNative=false;if(!e.uncertain){sequenceBusy=false;start.disabled=false;range.disabled=false;}status.textContent=e.message;} finally {if(preparingHost)preparingHost.inert=wasInert;}
        });
    }

    function scan() {
        for (const [ta, controller] of controllers) {
            if (!ta.isConnected) { controller.destroy(); controllers.delete(ta); }
            else controller.poll();
        }
        for (const selector of SELECTORS) {
            const component = root().querySelector(selector);
            const ta = component && component.querySelector('textarea:not(.plc-switch-input)');
            if (ta && !controllers.has(ta)) controllers.set(ta, makeController(component, ta));
        }
    }
    const baseScan = scan;
    scan = function() { baseScan(); mountSequence(); };
    if (typeof onUiLoaded === 'function') onUiLoaded(scan);
    if (typeof onUiUpdate === 'function') onUiUpdate(scan);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan, {once: true});
    else scan();
    // Includes external style-paste and Gradio value assignments without synthetic input.
    setInterval(scan, 500);
})();
