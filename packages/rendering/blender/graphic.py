"""
Motion-graphics templates for YouTube Shorts, rendered headless with Blender (free, local).

    blender -b --factory-startup -P graphic.py -- spec.json

spec.json:
    {
      "template": "stat" | "compare" | "process" | "keyword",
      "seconds": 2.6, "fps": 30, "width": 1080, "height": 1920,
      "font": "C:/.../Anton-Regular.ttf",
      "outDir": "C:/.../frames",            # PNG frames 0001.png ... are written here
      "theme": {"bg": "#0d1b2a", "bg2": "#1b263b", "accent": "#ffb703", "text": "#ffffff", "muted": "#9fb3c8"},
      "stat":    {"value": "617,000", "label": "U.S. bridges"},
      "compare": {"items": [{"label": "Cars", "value": 3, "display": "3 s"}, ...]},
      "process": {"steps": ["Wheel hits gap", "Rail flexes", "Clack"]},
      "keyword": {"text": "Wind shear"}
    }

Layout keeps every element between 300 px and 1050 px from the top of the 1080x1920 frame, so the
title card (top) and word captions (lower middle) never cover it. Everything is animated from a
frame-change handler (no keyframes), so a frame depends only on its index: renders are
deterministic and cacheable.
"""
import json
import math
import os
import re
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if not argv:
    raise SystemExit("usage: blender -b -P graphic.py -- spec.json")
with open(argv[0], encoding="utf-8") as f:
    SPEC = json.load(f)

FPS = int(SPEC.get("fps", 30))
FRAMES = max(1, int(round(float(SPEC["seconds"]) * FPS)))
W, H = int(SPEC.get("width", 1080)), int(SPEC.get("height", 1920))
THEME = {"bg": "#0d1b2a", "bg2": "#1b263b", "accent": "#ffb703", "text": "#ffffff", "muted": "#9fb3c8", "panel": "#2b4162", **SPEC.get("theme", {})}
U = 100.0  # pixels per Blender unit (orthographic camera, see setup_camera)


def rgb(hex_color, alpha=1.0):
    h = hex_color.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    # Colours are given in sRGB; materials work in linear.
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, alpha)


def py(px_from_top):
    """Pixel row (from the top of the frame) to Blender Y."""
    return (H / 2 - px_from_top) / U


def ease_out(t):
    t = min(1.0, max(0.0, t))
    return 1 - (1 - t) ** 3


def ease_back(t):
    t = min(1.0, max(0.0, t))
    c1, c3 = 1.70158, 2.70158
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


# ---------------------------------------------------------------- scene setup
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue
try:
    scene.eevee.taa_render_samples = 8
except AttributeError:
    pass
scene.render.resolution_x, scene.render.resolution_y = W, H
scene.render.resolution_percentage = 100
scene.render.fps = FPS
scene.frame_start, scene.frame_end = 1, FRAMES
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"
scene.render.filepath = os.path.join(SPEC["outDir"], "")
try:
    scene.view_settings.view_transform = "Standard"
except TypeError:
    pass

world = bpy.data.worlds.new("World")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = rgb(THEME["bg"])
scene.world = world

cam_data = bpy.data.cameras.new("Camera")
cam_data.type = "ORTHO"
cam_data.ortho_scale = H / U  # the larger dimension (height) spans ortho_scale units
cam = bpy.data.objects.new("Camera", cam_data)
cam.location = (0, 0, 10)
scene.collection.objects.link(cam)
scene.camera = cam

FONT = bpy.data.fonts.load(SPEC["font"]) if SPEC.get("font") and os.path.exists(SPEC["font"]) else None


def material(name, color):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs[0].default_value = color
    em.inputs[1].default_value = 1.0
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(em.outputs[0], out.inputs[0])
    return m


def rect(name, w_px, h_px, x_px, y_top_px, color, z=0.0):
    """Rectangle anchored at its bottom-centre; x_px from frame centre, y_top_px = its bottom edge from the top."""
    mesh = bpy.data.meshes.new(name)
    hw = w_px / U / 2
    mesh.from_pydata([(-hw, 0, 0), (hw, 0, 0), (hw, h_px / U, 0), (-hw, h_px / U, 0)], [], [(0, 1, 2, 3)])
    obj = bpy.data.objects.new(name, mesh)
    obj.location = (x_px / U, py(y_top_px), z)
    obj.data.materials.append(material(name + "M", color))
    scene.collection.objects.link(obj)
    return obj


def text(name, body, size_px, x_px, y_center_px, color, z=0.1, align="CENTER"):
    cu = bpy.data.curves.new(name, type="FONT")
    cu.body = body
    cu.size = size_px / U
    cu.align_x = align
    cu.align_y = "CENTER"
    if FONT:
        cu.font = FONT
    obj = bpy.data.objects.new(name, cu)
    obj.location = (x_px / U, py(y_center_px), z)
    obj.data.materials.append(material(name + "M", color))
    scene.collection.objects.link(obj)
    return obj


def fit_size(body, max_px_width, size_px):
    """Rough width estimate for a condensed display font (Anton measured at ~0.3 em per character)."""
    est = 0.32 * size_px * max(1, len(body))
    return size_px if est <= max_px_width else max(40, size_px * max_px_width / est)


# ---------------------------------------------------------------- background
# Diagonal gradient band plus a slowly drifting dot grid: designed-looking, and enough fine detail
# that the frame never reads as an empty backdrop.
rect("BgBand", 1600, 900, 0, 1250, rgb(THEME["bg2"]), z=-1.0).rotation_euler = (0, 0, math.radians(-12))
DOTS = []
for gy in range(0, 21):
    for gx in range(-6, 7):
        d = rect(f"Dot{gx}_{gy}", 6, 6, gx * 90, gy * 96, rgb(THEME["muted"], 1.0), z=-0.5)
        DOTS.append((d, d.location.x, d.location.y))
ACCENT_LINE = rect("AccentLine", 10, 10, 0, 1010, rgb(THEME["accent"]), z=0.05)

ANIMATORS = []


def animate(fn):
    ANIMATORS.append(fn)
    return fn


@animate
def _background(f):
    t = f / FPS
    for d, x0, y0 in DOTS:
        d.location.x = x0 + 0.12 * math.sin(t * 0.6 + y0)
        d.location.y = y0 - 0.25 * t
    ACCENT_LINE.scale.x = 1 + 59 * ease_out(t / 0.6)


# ---------------------------------------------------------------- templates
NUM = re.compile(r"^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$")


def stat(cfg):
    value = str(cfg["value"]).strip()
    label = str(cfg.get("label", "")).strip().upper()
    size = fit_size(value, 960, 420)
    num = text("Value", value, size, 0, 620, rgb(THEME["accent"]))
    lab = text("Label", label, fit_size(label, 940, 120), 0, 880, rgb(THEME["text"])) if label else None
    m = NUM.match(value)

    @animate
    def _(f):
        t = f / FPS
        k = ease_out(t / 0.9)
        if m:
            pre, digits, suf = m.groups()
            target = float(digits.replace(",", ""))
            decimals = len(digits.split(".")[1]) if "." in digits else 0
            cur = target * k
            s = f"{cur:,.{decimals}f}" if "," in digits else f"{cur:.{decimals}f}"
            num.data.body = f"{pre}{s}{suf}"
        sc = 0.6 + 0.4 * ease_back(t / 0.5)
        num.scale = (sc, sc, 1)
        if lab:
            a = ease_out((t - 0.35) / 0.4)
            lab.location.y = py(880) - (1 - a) * 0.6
            lab.scale = (a, a, 1)


def compare(cfg):
    items = cfg["items"][:3]
    vmax = max(float(i["value"]) for i in items) or 1.0
    n = len(items)
    gap = 900 / n
    bars = []
    for k, it in enumerate(items):
        x = -450 + gap * (k + 0.5)
        full = 520 * float(it["value"]) / vmax
        bar = rect(f"Bar{k}", gap * 0.62, max(full, 8), x, 900, rgb(THEME["accent"] if k == 0 else THEME["muted"]))
        val = text(f"Val{k}", str(it.get("display", it["value"])), fit_size(str(it.get("display", it["value"])), gap * 0.95, 100), x, 900 - full - 60, rgb(THEME["text"]))
        lab = text(f"Lab{k}", str(it["label"]).upper(), fit_size(str(it["label"]), gap * 0.95, 80), x, 960, rgb(THEME["text"]))
        bars.append((bar, val, lab, full, k))

    @animate
    def _(f):
        t = f / FPS
        for bar, val, lab, full, k in bars:
            a = ease_out((t - 0.15 * k) / 0.8)
            bar.scale.y = max(0.001, a)
            val.location.y = py(900) + (full * a + 60) / U
            v = ease_out((t - 0.15 * k - 0.5) / 0.3)
            val.scale = (v, v, 1)


def process(cfg):
    steps = [str(s).upper() for s in cfg["steps"][:4]]
    n = len(steps)
    top, bottom = 380, 1000
    pitch = (bottom - top) / max(1, n)
    parts = []
    for k, s in enumerate(steps):
        y = top + pitch * (k + 0.5)
        box = rect(f"Box{k}", 860, pitch * 0.66, 0, y + pitch * 0.33, rgb(THEME["panel"]), z=0.0)
        edge = rect(f"Edge{k}", 16, pitch * 0.66, -430, y + pitch * 0.33, rgb(THEME["accent"]), z=0.02)
        lab = text(f"Step{k}", s, fit_size(s, 760, 96), 0, y, rgb(THEME["text"]))
        arrow = text(f"Arrow{k}", "\u2193", 80, 0, y + pitch * 0.5, rgb(THEME["accent"])) if k < n - 1 else None
        parts.append((box, edge, lab, arrow, k))
    per = max(0.35, min(0.8, (FRAMES / FPS - 0.3) / max(1, n)))

    @animate
    def _(f):
        t = f / FPS
        for box, edge, lab, arrow, k in parts:
            a = ease_back((t - per * k) / 0.35)
            for o in (box, edge, lab):
                o.scale = (max(0.001, a), max(0.001, a), 1)
            if arrow:
                b = ease_out((t - per * k - 0.25) / 0.3)
                arrow.scale = (max(0.001, b), max(0.001, b), 1)


def keyword(cfg):
    body = str(cfg["text"]).upper()
    words = body.split()
    lines = [" ".join(words[i:i + 2]) for i in range(0, len(words), 2)] if len(body) > 12 else [body]
    objs = []
    for k, line in enumerate(lines[:3]):
        y = 640 + (k - (len(lines) - 1) / 2) * 240
        objs.append((text(f"Kw{k}", line, fit_size(line, 960, 260), 0, y, rgb(THEME["accent"] if k == 0 else THEME["text"])), k))

    @animate
    def _(f):
        t = f / FPS
        for o, k in objs:
            a = ease_back((t - 0.12 * k) / 0.45)
            o.scale = (max(0.001, a), max(0.001, a), 1)


TEMPLATES = {"stat": stat, "compare": compare, "process": process, "keyword": keyword}
tpl = SPEC["template"]
if tpl not in TEMPLATES:
    raise SystemExit(f"unknown template {tpl}")
TEMPLATES[tpl](SPEC.get(tpl, {}))


def on_frame(scn, *_):
    f = scn.frame_current - 1
    for fn in ANIMATORS:
        fn(f)


bpy.app.handlers.frame_change_pre.append(on_frame)
os.makedirs(SPEC["outDir"], exist_ok=True)
bpy.ops.render.render(animation=True)
print(f"GRAPHIC_OK {FRAMES} frames")
