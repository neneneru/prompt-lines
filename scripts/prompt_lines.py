"""Prompt line controls, local presets and native selectable-script generation."""
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

# Native selectable script: no processing monkey-patches or timer-driven generation.
import copy
import secrets

_SEQUENCE_TITLE = 'Prompt Lines sequence'
_SEQUENCE_LOCK = threading.RLock()
_SEQUENCE = {}
_SEQUENCE_COMPONENTS = {}


def sequence_owner(request):
    return (getattr(request, 'session_hash', None), getattr(request, 'username', None))


def validate_sequence(raw, prompt, negative, count, size):
    if not isinstance(raw, str) or len(raw) > 2_000_000:
        raise ValueError('対象のデータが大きすぎます。')
    data = json.loads(raw)
    if data.get('scope') != 'txt2img_prompt':
        raise ValueError('自動生成はtxt2imgのポジティブプリセット専用です。')
    if data.get('prompt') != prompt or data.get('negative') != negative:
        raise ValueError('プロンプトが更新されました。もう一度開始してください。')
    jobs = data.get('jobs')
    if not isinstance(jobs, list) or not 1 <= len(jobs) <= 200:
        raise ValueError('対象プリセットを1〜200件で指定してください。')
    seen = set()
    for job in jobs:
        if not isinstance(job, dict) or not isinstance(job.get('id'), str) or not job['id'] or job['id'] in seen:
            raise ValueError('対象プリセットが不正または重複しています。')
        seen.add(job['id'])
        if any(not isinstance(job.get(k), str) or len(job[k]) > 100_000 for k in ('prompt', 'negative', 'name')):
            raise ValueError('プロンプトが不正です。')
        unchanged = 'negative'
        if job[unchanged] != data[unchanged]:
            raise ValueError('対象外のプロンプトが更新されています。')
    if int(count) != count or int(size) != size or not 1 <= count <= 128 or not 1 <= size <= 8:
        raise ValueError('バッチ設定を確認してください。')
    data.update(count=int(count), size=int(size))
    return data


def sequence_prepare(raw, script_index, prompt, negative, count, size, request: gr.Request):
    request_id = None
    try:
        if not local_store_request(request):
            raise ValueError('自動生成はローカル接続で利用してください。')
        request_id = json.loads(raw).get('requestId')
        runner = scripts.scripts_txt2img
        selected = runner.selectable_scripts[script_index - 1].title() if script_index else 'None'
        if selected not in ('None', _SEQUENCE_TITLE):
            raise ValueError('別のScriptが選択されています。Noneに戻してから開始してください。')
        data = validate_sequence(raw, prompt, negative, count, size)
        owner = sequence_owner(request)
        with _SEQUENCE_LOCK:
            now = time.monotonic()
            for token, entry in list(_SEQUENCE.items()):
                if entry['status'] != 'running' and now - entry['created'] > 300:
                    del _SEQUENCE[token]
                elif entry['status'] == 'ready' and now > entry['deadline']:
                    entry.update(status='error', message='開始待ちが期限切れになりました。もう一度開始してください。')
            if any(e['status'] in ('ready', 'running') for e in _SEQUENCE.values()):
                raise ValueError('別の自動生成が開始待ち、または実行中です。')
            if getattr(shared.state, 'job_count', 0) > 0:
                raise ValueError('生成中です。完了してから開始してください。')
            token = secrets.token_urlsafe(24)
            _SEQUENCE[token] = dict(data=data, owner=owner, status='ready', created=now,
                deadline=now + 60, message='開始待ち', stop=False, completed=0, current=0)
        ack = json.dumps(dict(ok=True, requestId=request_id, token=token))
        # The chained native Gradio event runs only after all three output values land.
        return token, gr.update(value=_SEQUENCE_TITLE), ack
    except Exception as error:
        return gr.update(), gr.update(), json.dumps(dict(ok=False, requestId=request_id, error=str(error)))


def sequence_status(raw, current_token, script_index, request: gr.Request):
    try:
        if not local_store_request(request):
            raise ValueError('ローカル接続で利用してください。')
        query = json.loads(raw)
        with _SEQUENCE_LOCK:
            entry = _SEQUENCE.get(query.get('token'))
            if entry is None or entry['owner'] != sequence_owner(request):
                raise ValueError('生成状態を確認できません。')
            if query.get('cancel') and entry['status'] in ('ready', 'running'):
                entry['stop'] = True
                if entry['status'] == 'ready':
                    entry.update(status='stopped', message='停止しました。')
                else:
                    shared.state.interrupt()
            if entry['status'] == 'ready' and time.monotonic() > entry['deadline']:
                entry.update(status='error', message='開始を確認できません。残りは実行していません。')
            clear = current_token == query.get('token') and entry['status'] in ('done', 'error', 'stopped')
            selected = scripts.scripts_txt2img.selectable_scripts[script_index-1].title() if script_index else 'None'
            response = json.dumps(dict(requestId=query.get('requestId'), status=entry['status'], message=entry['message'],
                completed=entry['completed'], current=entry['current'], total=len(entry['data']['jobs'])), ensure_ascii=False)
            return gr.update(value='') if clear else gr.update(), gr.update(value='None') if clear and selected == _SEQUENCE_TITLE else gr.update(), response
    except Exception as error:
        return gr.update(), gr.update(), json.dumps(dict(requestId=query.get('requestId') if 'query' in locals() else None,
            status='unknown', message=str(error)), ensure_ascii=False)


def run_sequence(p, token, process_images, Processed):
    with _SEQUENCE_LOCK:
        entry = _SEQUENCE.get(token)
        # Only an empty token means normal Generate. Replayed/cancelled tokens fail closed.
        if not token:
            return None
        if entry is None or entry['status'] in ('done', 'stopped', 'error'):
            raise ValueError('自動生成の要求は終了、または期限切れです。再度開始してください。')
        if entry['status'] != 'ready':
            raise ValueError('自動生成が実行中です。')
        data = entry['data']
        if entry['stop'] or time.monotonic() > entry['deadline']:
            entry.update(status='stopped', message='開始待ちが終了しました。')
            raise ValueError(entry['message'])
        if (p.prompt != data['prompt'] or p.negative_prompt != data['negative']
                or p.n_iter != data['count'] or p.batch_size != data['size']
                or getattr(p, 'user', None) != entry['owner'][1]):
            entry.update(status='error', message='開始前に設定が変わりました。生成していません。')
            raise ValueError(entry['message'])
        if getattr(p, 'txt2img_upscale', False) or getattr(getattr(shared, 'sd_model', None), 'is_wan', False):
            entry.update(status='error', message='動画モデル・Hires再処理では自動生成できません。')
            raise ValueError(entry['message'])
        entry['status'] = 'running'
    images, extras, prompts, negatives, seeds, subseeds, infos = [], [], [], [], [], [], []
    expected = data['count'] * data['size']
    try:
        shared.state.job_count = len(data['jobs']) * data['count']
        for index, job in enumerate(data['jobs']):
            if entry['stop'] or shared.state.interrupted or getattr(shared.state, 'stopping_generation', False):
                entry.update(status='stopped', message='停止しました。残りは実行していません。')
                break
            entry.update(current=index + 1, message=f"{index + 1}/{len(data['jobs'])} · {job['name']}")
            shared.state.job = entry['message']
            item = copy.copy(p)
            # Host-created settings and always-on script args are preserved, with mutable data isolated.
            for key in ('override_settings', 'extra_generation_params', 'styles'):
                if hasattr(p, key):
                    setattr(item, key, copy.copy(getattr(p, key)))
            item.prompt, item.negative_prompt = job['prompt'], job['negative']
            item.extra_result_images = []
            item.do_not_save_grid = True
            result = process_images(item)
            if getattr(result, 'video_path', None):
                raise ValueError('動画の自動生成には対応していません。')
            offset = int(getattr(result, 'index_of_first_image', 0))
            output = result.images[offset:]
            images.extend(output)
            extras.extend(getattr(result, 'extra_images', []))
            prompts.extend(getattr(result, 'all_prompts', []))
            negatives.extend(getattr(result, 'all_negative_prompts', []))
            seeds.extend(getattr(result, 'all_seeds', []))
            subseeds.extend(getattr(result, 'all_subseeds', []))
            infos.extend(getattr(result, 'infotexts', [])[offset:])
            if entry['stop'] or shared.state.interrupted or getattr(shared.state, 'stopping_generation', False):
                entry.update(status='stopped', message='停止しました。残りは実行していません。')
                break
            if len(output) != expected:
                entry.update(status='error', message='予定枚数と出力数が異なるため停止しました。残りは実行していません。')
                break
            entry['completed'] += 1
        else:
            entry.update(status='done', message=f"{len(data['jobs'])}件のプリセットが完了しました。")
        result = Processed(p, images, seeds[0] if seeds else p.seed, infos[0] if infos else entry['message'],
            all_prompts=prompts or [p.prompt], all_negative_prompts=negatives or [p.negative_prompt],
            all_seeds=seeds or [p.seed], all_subseeds=subseeds or [getattr(p, 'subseed', -1)], infotexts=infos)
        if hasattr(result, 'extra_images'):
            result.extra_images = extras
        return result
    except Exception:
        entry.update(status='error', message='生成エラーで停止しました。残りは実行していません。')
        raise
    finally:
        if entry['status'] == 'running':
            entry.update(status='error', message='完了を確認できません。残りは実行していません。')


class PromptLinesSequence(scripts.Script):
    def title(self):
        return _SEQUENCE_TITLE

    def show(self, is_img2img):
        return not is_img2img

    def after_component(self, component, **kwargs):
        if getattr(component, 'elem_id', None) in ('txt2img_prompt', 'txt2img_neg_prompt', 'txt2img_batch_count', 'txt2img_batch_size'):
            _SEQUENCE_COMPONENTS[component.elem_id] = component

    def ui(self, is_img2img):
        token = gr.Textbox(value='', elem_id='plc-sequence-token', elem_classes=['plc-store-bridge'])
        raw = gr.Textbox(value='', elem_id='plc-sequence-request', elem_classes=['plc-store-bridge'])
        ack = gr.Textbox(value='', elem_id='plc-sequence-ack', elem_classes=['plc-store-bridge'])
        arm = gr.Button('Prepare sequence', elem_id='plc-sequence-arm', elem_classes=['plc-store-bridge'])
        status_in = gr.Textbox(value='', elem_id='plc-sequence-status-in', elem_classes=['plc-store-bridge'])
        status_out = gr.Textbox(value='', elem_id='plc-sequence-status-out', elem_classes=['plc-store-bridge'])
        poll = gr.Button('Sequence status', elem_id='plc-sequence-poll', elem_classes=['plc-store-bridge'])
        gr.HTML('<span class="plc-sequence-capability">Prompt Lines 自動生成 · バッチ設定を各プリセットに使用します。通常の生成はそのまま使えます。</span>')
        keys = ('txt2img_prompt', 'txt2img_neg_prompt', 'txt2img_batch_count', 'txt2img_batch_size')
        if all(key in _SEQUENCE_COMPONENTS for key in keys):
            dropdown = scripts.scripts_txt2img.inputs[0]
            arm.click(sequence_prepare, inputs=[raw, dropdown] + [_SEQUENCE_COMPONENTS[k] for k in keys],
                outputs=[token, dropdown, ack], queue=False, api_name=False).then(
                fn=None, _js='(ack) => { if (window.promptLinesSequenceReady) window.promptLinesSequenceReady(ack); return []; }',
                inputs=[ack], outputs=[], queue=False)
            poll.click(sequence_status, inputs=[status_in, token, dropdown], outputs=[token, dropdown, status_out], queue=False, api_name=False)
        return [token]

    def run(self, p, token):
        from modules.processing import process_images, Processed
        return run_sequence(p, token, process_images, Processed)
