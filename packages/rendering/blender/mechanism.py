"""
3D mechanism kits for Shorts, rendered headless with Blender (free, local).

    blender -b --factory-startup -P mechanism.py -- spec.json

spec.json:
    {
      "kit": "crank_piston",
      "seconds": 8.0, "fps": 30, "width": 1080, "height": 1920,
      "font": "C:/.../Anton-Regular.ttf",
      "outDir": "C:/.../frames",             # PNG frames 0001.png ... are written here
      "theme": {"sky": "#8ec5ef", "sky2": "#dff0fb", "metal": "#c9ced6", "accent": "#ff7a1a", "dark": "#2b3140"},
      "rpm": 40,                               # revolutions per minute of the driving part
      "labels": [{"text": "PISTON", "part": "piston", "t0": 1.0, "t1": 8.0}],
      "camera": {"from": [..], "to": [..]}     # optional start/end camera positions (slow dolly)
    }

Every frame depends only on its index (frame-change handler), so renders are deterministic and
cacheable. A kit exposes named parts; labels point at a part by name so the script that plans a Short
never has to know coordinates. The caller times labels from the narration word timestamps.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if not argv:
    raise SystemExit("usage: blender -b -P mechanism.py -- spec.json")
with open(argv[0], encoding="utf-8") as f:
    SPEC = json.load(f)

FPS = int(SPEC.get("fps", 30))
FRAMES = max(1, int(round(float(SPEC["seconds"]) * FPS)))
W, H = int(SPEC.get("width", 1080)), int(SPEC.get("height", 1920))
THEME = {"sky": "#8ec5ef", "sky2": "#e3f2fc", "metal": "#c9ced6", "accent": "#ff7a1a", "dark": "#2b3140", "label_bg": "#1b2230", "label_fg": "#ffffff", **SPEC.get("theme", {})}


def lin(hex_color, alpha=1.0):
    h = hex_color.lstrip("#")
    s = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return (*[c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in s], alpha)


def ease_io(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- scene setup
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue
for attr, val in (("taa_render_samples", 24), ("use_shadows", True), ("use_raytracing", False)):
    try:
        setattr(scene.eevee, attr, val)
    except (AttributeError, TypeError):
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

# Sky: vertical gradient world (light at the horizon, saturated above).
world = bpy.data.worlds.new("World")
world.use_nodes = True
nt = world.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)
coord = nt.nodes.new("ShaderNodeTexCoord")
sep = nt.nodes.new("ShaderNodeSeparateXYZ")
ramp = nt.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].position, ramp.color_ramp.elements[1].position = 0.35, 0.75
ramp.color_ramp.elements[0].color, ramp.color_ramp.elements[1].color = lin(THEME["sky2"]), lin(THEME["sky"])
bg = nt.nodes.new("ShaderNodeBackground")
out = nt.nodes.new("ShaderNodeOutputWorld")
nt.links.new(coord.outputs["Generated"], sep.inputs[0])
nt.links.new(sep.outputs["Z"], ramp.inputs[0])
nt.links.new(ramp.outputs[0], bg.inputs[0])
nt.links.new(bg.outputs[0], out.inputs[0])
bg.inputs[1].default_value = 1.1
scene.world = world

sun_data = bpy.data.lights.new("Sun", "SUN")
sun_data.energy = 3.2
sun_data.angle = math.radians(25)
sun = bpy.data.objects.new("Sun", sun_data)
sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
scene.collection.objects.link(sun)

cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 50
cam_data.sensor_fit = "VERTICAL"
cam_data.sensor_width = 24
cam = bpy.data.objects.new("Camera", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

FONT = bpy.data.fonts.load(SPEC["font"]) if SPEC.get("font") and os.path.exists(SPEC["font"]) else None


def material(name, color, metallic=0.0, rough=0.45, alpha=1.0, emit=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = lin(color)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    if alpha < 1.0:
        b.inputs["Alpha"].default_value = alpha
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            try:
                setattr(m, attr, val)
            except (AttributeError, TypeError):
                pass
        m.use_backface_culling = False
    if emit:
        try:
            b.inputs["Emission Color"].default_value = lin(color)
            b.inputs["Emission Strength"].default_value = emit
        except KeyError:
            pass
    return m


def shade_smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


def cyl(name, radius, depth, loc, rot=(0, 0, 0), mat=None, verts=48):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    if mat:
        o.data.materials.append(mat)
    shade_smooth(o)
    return o


def torus(name, major, minor, loc, mat):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=48, minor_segments=12, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    shade_smooth(o)
    return o


def box(name, size, loc, mat=None, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(location=True, scale=True)
    o.location = loc
    if bevel:
        mod = o.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 3
    if mat:
        o.data.materials.append(mat)
    return o


PARTS = {}      # name -> object used as a label anchor
ANIMATORS = []


def animate(fn):
    ANIMATORS.append(fn)
    return fn


# ---------------------------------------------------------------- kit: crank_piston
# Vertical single-cylinder engine seen from the front. The crankshaft axis is Y (towards the camera),
# the piston moves along Z. Geometry is solved exactly (slider-crank), not faked.
def crank_piston():
    R, L = 0.55, 1.9                      # crank radius, rod length
    CZ = -0.7                             # crank centre height
    metal = material("Metal", THEME["metal"], metallic=0.35, rough=0.4)
    dark = material("Dark", THEME["dark"], metallic=0.4, rough=0.5)
    accent = material("Accent", THEME["accent"], metallic=0.2, rough=0.35)
    glass = material("Glass", "#bfe3ff", rough=0.05, alpha=0.12)

    box("Base", (2.5, 1.2, 0.18), (0, 0, -1.75), dark, bevel=0.04)
    sleeve = cyl("Cylinder", 0.72, 2.4, (0, 0, 1.5), mat=glass)
    torus("CylinderRimTop", 0.75, 0.07, (0, 0, 2.72), metal)
    torus("CylinderRimBot", 0.75, 0.07, (0, 0, 0.28), metal)
    PARTS["cylinder"] = sleeve

    crank = cyl("Crank", 0.78, 0.22, (0, 0, CZ), rot=(math.radians(90), 0, 0), mat=material("CrankM", "#a9b4c4", metallic=0.3, rough=0.45))
    cyl("Bearing", 0.22, 0.24, (0, 0, CZ), rot=(math.radians(90), 0, 0), mat=dark)
    pin = cyl("CrankPin", 0.1, 0.5, (R, -0.2, CZ), rot=(math.radians(90), 0, 0), mat=accent, verts=24)
    PARTS["crankshaft"] = crank

    piston = cyl("Piston", 0.66, 0.7, (0, 0, 1.6), mat=accent)
    rings = []
    for i, dz in enumerate((0.18, 0.02, -0.14)):
        rings.append((cyl(f"Ring{i}", 0.69, 0.05, (0, 0, 1.6 + dz), mat=dark), dz))
    wrist = cyl("WristPin", 0.09, 0.5, (0, -0.2, 1.6), rot=(math.radians(90), 0, 0), mat=dark, verts=24)
    PARTS["piston"] = piston

    rod = box("Rod", (0.2, 0.14, 1.0), (0, -0.2, 0.2), material("Rod", "#4f5d75", metallic=0.3, rough=0.4), bevel=0.03)   # unit length, scaled per frame
    PARTS["connecting rod"] = rod

    @animate
    def _(f):
        t = f / FPS
        th = 2 * math.pi * SPEC.get("rpm", 40) / 60.0 * t
        crank.rotation_euler = (math.radians(90), th, 0)
        px, pz = R * math.sin(th), CZ + R * math.cos(th)
        wz = pz + math.sqrt(L * L - px * px)          # wrist pin height (slider-crank solved exactly)
        pin.location = (px, -0.2, pz)
        wrist.location = (0, -0.2, wz)
        piston.location = (0, 0, wz + 0.2)
        for r, dz in rings:
            r.location = (0, 0, wz + 0.2 + dz)
        rod.location = (px / 2, -0.2, (pz + wz) / 2)
        rod.scale = (1, 1, L)
        rod.rotation_euler = (0, math.atan2(-px, wz - pz), 0)


KITS = {"crank_piston": crank_piston}
kit = SPEC.get("kit", "crank_piston")
if kit not in KITS:
    raise SystemExit(f"unknown kit {kit}")
KITS[kit]()


# ---------------------------------------------------------------- labels (billboards with leader lines)
LABELS = []
for i, lab in enumerate(SPEC.get("labels", [])):
    part = PARTS.get(lab["part"])
    if part is None:
        raise SystemExit(f"label {lab['text']!r}: kit {kit} has no part {lab['part']!r}")
    cu = bpy.data.curves.new(f"Lbl{i}", type="FONT")
    cu.body = lab["text"]
    cu.size = 0.24
    cu.align_x = "LEFT"
    cu.align_y = "CENTER"
    cu.extrude = 0.002
    if FONT:
        cu.font = FONT
    txt = bpy.data.objects.new(f"Lbl{i}", cu)
    txt.data.materials.append(material(f"LblM{i}", THEME["label_fg"], emit=1.0))
    scene.collection.objects.link(txt)
    pad = bpy.data.objects.new(f"Pad{i}", bpy.data.meshes.new(f"PadM{i}"))
    scene.collection.objects.link(pad)
    side = 1 if i % 2 == 0 else -1
    LABELS.append({"txt": txt, "pad": pad, "part": part, "t0": float(lab["t0"]), "t1": float(lab.get("t1", SPEC["seconds"])), "side": side, "i": i, "w": 0.24 * 0.42 * len(lab["text"]) + 0.34})
    # Pad (white pill) built as a simple plane behind the text.
    pad.data.from_pydata([(0, -0.2, 0), (LABELS[-1]["w"], -0.2, 0), (LABELS[-1]["w"], 0.2, 0), (0, 0.2, 0)], [], [(0, 1, 2, 3)])
    pad.data.materials.append(material(f"PadMat{i}", THEME["label_bg"], emit=1.0))
    line = bpy.data.objects.new(f"Line{i}", bpy.data.curves.new(f"LineC{i}", "CURVE"))
    line.data.dimensions = "3D"
    line.data.bevel_depth = 0.012
    sp = line.data.splines.new("POLY")
    sp.points.add(1)
    line.data.materials.append(material(f"LineM{i}", THEME["accent"], emit=1.0))
    scene.collection.objects.link(line)
    LABELS[-1]["line"] = line


REF = 12.0      # reference distance for screen-space layout (world units)
DZ = 8.0        # labels float this far in front of the camera, scaled so they look REF-sized


def place_labels(f):
    t = f / FPS
    q = cam.matrix_world.to_quaternion()
    right, up, fwd = q @ Vector((1, 0, 0)), q @ Vector((0, 1, 0)), q @ Vector((0, 0, -1))
    s = DZ / REF
    placed = []
    for L in LABELS:
        k = ease_io((t - L["t0"]) / 0.35) * (1.0 - ease_io((t - L["t1"] + 0.3) / 0.3))
        anchor = L["part"].matrix_world.translation
        rel = anchor - cam.location
        depth = max(0.1, rel.dot(fwd))
        ax, ay = rel.dot(right) * REF / depth, rel.dot(up) * REF / depth        # anchor in reference-plane units
        w = L["w"]
        px = L["side"] * (0.3 + w / 2) if L["side"] else 0
        py = ay + 0.0
        for (qx, qy) in placed:                                                  # keep pills apart vertically
            if abs(qy - py) < 0.5 and abs(qx - px) < w:
                py = qy + 0.5
        placed.append((px, py))
        left_edge = px - w / 2
        base = cam.location + fwd * DZ + right * (left_edge * s) + up * (py * s)
        for o in (L["txt"], L["pad"]):
            o.rotation_euler = cam.rotation_euler
        L["pad"].scale = (k * s, k * s, k * s)
        L["pad"].location = base
        L["txt"].scale = (k * s, k * s, k * s)
        L["txt"].location = base + right * (0.15 * s * k) - fwd * 0.01
        edge_ref = left_edge if L["side"] < 0 else left_edge
        near = (px + (w / 2 if L["side"] < 0 else -w / 2))
        edge_world = cam.location + fwd * DZ + right * (near * s) + up * (py * s)
        pts = L["line"].data.splines[0].points
        pts[0].co = (*anchor, 1.0)
        pts[1].co = (*(anchor + (edge_world - anchor) * k), 1.0)


# ---------------------------------------------------------------- camera move + frame handler
CAM = SPEC.get("camera", {})
C0 = Vector(CAM.get("from", [4.2, -11.0, 2.4]))
C1 = Vector(CAM.get("to", [2.6, -11.3, 2.0]))
TARGET = Vector(CAM.get("look", [0, 0, 0.55]))


def on_frame(scn, *_):
    f = scn.frame_current - 1
    for a in ANIMATORS:
        a(f)
    u = ease_io(f / max(1, FRAMES - 1))
    cam.location = C0.lerp(C1, u)
    direction = TARGET - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.view_layer.update()
    place_labels(f)


bpy.app.handlers.frame_change_post.clear()
bpy.app.handlers.frame_change_post.append(on_frame)
def check_collisions():
    """Sweep one full revolution; report every pair of parts that interpenetrate unless the pair is meant to touch."""
    from mathutils.bvhtree import BVHTree
    allowed = SPEC.get("allowed_contacts") or KIT_CONTACTS.get(kit, [])
    ok = {frozenset(pair) for pair in allowed}
    names = [o.name for o in bpy.data.objects if o.type == "MESH" and o.name not in KIT_IGNORE.get(kit, ())]
    steps, bad = 72, {}
    for n in range(steps):
        scene.frame_set(1 + int(n * (60.0 / SPEC.get("rpm", 40)) * FPS / steps))
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        trees = {}
        for nm in names:
            ev = bpy.data.objects[nm].evaluated_get(dg)
            me = ev.to_mesh()
            me.calc_loop_triangles()
            verts = [ev.matrix_world @ v.co for v in me.vertices]
            trees[nm] = BVHTree.FromPolygons(verts, [t.vertices[:] for t in me.loop_triangles])
            ev.to_mesh_clear()
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                if frozenset((a, b)) in ok or (a.rstrip("0123456789"), b.rstrip("0123456789")) in ok_prefix:
                    continue
                if trees[a].overlap(trees[b]):
                    bad.setdefault((a, b), []).append(n)
    for (a, b), hits in sorted(bad.items()):
        print(f"COLLISION {a} x {b}: {len(hits)}/{steps} samples")
    print("COLLISIONS_NONE" if not bad else f"COLLISIONS_FOUND {len(bad)}")


# Pairs that are supposed to touch or overlap (shared joints, parts of one assembly). Anything else is a bug.
KIT_CONTACTS = {
    "crank_piston": [
        ("Crank", "CrankPin"), ("Crank", "Bearing"), ("Rod", "CrankPin"), ("Rod", "WristPin"), ("Rod", "Piston"),
        ("WristPin", "Piston"), ("Piston", "Ring"), ("WristPin", "Ring"), ("Rod", "Ring"),
    ],
}
ok_prefix = {tuple(p) for k in KIT_CONTACTS.values() for p in k}
ok_prefix |= {(b, a) for a, b in ok_prefix}
KIT_IGNORE = {"crank_piston": ("Cylinder",)}   # the glass sleeve is a solid mesh standing in for a hollow bore

if SPEC.get("check"):
    check_collisions()
    raise SystemExit
bpy.ops.render.render(animation=True)
print("MECHANISM_OK")
