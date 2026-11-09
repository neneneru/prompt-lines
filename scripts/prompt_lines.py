"""UI only: detect the host's native comment syntax; never patch processing."""
import html
import json

import gradio as gr
from modules import scripts, shared


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
        return []
