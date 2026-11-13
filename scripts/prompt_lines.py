"""UI only: detect the host's native comment syntax; never patch processing."""
import html
import json

import gradio as gr
from modules import scripts, shared


import os
import sys
import time
import tempfile
import uuid
import threading
from pathlib import Path
from contextlib import contextmanager
from urllib.parse import urlsplit

STORE_SCOPES = {'txt2img_prompt', 'txt2img_neg_prompt', 'img2img_prompt', 'img2img_neg_prompt',
                'txt2img_hr_prompt', 'txt2img_hr_negative_prompt', 'txt2img_hr_neg_prompt'}
STORE_MUTEX = threading.Lock()


def store_path():
    if sys.platform == 'win32':
        base = Path(os.environ.get('LOCALAPPDATA') or Path.home() / 'AppData' / 'Local') / 'PromptLines'
    elif sys.platform == 'darwin':
        base = Path.home() / 'Library' / 'Application Support' / 'PromptLines'
    else:
        base = Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local' / 'share') / 'prompt-lines'
    return base / 'presets.json'


def validate_presets(items):
    if not isinstance(items, list):
        raise ValueError('Invalid presets')
    ids, result = set(), []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id'] or item['id'] in ids:
            raise ValueError('Invalid preset ID')
        name = item.get('name')
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise ValueError('Invalid name')
        ops = item.get('operations')
        if not isinstance(ops, list) or not ops:
            raise ValueError('Invalid operations')
        lines, clean = set(), []
        for op in ops:
            if not isinstance(op, dict):
                raise ValueError('Invalid operation')
            line, mode, original = op.get('line'), op.get('mode'), op.get('original')
            if type(line) is not int or line < 1 or line > 9007199254740991 or line in lines or mode not in ('replace', 'disable', 'enable'):
                raise ValueError('Invalid row')
            if not isinstance(original, str) or '\n' in original or '\r' in original:
                raise ValueError('Invalid original')
            entry = {'line': line, 'mode': mode, 'original': original}
            if mode == 'replace':
                text = op.get('text')
                if not isinstance(text, str) or '\n' in text or '\r' in text:
                    raise ValueError('Invalid text')
                entry['text'] = text
                state = op.get('state', 'keep')
                if state not in ('keep', 'enable', 'disable'):
                    raise ValueError('Invalid state')
                if state != 'keep':
                    entry['state'] = state
            lines.add(line)
            clean.append(entry)
        ids.add(item['id'])
        result.append({'id': item['id'], 'name': name, 'operations': clean})
    return result


@contextmanager
def store_lock(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = path.with_suffix('.lock')
    if path.is_symlink() or lock_path.is_symlink():
        raise ValueError('Symlink storage is not supported')
    with STORE_MUTEX, open(lock_path, 'a+b') as lock:
        lock.seek(0, 2)
        if lock.tell() == 0:
            lock.write(b'0'); lock.flush()
        deadline = time.monotonic() + 5
        while True:
            try:
                lock.seek(0)
                if sys.platform == 'win32':
                    import msvcrt
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Store busy')
                time.sleep(0.05)
        try:
            yield
        finally:
            lock.seek(0)
            if sys.platform == 'win32':
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def read_store(path):
    if not path.exists():
        return {'version': 1, 'revision': 0, 'instance': str(uuid.uuid4()), 'scopes': {}}
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or data.get('version') != 1 or type(data.get('revision')) is not int or data['revision'] < 0 or not isinstance(data.get('scopes'), dict) or not isinstance(data.get('instance'), str):
        raise ValueError('Invalid store')
    for scope, presets in data['scopes'].items():
        if scope not in STORE_SCOPES:
            raise ValueError('Unknown scope')
        validate_presets(presets)
    return data


def write_store(path, data):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, prefix='.presets-', suffix='.tmp', delete=False) as out:
            temporary = out.name
            json.dump(data, out, ensure_ascii=False, indent=2)
            out.flush(); os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def local_store_request(request):
    # No file contents are inserted into public HTML or served as static files.
    local = {'127.0.0.1', '::1', 'localhost'}
    client = getattr(getattr(request, 'client', None), 'host', None)
    headers = getattr(request, 'headers', {})
    host = urlsplit('//'+headers.get('host', '')).hostname
    if client not in local or host not in local:
        return False
    forwarded = headers.get('x-forwarded-for', '')
    if forwarded and any(part.strip() not in local for part in forwarded.split(',')):
        return False
    origin = headers.get('origin')
    return not origin or urlsplit(origin).netloc == headers.get('host')


def handle_store(raw, request):
    result = {'ok': False, 'id': None}
    try:
        query = json.loads(raw)
        result['id'] = query.get('id')
        if not local_store_request(request):
            return json.dumps({**result, 'error': 'ローカル接続でのみプリセットを保存・読込できます。'})
        scope = query.get('scope')
        if scope not in STORE_SCOPES or query.get('action') not in ('read', 'write'):
            raise ValueError('Invalid request')
        path = store_path()
        with store_lock(path):
            data = read_store(path)
            if not path.exists():
                write_store(path, data)
            current = data['scopes'].get(scope, [])
            if query['action'] == 'write':
                incoming = validate_presets(query.get('presets'))
                if query.get('revision') != data['revision']:
                    return json.dumps({**result, 'conflict': True, 'revision': data['revision'], 'presets': current,
                        'error': '別の画面で設定が変更されました。最新の設定を読み直してから保存してください。'})
                data['scopes'][scope] = incoming
                data['revision'] += 1
                write_store(path, data)
                current = incoming
            return json.dumps({**result, 'ok': True, 'revision': data['revision'], 'presets': current, 'path': str(path), 'instance': data['instance']}, ensure_ascii=False)
    except Exception:
        return json.dumps({**result, 'error': '設定ファイルを読み書きできません。既存の設定は変更していません。'}, ensure_ascii=False)


def store_callback(raw, request: gr.Request):
    return handle_store(raw, request)



def describe_syntax(fn, markers):
    """Describe native behavior with neutral probes, without altering its state."""
    def strips(sample):
        try:
            result = fn(sample)
            return (isinstance(result, str) and "plc_remove_b" not in result
                    and "plc_keep_a" in result and "plc_keep_c" in result)
        except Exception:
            return False

    marker = markers[0]
    inline = strips("plc_keep_a " + marker + "plc_remove_b\nplc_keep_c")
    if strips("plc_keep_a/*plc_remove_b*/plc_keep_c"):
        block = "any"
    elif strips("plc_keep_a\n/*plc_remove_b*/\nplc_keep_c"):
        block = "line"
    else:
        block = "none"
    dangling = strips("plc_keep_a /*plc_remove_b\nplc_keep_c")
    try:
        sample = fn("plc_keep_a   " + marker + "plc_remove_b")
        trim_before = sample in ("plc_keep_a", "plc_keep_a\n")
        newline_replacement = sample.endswith("\n")
    except Exception:
        trim_before = False
        newline_replacement = False
    return {"marker": marker, "markers": markers, "reason": "native",
            "inline": inline, "block": block, "dangling": dangling,
            "trimBefore": trim_before, "newlineReplacement": newline_replacement}


def detect_native_comments(script_data, enabled=True):
    """Probe only the already-loaded core Comments module, with neutral literals."""
    if not enabled:
        return {"marker": None, "reason": "disabled"}
    for entry in script_data:
        path = str(getattr(entry, "path", "")).replace("\\", "/")
        if not path.endswith("/modules/processing_scripts/comments.py"):
            continue
        fn = getattr(getattr(entry, "module", None), "strip_comments", None)
        if not callable(fn):
            continue
        markers = []
        for marker in ("//", "#"):
            try:
                result = fn("plc_keep_a\n  " + marker + " plc_remove_b\nplc_keep_c")
                if (isinstance(result, str) and "plc_remove_b" not in result
                        and "plc_keep_a" in result and "plc_keep_c" in result):
                    markers.append(marker)
            except Exception:
                continue
        if markers:
            return describe_syntax(fn, markers)
    return {"marker": None, "reason": "unsupported"}


class PromptLines(scripts.Script):
    def title(self):
        return "Prompt Lines"

    def show(self, is_img2img):
        return scripts.AlwaysVisible

    def ui(self, is_img2img):
        capability = detect_native_comments(
            scripts.scripts_data, getattr(shared.opts, "enable_prompt_comments", True)
        )
        payload = html.escape(json.dumps(capability), quote=True)
        # Keep a real DOM marker. Gradio visible=False may omit its contents.
        gr.HTML('<span class="plc-capability" data-plc-capability="' + payload + '"></span>')
        if not is_img2img:
            # Real DOM elements hidden by our CSS; native Gradio handles authentication.
            store_input = gr.Textbox(value="", elem_id="plc-store-input", label="", elem_classes=["plc-store-bridge"])
            store_output = gr.Textbox(value="", elem_id="plc-store-output", label="", elem_classes=["plc-store-bridge"])
            store_button = gr.Button("Prompt Lines storage", elem_id="plc-store-submit", elem_classes=["plc-store-bridge"])
            store_button.click(store_callback, inputs=[store_input], outputs=[store_output], queue=False, api_name=False)
        return []
