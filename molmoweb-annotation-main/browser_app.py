import argparse
import asyncio
import base64
import gzip
import json
import logging
import os
import shutil
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, cast

from fasthtml.common import *

IS_DEVELOPMENT_ENVIRONMENT = (
    os.environ.get("ENV", "production") == "development"
)

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(
    os.environ.get("ANNOTATION_DATA_DIR", str(APP_DIR / "uploads"))
).expanduser().resolve()


def _load_dotenv(path: Path) -> None:
    """Populate os.environ from a local, untracked .env (KEY=VALUE per line).
    Existing environment variables win, so real env always overrides the file.
    Used for SSH credentials so they never live in the source / git."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


_load_dotenv(APP_DIR / ".env")


def _path_under_data_dir(relative_key: str) -> Path:
    rel = Path(relative_key)
    if rel.is_absolute() or ".." in rel.parts:
        raise ValueError("Invalid upload path")
    base = DATA_DIR.resolve()
    out = (base / rel).resolve()
    out.relative_to(base)
    return out


def _copy_upload_to_file(upload: UploadFile, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    upload.file.seek(0)
    with dest.open("wb") as out:
        shutil.copyfileobj(upload.file, out)


def stringify(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False, indent=2)
    return str(v)


def _format_ts(ts) -> str:
    """Format an epoch-millisecond timestamp; return 'N/A' on bad input."""
    if ts is None:
        return "N/A"
    try:
        return datetime.fromtimestamp(ts / 1000).strftime(
            "%Y-%m-%d | %H:%M:%S.%f"
        )
    except Exception:
        return "N/A"


def _bbox_overlay(bbox, viewport_width, viewport_height):
    """A red rectangle Div positioned (as %) over the screenshot for a clicked
    element's bbox, or None if there isn't enough info to place it."""
    if not isinstance(bbox, dict) or not viewport_width or not viewport_height:
        return None
    x = bbox.get("x", bbox.get("left"))
    y = bbox.get("y", bbox.get("top"))
    w = bbox.get("width")
    h = bbox.get("height")
    if None in (x, y, w, h):
        return None
    left = x / viewport_width * 100
    top = y / viewport_height * 100
    width = w / viewport_width * 100
    height = h / viewport_height * 100
    style = (
        f"position: absolute; left: {left:.3f}%; top: {top:.3f}%; "
        f"width: {width:.3f}%; height: {height:.3f}%; "
        "border: 3px solid red; box-sizing: border-box; pointer-events: none;"
    )
    return Div(style=style)


def _bbox_overlay_pct(bbox_pct):
    """A red rectangle from a manually-drawn, already-normalized bbox
    ({left, top, width, height} as 0..1 fractions of the screenshot)."""
    if not isinstance(bbox_pct, dict):
        return None
    l = bbox_pct.get("left")
    t = bbox_pct.get("top")
    w = bbox_pct.get("width")
    h = bbox_pct.get("height")
    if None in (l, t, w, h):
        return None
    style = (
        f"position: absolute; left: {l * 100:.3f}%; top: {t * 100:.3f}%; "
        f"width: {w * 100:.3f}%; height: {h * 100:.3f}%; "
        "border: 3px solid red; box-sizing: border-box; pointer-events: none;"
    )
    return Div(style=style)


def _drag_overlay(details):
    """A start->end arrow for a drag action, from normalized start_pct/end_pct
    ({x, y} as 0..1 fractions). Returns [svg_line, start_dot, end_dot] or None."""
    sp = details.get("start_pct") or {}
    ep = details.get("end_pct") or {}
    if not (isinstance(sp, dict) and isinstance(ep, dict)):
        return None
    x1, y1, x2, y2 = sp.get("x"), sp.get("y"), ep.get("x"), ep.get("y")
    if None in (x1, y1, x2, y2):
        return None
    line = NotStr(
        '<svg viewBox="0 0 100 100" preserveAspectRatio="none" '
        'style="position:absolute;left:0;top:0;width:100%;height:100%;'
        'pointer-events:none;overflow:visible;">'
        f'<line x1="{x1 * 100:.2f}" y1="{y1 * 100:.2f}" '
        f'x2="{x2 * 100:.2f}" y2="{y2 * 100:.2f}" stroke="red" '
        'stroke-width="3" vector-effect="non-scaling-stroke"/></svg>'
    )

    def dot(x, y, color):
        return Div(
            style=(
                f"position:absolute;left:{x * 100:.3f}%;top:{y * 100:.3f}%;"
                "width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;"
                f"background:{color};border:2px solid #fff;"
                "box-shadow:0 0 3px rgba(0,0,0,0.6);pointer-events:none;"
            )
        )

    # start = green, end = red (direction is start -> end).
    return [line, dot(x1, y1, "limegreen"), dot(x2, y2, "red")]


def _click_dot(x, y, viewport_width, viewport_height):
    """A small dot Div at the exact click point (always accurate, unlike the
    element bbox which can overshoot onto a big wrapper)."""
    if x is None or y is None or not viewport_width or not viewport_height:
        return None
    left = x / viewport_width * 100
    top = y / viewport_height * 100
    style = (
        f"position: absolute; left: {left:.3f}%; top: {top:.3f}%; "
        "width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; "
        "background: rgba(0,120,255,0.95); border: 2px solid #fff; "
        "box-shadow: 0 0 3px rgba(0,0,0,0.6); pointer-events: none;"
    )
    return Div(style=style)


# Injected into trajectory.html only when it is (re)rendered with a known
# session key, so the page can ask the server to drop a mis-recorded step from
# trajectory.json / trajectory.html. __SESSION__ is replaced with a JSON string.
_TRAJ_EDIT_JS = """
const MW_SESSION = __SESSION__;
async function mwDeleteStep(step){
  if(!confirm('Step '+step+' 을(를) trajectory.json / trajectory.html 에서 제외할까요?'))
    return;
  const r = await fetch('/trajectory/delete_step', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({session: MW_SESSION, step: String(step)}),
  });
  if(r.ok){ location.reload(); }
  else { alert('제외 실패: ' + (await r.text())); }
}
async function mwRestoreStep(){
  const r = await fetch('/trajectory/restore_step', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({session: MW_SESSION}),
  });
  const t = await r.text();
  if(!r.ok){ alert('되돌리기 실패: ' + t); return; }
  if(t === 'empty'){ alert('되돌릴 제외 항목이 없습니다.'); return; }
  location.reload();
}
async function mwCleanOrphans(){
  if(!confirm('어느 step도 참조하지 않는 고아 이미지(.png)를 삭제합니다.\\n'
      + '\\u26A0\\uFE0F 주의: 삭제된 png는 되돌릴 수 없고, 제외한 step의 되돌리기도 사라집니다. 계속할까요?'))
    return;
  const r = await fetch('/trajectory/clean_orphans', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({session: MW_SESSION}),
  });
  if(r.ok){ alert((await r.text()) + '개의 고아 이미지를 삭제했습니다.'); }
  else { alert('정리 실패: ' + (await r.text())); }
}
"""


def _render_trajectory_html(
    trajectory: dict, config: Optional[dict], session_key: Optional[str] = None
) -> str:
    """Build a standalone trajectory.html mirroring the benchmarks layout.

    When ``session_key`` is given, each step header gets a "제외" button that
    posts to /trajectory/delete_step so the annotator can drop mis-recorded
    steps from the saved trajectory."""
    cfg = config or {}
    title = stringify(cfg.get("task_name") or cfg.get("task_id") or "Session")
    instruction = stringify(cfg.get("instruction", ""))

    elements = [
        H1(title),
        H2("Instruction"),
        I(instruction),
        H2("Trajectory"),
    ]
    if session_key:
        trash_n = 0
        try:
            _tp = _path_under_data_dir(session_key) / "trajectory.trash.json"
            if _tp.exists():
                trash_n = len(json.loads(_tp.read_text(encoding="utf-8")))
        except Exception:
            trash_n = 0
        elements.append(
            Div(
                Button(
                    f"↩ 되돌리기{f' ({trash_n})' if trash_n else ''}",
                    onclick="mwRestoreStep()",
                    cls="secondary outline",
                    style="width: auto; padding: 0.2rem 0.8rem;"
                    + ("" if trash_n else " opacity: 0.5;"),
                ),
                Button(
                    "🧹 고아 이미지 정리",
                    onclick="mwCleanOrphans()",
                    cls="secondary outline",
                    style="width: auto; padding: 0.2rem 0.8rem;"
                    " margin-left: 0.5rem;",
                ),
                Small(
                    " 제외한 step은 되돌리기 가능 · 고아 정리하면 png 삭제 + 되돌리기 불가",
                    style="color: #64748b; margin-left: 0.5rem;",
                ),
                style="margin-bottom: 1rem;",
            )
        )

    for step_no, step in trajectory.items():
        step_details = step.get("details", {}) or {}
        details_pretty = json.dumps(step_details, ensure_ascii=False, indent=2)

        shot = step.get("screenshot")
        if not shot:
            left = P(I("(no screenshot)"))
        else:
            img = Img(src=shot, style="width: 100%; display: block;")
            # Only clicks get grounding marks (bbox box + exact click-point dot).
            # scroll/type/goto/... have no meaningful click target.
            overlays = []
            if step.get("type") in ("click", "right_click", "double_click"):
                vw = step_details.get("viewport_width")
                vh = step_details.get("viewport_height")
                # A manually-drawn bbox (normalized) wins over the auto element bbox.
                box = _bbox_overlay_pct(step_details.get("bbox_pct")) or _bbox_overlay(
                    step_details.get("bbox"), vw, vh
                )
                if box:
                    overlays.append(box)
            elif step.get("type") == "drag":
                drag = _drag_overlay(step_details)
                if drag:
                    overlays.extend(drag)
            left = (
                Div(img, *overlays, style="position: relative;")
                if overlays
                else img
            )

        # Surface the meaningful text (final answer / step title). The internal
        # "note" labels (e.g. "manual type") are not shown.
        caption = step_details.get("answer") or step_details.get("taskTitle")
        right_col = [H6("Type"), P(stringify(step.get("type")))]
        if caption:
            label = "Answer" if step_details.get("answer") else "Title"
            right_col += [H6(label), P(B(stringify(caption)))]

        # Surface what was typed / where the user clicked when present.
        typed = step_details.get("typed_value") or step_details.get("value")
        if typed:
            right_col += [H6("Typed"), P(B(stringify(typed)))]
        # Keyboard shortcut (e.g. ctrl+c) shown as a "+"-joined combo.
        keys = step_details.get("keys")
        if keys:
            combo = (
                "+".join(str(k) for k in keys)
                if isinstance(keys, list)
                else stringify(keys)
            )
            right_col += [H6("Hotkey"), P(B(combo))]
        # Only show this event's own click point (not a nested prior-page click).
        cx, cy = step_details.get("x"), step_details.get("y")
        if step.get("type") == "drag":
            x1, y1 = step_details.get("x"), step_details.get("y")
            x2, y2 = step_details.get("x2"), step_details.get("y2")
            if None not in (x1, y1, x2, y2):
                right_col += [
                    H6("Drag"),
                    P(B(
                        f"({x1:.0f}, {y1:.0f}) → ({x2:.0f}, {y2:.0f})"
                    )),
                ]
        elif cx is not None and cy is not None:
            right_col += [H6("Clicked at"), P(B(f"({cx}, {cy})"))]
        if step.get("type") == "goto" and step_details.get("url"):
            right_col += [H6("Goto URL"), P(B(stringify(step_details.get("url"))))]

        right_col += [H6("Details"), Pre(Code(details_pretty))]

        elements.append(
            Div(
                Card(
                    Div(
                        Div(left, cls="col-xs-6"),
                        Div(*right_col, cls="col-xs-6"),
                        cls="row",
                    ),
                    header=Div(
                        f"Step {step_no}",
                        Code(_format_ts(step.get("timestamp")), style="float: right;"),
                        *(
                            [
                                Button(
                                    "🗑 제외",
                                    onclick=f"mwDeleteStep('{step_no}')",
                                    cls="secondary outline",
                                    style="float: right; margin-right: 1rem;"
                                    " padding: 0.1rem 0.6rem; width: auto;",
                                )
                            ]
                            if session_key
                            else []
                        ),
                    ),
                ),
            )
        )

    css = (
        Link(
            rel="stylesheet",
            href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css",
        ),
        Link(
            rel="stylesheet",
            href="https://cdnjs.cloudflare.com/ajax/libs/flexboxgrid/6.3.1/flexboxgrid.min.css",
        ),
    )
    body_children = [Main(*elements, cls="container")]
    if session_key:
        body_children.append(
            Script(_TRAJ_EDIT_JS.replace("__SESSION__", json.dumps(session_key)))
        )
    page = Html(
        # charset so Korean renders correctly on any server (plain
        # `python -m http.server` doesn't add a charset header like FastHTML does).
        Head(Meta(charset="utf-8"), Title(title), *css),
        Body(*body_children),
    )
    return to_xml(page)


def _save_trajectory_from_gz(
    upload: UploadFile, session_dir: Path, config: Optional[dict]
) -> None:
    """Convert the uploaded gzipped event stream into trajectory.json,
    trajectory.html, and per-step screenshot images."""
    upload.file.seek(0)
    events = json.loads(gzip.decompress(upload.file.read()).decode("utf-8"))

    images_dir = session_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    # First pass: every screenshot-bearing event becomes a "frame" with its own
    # image saved. A click frame holds the RESULT state of that click (the page
    # captured shortly after, e.g. a popup that appeared).
    frames: list[dict] = []
    for ev in events:
        e = ev.get("event", {}) or {}
        shot = ev.get("screenshot") or e.get("screenshot")
        if not (isinstance(shot, str) and shot.startswith("data:image")):
            continue

        idx = len(frames) + 1
        img_name = f"frame_{idx}.png"
        (images_dir / img_name).write_bytes(
            base64.b64decode(shot.split(",", 1)[1])
        )

        details = {
            k: v for k, v in e.items()
            if k not in {"type", "timestamp", "action"}
        }
        if ev.get("html") is not None:
            details.setdefault("html", ev.get("html"))

        frames.append({
            "type": e.get("action") or e.get("type"),
            "raw_type": e.get("type"),  # real event type (e.g. "takeScreenshot")
            "timestamp": e.get("timestamp"),
            "details": details,
            "img": f"images/{img_name}",
        })

    # Clicks are captured at pointerdown, so their frame already shows the screen
    # the user clicked on (observation). Two actions are instead captured AFTER
    # they happen, so for them we use the PREVIOUS frame — matching molmoweb's
    # observe->act:
    #   - AUTO "type" (raw event "input"): captured with the field already filled,
    #     so the observation is the pre-type screen.
    #   - "goto" (raw event "load"): captured once the destination page has
    #     loaded, so the observation is the page the user navigated FROM.
    # Manual captures (raw_type "takeScreenshot") keep the screen the user chose.
    trajectory: dict[str, dict] = {}
    for i, fr in enumerate(frames):
        if (fr["raw_type"] == "input" or fr["type"] == "goto") and i > 0:
            # Copy the previous frame into this step's OWN image file so every
            # step maps 1:1 to a frame image, instead of two steps sharing one.
            prev_name = Path(frames[i - 1]["img"]).name
            shutil.copyfile(
                images_dir / prev_name, images_dir / Path(fr["img"]).name
            )
        screenshot = fr["img"]
        trajectory[str(i + 1)] = {
            "type": fr["type"],
            "timestamp": fr["timestamp"],
            "screenshot": screenshot,
            "details": fr["details"],
        }

    # Full event log (every recorded interaction, with or without a screenshot)
    # goes to metadata.json. The base64 screenshots live at the top level of
    # each entry and are excluded here to keep the file small.
    metadata = [ev.get("event", {}) or {} for ev in events]
    (session_dir / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    (session_dir / "trajectory.json").write_text(
        json.dumps(trajectory, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    session_key = session_dir.resolve().relative_to(DATA_DIR).as_posix()
    (session_dir / "trajectory.html").write_text(
        _render_trajectory_html(trajectory, config, session_key), encoding="utf-8"
    )

def _safe_archive_name(name: str) -> str:
    """Turn a user-supplied name into a safe '<name>.tar.gz' file name: drop any
    path parts and extension the user typed, keep only filesystem-safe chars,
    and fall back to a timestamped default when empty."""
    import re

    name = (name or "").strip()
    for ext in (".tar.gz", ".tgz", ".gz"):
        if name.lower().endswith(ext):
            name = name[: -len(ext)]
            break
    name = os.path.basename(name)  # strip any directory components
    # Keep letters/digits (incl. Korean), dot, underscore, hyphen; replace the
    # rest (spaces, slashes, control/special chars) with underscores.
    name = re.sub(r"[^\w.-]", "_", name, flags=re.UNICODE)
    if not name:
        name = "uploads_" + datetime.now().strftime("%Y%m%d_%H%M%S")
    return name + ".tar.gz"


def _send_uploads_to_server(name: str = "") -> tuple[bool, str]:
    """Tar+gzip the whole DATA_DIR (uploads/) and push it to a remote host over
    SSH into <remote_dir>/<name>.tar.gz (name defaults to uploads_<timestamp>),
    creating the remote directory if needed. Credentials come only from the
    environment / .env. Returns (ok, human-readable detail)."""
    import shlex
    import tarfile
    import tempfile

    host = os.environ.get("ANNOTATION_SSH_HOST")
    user = os.environ.get("ANNOTATION_SSH_USER")
    password = os.environ.get("ANNOTATION_SSH_PASSWORD")
    port = int(os.environ.get("ANNOTATION_SSH_PORT", "22"))
    remote_dir = os.environ.get(
        "ANNOTATION_SSH_REMOTE_DIR", "main-workspace/yerin_annotation"
    )
    if not (host and user and password):
        return (
            False,
            "SSH 자격증명이 없습니다. .env 에 ANNOTATION_SSH_HOST / _USER / "
            "_PASSWORD (필요시 _PORT, _REMOTE_DIR) 를 설정하세요.",
        )

    try:
        import paramiko
    except ImportError:
        return (False, "paramiko 미설치: '.venv/bin/pip install paramiko' 실행 필요.")

    archive_name = _safe_archive_name(name)
    tmp = Path(tempfile.gettempdir()) / archive_name
    remote_path = remote_dir.rstrip("/") + "/" + archive_name

    client = None
    try:
        with tarfile.open(tmp, "w:gz") as tf:
            tf.add(DATA_DIR, arcname="uploads")
        size_mb = tmp.stat().st_size / (1024 * 1024)

        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            hostname=host, port=port, username=user,
            password=password, timeout=20,
        )
        # Create the remote target dir (mkdir -p, relative to the login home).
        _, stdout, stderr = client.exec_command(
            f"mkdir -p {shlex.quote(remote_dir)}"
        )
        rc = stdout.channel.recv_exit_status()
        if rc != 0:
            return (False, f"원격 디렉토리 생성 실패: {stderr.read().decode()[:300]}")

        sftp = client.open_sftp()
        sftp.put(str(tmp), remote_path)
        sftp.close()
        return (
            True,
            f"{host}:{remote_path} 로 업로드 완료 ({size_mb:.1f} MB).",
        )
    except Exception as e:  # paramiko auth/network/etc.
        return (False, f"전송 실패: {type(e).__name__}: {e}")
    finally:
        if client is not None:
            client.close()
        tmp.unlink(missing_ok=True)


# Create the FastHTML app with specific settings
app, rt, actions, Action = fast_app(
    "actions.db",
    curr_category=str,
    curr_instruction_idx=int,
    feedback=str,
    debug=False,
    live=IS_DEVELOPMENT_ENVIRONMENT,
    hdrs=(
        picolink,
        Link(
            rel="stylesheet",
            href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.colors.min.css",
            type="text/css",
        ),
        Link(
            rel="stylesheet",
            href="https://cdnjs.cloudflare.com/ajax/libs/flexboxgrid/6.3.1/flexboxgrid.min.css",
            type="text/css",
        ),
    ),
)

# Serve saved session data (trajectory.html, images/, .webm, ...) over HTTP so
# trajectories can be viewed in the browser. Inserted at the front of the route
# table so it takes priority over FastHTML's default static-file route, which
# would otherwise serve .html/.png/.webm relative to the app dir and 404.
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles

DATA_DIR.mkdir(parents=True, exist_ok=True)
app.routes.insert(
    0, Mount("/data", app=StaticFiles(directory=str(DATA_DIR)), name="data")
)


parser = argparse.ArgumentParser(
    description="Browser annotation server (FastHTML + Chrome extension)."
)
parser.add_argument(
    "--config",
    default=os.environ.get("ANNOTATION_CONFIG", ""),
    help="Path to task JSON (see configs/example_tasks.json). "
    "Or set ANNOTATION_CONFIG.",
)
parser.add_argument(
    "--port",
    type=int,
    default=int(os.environ.get("ANNOTATION_PORT", "5001")),
    help="Listen port (default: 5001 or ANNOTATION_PORT).",
)
args = parser.parse_args()

if not (args.config or "").strip():
    raise SystemExit(
        "Missing tasks config. Pass --config /path/to/tasks.json "
        "or set ANNOTATION_CONFIG."
    )
config_path = Path(args.config).expanduser().resolve()
if not config_path.is_file():
    raise SystemExit(f"Config file not found: {config_path}")

with open(config_path, "r") as f:
    config = json.load(f)


_TASK_REQUIRED_KEYS = ("domain", "instruction", "task_name")


def _load_task_configs(raw_tasks: dict) -> dict:
    if not isinstance(raw_tasks, dict) or not raw_tasks:
        raise SystemExit('Config must include a non-empty "tasks" object.')
    out = {}
    for tid, entry in raw_tasks.items():
        if not isinstance(entry, dict):
            raise SystemExit(f'Task "{tid}": value must be a JSON object.')
        missing = [k for k in _TASK_REQUIRED_KEYS if k not in entry]
        if missing:
            raise SystemExit(
                f'Task "{tid}": missing required keys: {", ".join(missing)}. '
                f"See configs/example_tasks.json."
            )
        if "task_steps" in entry and not isinstance(entry["task_steps"], list):
            raise SystemExit(f'Task "{tid}": "task_steps" must be a JSON array.')
        out[tid] = dict(entry)
    return out


STUDY_TITLE = config.get("study_title", "Web browsing annotation")

global_stid = None
if "stid" in config:
    global_stid = config["stid"]
task_configs = _load_task_configs(config.get("tasks") or {})
session_configs = dict()


@app.get("/")
def index():
    return Titled(
        STUDY_TITLE,
        P("Available task IDs"),
        Ul(*[Li(A(f"Task ID {tid}", href=f"/{tid}")) for tid in task_configs]),
    )


def make_task_selector(
    sid: str, curr_instruction_idx: int = 0, curr_category: Optional[str] = None
):
    curr_category = session_configs[sid]["domain"]
    curr_desc = session_configs[sid]["instruction"]
    domain = session_configs[sid]["domain"]
    task_name = session_configs[sid]["task_name"]

    return Div(
        Card(
            H3("Task Details"),
            Table(
                Tr(Td(B("Domain")), Td(domain)),
                Tr(Td(B("Task Name")), Td(task_name)),
                Tr(Td(B("Instruction")), Td(curr_desc)),
                cls="striped",
            ),
            id="selected_instruction",
        ),
        id="taskSelector",
    )


def make_uploader(sid):
    return Div(
        Div(
            Br(),
            B("Recorded Data"),
            P("You may (optionally) view the recorded data below:"),
            Table(
                Tbody(
                    id="recording-contents",
                    hx_trigger="addEvent",
                    hx_post=create_recorded_event_row,
                    hx_swap="beforeend",
                    hx_vals="js:{event: event.detail?.event, screenshot: event.detail?.screenshot}",
                ),
                cls="striped",
                style="width:100%;",
            ),
            id="recorded-data-container",
        ),
        id="uploader",
    )


def FileMetaDataCard(msg="", content=None):
    if content is None:
        return Card(msg)
    return Article(
        Header(msg),
        content if content else "",
    )


@rt
def create_recorded_event_row(event: str, screenshot: Optional[str]):
    # IDK how to get htmx to send undefined as undefined so we're checking for the string "undefined" here
    if screenshot is None or len(screenshot) == 0 or screenshot == "undefined":
        img = ""
    else:
        img = Img(src=screenshot, style="max-width:100%; height:auto;")

    try:
        json_data = json.loads(event)
        json_str = json.dumps(json_data, indent=2)
    except:
        return ""

    # Render different row templates based on type of event
    event_type = json_data.get("type")
    event_timestamp = json_data.get("timestamp")
    event_video = json_data.get("video")

    # message template
    if event_type in {"sendFinalAnswer", "sendNote", "sendQuestionAndAnswer"}:
        dt = datetime.fromtimestamp(event_timestamp / 1000, timezone.utc)
        formatted_time = dt.strftime("%b %d, %Y %I:%M %p")

        if event_type == "sendFinalAnswer":
            border_color = "rgb(240, 82, 156)"
            label = "Final Answer"
            children = Div(f"Answer: {json_data.get("answer")}")
        elif event_type == "sendNote":
            border_color = "rgba(15, 203, 140, 1)"
            label = "Note"
            children = Div(f"Note: {json_data.get("note")}")
        elif event_type == "sendQuestionAndAnswer":
            border_color = "rgba(15, 203, 140, 1)"
            label = "Question & answer"
            children = Div(
                Div(f"Question: {json_data.get("question")}"),
                Div(f"Answer: {json_data.get("answer")}"),
            )

        return Tr(
            Td(
                Fieldset(
                    Legend(label, style="padding: 8px"),
                    Blockquote(formatted_time, children, style="margin: 0;"),
                    style=f"border: 1px solid {border_color};",
                ),
                style="width: 50%;",
            ),
            Td(img, style="width: 50%;"),
            style="display: flex;",
        )

    # video template
    if event_type == "send_video" and event_video is not None:
        return Tr(
            Td(
                Video(
                    Source(src=event_video, type="video/mp4"),
                    width="100%",
                    controls=True,
                ),
                style="width: 100%; margin-top: 10px;",
            ),
            style="display: flex;",
        )

    # all other events template
    return Tr(
        Td(
            Pre(Code(json_str)),
            style="width: 50%; white-space: pre-wrap; word-wrap: break-word;",
        ),
        Td(img, style="width: 50%;"),
        style="display: flex;",
    )


@rt
async def upload(request: Request):
    # multiple file upload taken from https://www.danielcorin.com/til/fasthtml/upload-multiple-images/
    form = await request.form()
    files_to_upload = cast(list[UploadFile], form.getlist("file"))
    global session_configs

    if not files_to_upload:
        return FileMetaDataCard("No files received")

    logging.getLogger("uvicorn").info(files_to_upload)

    try:
        config = None
        for file in files_to_upload:
            sid, file_extension = os.path.splitext(file.filename or "")
            config = session_configs.get(sid)
            stid_from_config = (
                config.get("study_id", "default_study")
                if config is not None
                else "default_study"
            )
            stid = (
                global_stid if global_stid is not None else stid_from_config
            )
            filename = (
                config.get("task_id", sid) if config is not None else sid
            )
            file_key = f"{stid}/{filename}{file_extension}"
            if file_extension == ".gz":
                # Convert the event stream into trajectory.json + trajectory.html
                # + per-step screenshot images instead of storing the raw .gz.
                session_dir = _path_under_data_dir(f"{stid}/{filename}")
                await asyncio.to_thread(
                    _save_trajectory_from_gz, file, session_dir, config
                )
                # Structured task metadata filled in the side panel rides along
                # with the .gz upload; persist it beside the trajectory.
                task_meta_raw = form.get("task_metadata")
                if task_meta_raw:
                    try:
                        task_meta = json.loads(task_meta_raw)
                    except (ValueError, TypeError):
                        task_meta = None
                    if isinstance(task_meta, dict) and task_meta:
                        session_dir.mkdir(parents=True, exist_ok=True)
                        (session_dir / "task_metadata.json").write_text(
                            json.dumps(task_meta, ensure_ascii=False, indent=2),
                            encoding="utf-8",
                        )
            else:
                dest = _path_under_data_dir(file_key)
                await asyncio.to_thread(_copy_upload_to_file, file, dest)

        file_key = file_key.replace(".webm", ".json").replace(".gz", ".json")
        logging.getLogger("uvicorn").info("Saved session files under %s", file_key)
        cfg_path = _path_under_data_dir(f"configs/{file_key}")

        def _write_config_snapshot() -> None:
            cfg_path.parent.mkdir(parents=True, exist_ok=True)
            cfg_path.write_text(
                json.dumps(config, indent=2), encoding="utf-8"
            )

        await asyncio.to_thread(_write_config_snapshot)

        return ""
    except ValueError as e:
        msg = str(e)
    except Exception as e:
        logging.getLogger("uvicorn").error(
            "An error occurred when uploading", exc_info=True, stack_info=True
        )
        msg = f"An error occurred: {str(e)}"

    return FileMetaDataCard(msg)


def _write_trajectory_files(session_dir: Path, session: str, trajectory: dict) -> None:
    """Persist trajectory.json and re-render trajectory.html (with edit buttons),
    loading the session's config snapshot for the title if present."""
    config = None
    try:
        cfg_path = _path_under_data_dir(f"configs/{session}.json")
        if cfg_path.exists():
            config = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (ValueError, json.JSONDecodeError):
        config = None
    (session_dir / "trajectory.json").write_text(
        json.dumps(trajectory, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (session_dir / "trajectory.html").write_text(
        _render_trajectory_html(trajectory, config, session), encoding="utf-8"
    )


@rt("/trajectory/restore_step")
def restore_step(session: str):
    """Undo the most recent step exclusion by re-inserting the last trashed step
    at its original position, then renumbering. Works until the frame image is
    removed by clean_orphans (which clears the trash)."""
    from starlette.responses import PlainTextResponse

    try:
        session_dir = _path_under_data_dir(session)
    except ValueError:
        return PlainTextResponse("invalid session", status_code=400)

    traj_path = session_dir / "trajectory.json"
    trash_path = session_dir / "trajectory.trash.json"
    if not traj_path.exists():
        return PlainTextResponse("trajectory.json not found", status_code=404)
    if not trash_path.exists():
        return PlainTextResponse("empty")
    try:
        trash = json.loads(trash_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        trash = []
    if not trash:
        return PlainTextResponse("empty")

    entry = trash.pop()  # LIFO: undo the most recent exclusion
    trajectory = json.loads(traj_path.read_text(encoding="utf-8"))
    items = [v for _, v in sorted(trajectory.items(), key=lambda kv: int(kv[0]))]
    pos = max(0, min(int(entry.get("pos", len(items))), len(items)))
    items.insert(pos, entry["step"])
    renum = {str(i + 1): v for i, v in enumerate(items)}

    if trash:
        trash_path.write_text(
            json.dumps(trash, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    else:
        trash_path.unlink(missing_ok=True)

    _write_trajectory_files(session_dir, session, renum)
    return PlainTextResponse("ok")


@rt("/trajectory/delete_step")
def delete_step(session: str, step: str):
    """Drop a mis-recorded step from a saved trajectory: remove it from
    trajectory.json, renumber the remaining steps 1..N, and re-render
    trajectory.html. Frame images and metadata.json are left untouched so the
    raw capture is never lost."""
    from starlette.responses import PlainTextResponse

    try:
        session_dir = _path_under_data_dir(session)
    except ValueError:
        return PlainTextResponse("invalid session", status_code=400)

    traj_path = session_dir / "trajectory.json"
    if not traj_path.exists():
        return PlainTextResponse("trajectory.json not found", status_code=404)

    trajectory = json.loads(traj_path.read_text(encoding="utf-8"))
    if step not in trajectory:
        return PlainTextResponse("step not found", status_code=404)

    # Remember the removed step + its position so it can be restored (undo),
    # as long as its frame image hasn't been cleaned up yet.
    ordered = sorted(trajectory.items(), key=lambda kv: int(kv[0]))
    pos = next(i for i, (k, _) in enumerate(ordered) if k == step)
    removed = trajectory[step]

    del trajectory[step]
    # Renumber remaining steps to a contiguous 1..N, preserving order.
    ordered = sorted(trajectory.items(), key=lambda kv: int(kv[0]))
    renum = {str(i + 1): v for i, (_, v) in enumerate(ordered)}

    trash_path = session_dir / "trajectory.trash.json"
    trash = []
    if trash_path.exists():
        try:
            trash = json.loads(trash_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            trash = []
    trash.append({"pos": pos, "step": removed})
    trash_path.write_text(
        json.dumps(trash, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    _write_trajectory_files(session_dir, session, renum)
    return PlainTextResponse("ok")


@rt("/trajectory/clean_orphans")
def clean_orphans(session: str):
    """Delete frame images that no remaining step references. This is
    irreversible: unlike a step exclusion (which keeps the image on disk), the
    removed .png files cannot be recovered."""
    from starlette.responses import PlainTextResponse

    try:
        session_dir = _path_under_data_dir(session)
    except ValueError:
        return PlainTextResponse("invalid session", status_code=400)

    traj_path = session_dir / "trajectory.json"
    if not traj_path.exists():
        return PlainTextResponse("trajectory.json not found", status_code=404)

    trajectory = json.loads(traj_path.read_text(encoding="utf-8"))
    referenced = {
        Path(step["screenshot"]).name
        for step in trajectory.values()
        if step.get("screenshot")
    }

    removed = 0
    images_dir = session_dir / "images"
    if images_dir.is_dir():
        for img in images_dir.glob("*.png"):
            if img.name not in referenced:
                img.unlink()
                removed += 1
    # Excluded steps can no longer be restored once their frames are gone.
    (session_dir / "trajectory.trash.json").unlink(missing_ok=True)
    return PlainTextResponse(str(removed))


@app.get("/server")
def server_form():
    """Show a small form to name the archive before sending uploads/ to the
    remote host. Visit http://127.0.0.1:5002/server."""
    default = "uploads_" + datetime.now().strftime("%Y%m%d_%H%M%S")
    return Titled(
        "Send uploads to server",
        Form(
            Label(
                "파일 이름 (.tar.gz 는 자동으로 붙습니다)",
                Input(name="name", value=default, style="width: 100%;"),
            ),
            Button("서버로 전송", type="submit"),
            method="post",
            action="/server",
        ),
        P(Small("비우면 타임스탬프 이름으로 저장됩니다. 원격 경로: "), Code(
            os.environ.get("ANNOTATION_SSH_REMOTE_DIR", "main-workspace/yerin_annotation")
        )),
    )


@app.post("/server")
async def server_send(name: str = ""):
    """Package uploads/ as <name>.tar.gz and ship it to the remote host."""
    ok, detail = await asyncio.to_thread(_send_uploads_to_server, name)
    return Titled(
        "Send uploads to server",
        P(B("✅ 성공" if ok else "❌ 실패"), style="font-size: 1.2rem;"),
        P(detail),
        P(A("← 다시 보내기", href="/server"), " · ", A("홈", href="/")),
    )


def make_steps(sid: str, num_steps: int):
    instruction = session_configs[sid]["instruction"]
    task_steps = session_configs[sid].get("task_steps", [])

    steps = [
        Div(
            Input(
                B("Step 1: "),
                "You will be completing a web browsing task specified in the instruction below. ",
                Br(),
                Br(),
                make_task_selector(
                    sid,
                    session_configs[sid].get("curr_instruction_idx", 0),
                    session_configs[sid].get("curr_category", None),
                ),
                type="checkbox",
                name="step",
                value=1,
                hx_post=f"/{sid}/steps",
                hx_target="#steps",
                hx_swap="outerHTML",
                hx_trigger="change",
                checked=num_steps > 1,
            )
        ),
        Br(),
        Div(
            Input(
                B("Step 2: "),
                "If you have installed the ",
                Code("chrome extension"),
                ", proceed to the next step.",
                Br(),
                I(
                    "If you haven't installed and enabled the extension, do so and refresh the page."
                ),
                type="checkbox",
                name="step",
                value=2,
                hx_post=f"/{sid}/steps",
                hx_target="#steps",
                hx_swap="outerHTML",
                hx_trigger="change",
                checked=num_steps > 2,
            )
        ),
        Br(),
        Div(
            Input(
                B("Step 3: "),
                "Click the ",
                Code("Start Session"),
                " button below to open a new incognito window and perform the task as per the task instruction.",
                "",
                type="checkbox",
                name="step",
                value=3,
                disabled=True,  # Disable the checkbox by default
                hx_post=f"/{sid}/steps",
                hx_target="#steps",
                hx_swap="outerHTML",
                hx_trigger="change",
                checked=num_steps > 3,
            ),
            Br(),
            Br(),
            (
                (
                    Div(
                        Button(
                            "Start Session",
                            cls="secondary col-xs-4",
                            style="width: 100%",
                            value=3,
                            name="step",
                            hx_post=f"/{sid}/steps",
                            hx_target="#steps",
                            hx_swap="outerHTML",
                            hx_trigger="click",
                            hx_on_click=f"window.postMessage({{ type: 'startSession', sessionId: {json.dumps(sid)}, instruction: {json.dumps(instruction)}, task_steps: {json.dumps(task_steps)}, uploadUrl: `${{window.location.origin}}/{upload.__name__}`}})",
                        ),
                    )
                    if num_steps == 3
                    else ""
                ),
            ),
        ),
        Br(),
        Div(
            B("Step 4: "),
            Br(),
            "Send a final answer from the side panel in the new window to finish the study.",
            Br(),
            make_uploader(sid) if num_steps == 4 else "",
            Br(),
            Br(),
            name="step",
            hx_post=f"/{sid}/steps",
            hx_target="#steps",
            hx_swap="outerHTML",
            hx_trigger="change",
        ),
    ]
    return Div(
        *steps[: 2 * num_steps],
        id="steps",
    )


@app.get("/trajectories")
def list_trajectories():
    rows = []
    for traj in sorted(DATA_DIR.glob("*/*/trajectory.html")):
        rel = traj.relative_to(DATA_DIR)
        study_id, task_id = rel.parts[0], rel.parts[1]
        rows.append(
            Li(
                A(
                    f"{study_id} / {task_id}",
                    href=f"/data/{rel.as_posix()}",
                    target="_blank",
                )
            )
        )
    body = Ul(*rows) if rows else P("No trajectories saved yet.")
    return Titled("Saved trajectories", body)


@app.get("/task_schema")
def task_schema():
    from starlette.responses import JSONResponse

    return JSONResponse(_load_task_schema())


@app.get("/{tid}")
def task_page(
    tid: str,
    pid: Optional[str] = None,
    stid: Optional[str] = None,
    sid: Optional[str] = None,
):
    if tid not in task_configs:
        return Titled("Invalid Task ID", P("Invalid Task ID"))

    if sid is None:
        sid = datetime.now().strftime("%Y%m%d%H%M%S")

    if stid is None:
        stid = "local"

    session_configs[sid] = deepcopy(task_configs[tid])
    session_configs[sid].update(
        dict(
            prolific_id=pid,
            study_id=stid or "local",
            session_id=sid,
            task_id=tid,
        )
    )

    return Container(
        make_steps(sid, 1),
        Script(
            f"""
            window.sessionEvents = [];

            window.addEventListener('message', (event) => {{
                console.log('message event', event);
                if (event.data.type === 'addEvent') {{
                    window.sessionEvents.push(event.data.data);
                    htmx.trigger('#recording-contents', 'addEvent', {{event: event.data.data.event, screenshot: event.data.data.screenshot}})
                }}
            }});
            """
        ),
    )


@app.post("/{sid}/steps")
def create_steps(sid: str, step: int):
    return make_steps(sid, step + 1)


@app.post("/{sid}/update_selector")
def update_selector(sid: str, action: Action):
    return make_task_selector(sid, 0, action.curr_category)


@app.post("/{sid}/update_instruction")
def update_instruction(sid: str, action: Action):
    curr_category = session_configs[sid]["curr_category"]
    return make_task_selector(sid, action.curr_instruction_idx, curr_category)


@app.post("/{sid}/update_feedback")
def update_feedback(sid: str, action: Action):
    session_configs[sid]["feedback"] = action.feedback
    return action.feedback


# ---------------------------------------------------------------------------
# Task metadata: the annotator fills a schema-driven form (configs/task_schema.json)
# in the extension side panel. The collected values ride along with the session
# upload and are saved as task_metadata.json in the session directory.
# ---------------------------------------------------------------------------
_SCHEMA_PATH = APP_DIR / "configs" / "task_schema.json"


def _load_task_schema() -> dict:
    try:
        return json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"common_fields": [], "task_schemas": {}}


serve(port=args.port, reload=IS_DEVELOPMENT_ENVIRONMENT)
