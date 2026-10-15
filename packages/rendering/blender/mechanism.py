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
from mathutils import Matrix, Vector

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
for attr, val in (("taa_render_samples", int(SPEC.get("samples", 24))), ("use_shadows", True), ("use_raytracing", False)):
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
cam_data.shift_y = float(SPEC.get("shift_y", 0.0))   # negative moves the subject up the frame (room for captions)
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
STATE = {"theta_override": None}   # degrees; set by the collision check to sweep a full cycle


def theta_deg(t):
    """Crank angle in degrees at time t: narration-timed segments ("drive") or a constant rpm."""
    if STATE["theta_override"] is not None:
        return STATE["theta_override"]
    segs = SPEC.get("drive")
    if not segs:
        return 360.0 * SPEC.get("rpm", 40) / 60.0 * t
    for sg in segs:
        if t < sg["t1"]:
            u = 0.0 if sg["t1"] <= sg["t0"] else max(0.0, (t - sg["t0"]) / (sg["t1"] - sg["t0"]))
            return sg["from"] + (sg["to"] - sg["from"]) * u
    return segs[-1]["to"]


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
        th = math.radians(theta_deg(t))
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



# ---------------------------------------------------------------- kit: four_stroke
def star_mesh(name, r_out, r_in, teeth, thickness, loc, mat):
    """Toothed wheel in the XZ plane (axis Y)."""
    pts = []
    step = 2 * math.pi / teeth
    for i in range(teeth):
        a = i * step
        for da, r in ((0.0, r_in), (0.2, r_out), (0.5, r_out), (0.7, r_in)):
            pts.append((r * math.sin(a + da * step), 0.0, r * math.cos(a + da * step)))
    me = bpy.data.meshes.new(name)
    me.from_pydata(pts, [], [list(range(len(pts)))])
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    md = ob.modifiers.new("Solid", "SOLIDIFY")
    md.thickness, md.offset = thickness, 0
    ob.location = loc
    ob.data.materials.append(mat)
    return ob


def cam_mesh(name, base, lobe, peak_deg, half_width_deg, thickness, loc, mat):
    """Cam disc: base circle plus one smooth lobe centred at angle peak_deg (from +Z towards +X)."""
    n = 96
    pts, prof = [], []
    for i in range(n):
        a = 2 * math.pi * i / n
        d = (math.degrees(a) - peak_deg + 180.0) % 360.0 - 180.0
        u = abs(d) / half_width_deg
        r = base + (lobe * math.cos(math.pi * u / 2) ** 2 if u < 1 else 0.0)
        pts.append((r * math.sin(a), 0.0, r * math.cos(a)))
        prof.append((r * math.sin(a), r * math.cos(a)))
    me = bpy.data.meshes.new(name)
    me.from_pydata(pts, [], [list(range(n))])
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    md = ob.modifiers.new("Solid", "SOLIDIFY")
    md.thickness, md.offset = thickness, 0
    ob.location = loc
    ob.data.materials.append(mat)
    return ob, prof


def helix(name, radius, turns, tube, mat):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = tube
    sp = cu.splines.new("POLY")
    n = int(turns * 16)
    sp.points.add(n)
    for i in range(n + 1):
        a = 2 * math.pi * turns * i / n
        sp.points[i].co = (radius * math.cos(a), radius * math.sin(a), i / n, 1.0)
    ob = bpy.data.objects.new(name, cu)
    ob.data.materials.append(mat)
    scene.collection.objects.link(ob)
    return ob


def hull(points):
    pts = sorted(set(points))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lo, up = [], []
    for p_ in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p_) <= 0:
            lo.pop()
        lo.append(p_)
    for p_ in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p_) <= 0:
            up.pop()
        up.append(p_)
    return lo[:-1] + up[:-1]


def blend(a, b, u):
    u = min(1.0, max(0.0, u))
    return tuple(a[i] + (b[i] - a[i]) * u for i in range(len(a)))


def four_stroke():
    R, L, CZ = 0.55, 2.2, -0.7
    HEAD_BOT, HEAD_TOP, CAM_Z = 2.77, 3.35, 3.9
    VX, SEAT = 0.42, 0.21
    BASE_R, LOBE, HALF_W = 0.24, 0.10, 60.0
    metal = material("Metal", THEME["metal"], metallic=0.35, rough=0.4)
    steel = material("Steel", "#7b879b", metallic=0.5, rough=0.35)
    dark = material("Dark", THEME["dark"], metallic=0.4, rough=0.5)
    accent = material("Accent", THEME["accent"], metallic=0.2, rough=0.35)
    glass = material("Glass", "#bfe3ff", rough=0.05, alpha=0.12)
    glass_head = material("GlassHead", "#d3e4f5", rough=0.1, alpha=0.30)
    cam_in_m = material("CamIn", "#3d8bff", metallic=0.3, rough=0.35)
    cam_ex_m = material("CamEx", "#9aa3b2", metallic=0.3, rough=0.35)

    # Block and cylinder (glass sleeve = the cutaway), open flanges.
    box("Base", (2.5, 1.2, 0.18), (0, 0, -1.75), dark, bevel=0.04)
    sleeve = cyl("Cylinder", 0.72, HEAD_BOT - 0.3, (0, 0, (HEAD_BOT + 0.3) / 2), mat=glass)
    torus("CylinderRimTop", 0.75, 0.07, (0, 0, HEAD_BOT - 0.05), metal)
    torus("CylinderRimBot", 0.75, 0.07, (0, 0, 0.3), metal)
    PARTS["cylinder"] = sleeve
    head = box("Head", (2.7, 1.5, HEAD_TOP - HEAD_BOT), (0, 0, (HEAD_BOT + HEAD_TOP) / 2), glass_head, bevel=0.03)
    PARTS["cylinder head"] = head
    pipe_in = cyl("IntakePipe", 0.17, 1.0, (-VX - 0.5 - 0.15, 0, 3.05), rot=(0, math.radians(90), 0), mat=material("PipeIn", "#9cc7ec", rough=0.2, alpha=0.35))
    pipe_ex = cyl("ExhaustPipe", 0.17, 1.0, (VX + 0.5 + 0.15, 0, 3.05), rot=(0, math.radians(90), 0), mat=material("PipeEx", "#b5b9c2", rough=0.2, alpha=0.35))
    PARTS["intake port"], PARTS["exhaust port"] = pipe_in, pipe_ex

    # Crank assembly with a rear shaft carrying the timing pulley.
    crank = cyl("Crank", 0.78, 0.22, (0, 0, CZ), rot=(math.radians(90), 0, 0), mat=material("CrankM", "#a9b4c4", metallic=0.3, rough=0.45))
    cyl("Bearing", 0.22, 0.24, (0, 0, CZ), rot=(math.radians(90), 0, 0), mat=dark)
    cyl("CrankShaft", 0.07, 1.2, (0, 0.6, CZ), rot=(math.radians(90), 0, 0), mat=steel, verts=24)
    pin = cyl("CrankPin", 0.1, 0.5, (R, -0.2, CZ), rot=(math.radians(90), 0, 0), mat=accent, verts=24)
    PARTS["crankshaft"] = crank
    PY = 1.0
    crank_pulley = star_mesh("PulleyCrank", 0.22, 0.17, 12, 0.12, (0, PY, CZ), steel)
    tick_c = cyl("TickCrank", 0.035, 0.16, (0, PY, CZ + 0.2), rot=(math.radians(90), 0, 0), mat=accent, verts=12)
    PARTS["timing belt"] = crank_pulley

    piston = cyl("Piston", 0.66, 0.7, (0, 0, 1.6), mat=accent)
    rings = [(cyl(f"Ring{i}", 0.69, 0.05, (0, 0, 1.6 + dz), mat=dark), dz) for i, dz in enumerate((0.18, 0.02, -0.14))]
    wrist = cyl("WristPin", 0.09, 0.5, (0, -0.2, 1.6), rot=(math.radians(90), 0, 0), mat=dark, verts=24)
    PARTS["piston"] = piston
    rod = box("Rod", (0.2, 0.14, 1.0), (0, -0.2, 0.2), material("Rod", "#4f5d75", metallic=0.3, rough=0.4), bevel=0.03)
    PARTS["connecting rod"] = rod

    # Camshafts (two overhead) with real lobes; pulleys at 2:1 behind the engine.
    cams = {}
    for key, sx, peak, cmat in (("in", -VX, 135.0, cam_in_m), ("ex", VX, 225.0, cam_ex_m)):
        cyl(f"CamShaft_{key}", 0.07, 1.4, (sx, 0.45, CAM_Z), rot=(math.radians(90), 0, 0), mat=steel, verts=24)
        cam, prof = cam_mesh(f"Cam_{key}", BASE_R, LOBE, peak, HALF_W, 0.22, (sx, 0, CAM_Z), cmat)
        pul = star_mesh(f"PulleyCam_{key}", 0.41, 0.36, 24, 0.12, (sx, PY, CAM_Z), steel)
        tick = cyl(f"TickCam_{key}", 0.035, 0.16, (sx, PY, CAM_Z + 0.34), rot=(math.radians(90), 0, 0), mat=accent, verts=12)
        cams[key] = {"cam": cam, "prof": prof, "pul": pul, "tick": tick, "x": sx, "peak": peak}
    PARTS["intake camshaft"], PARTS["exhaust camshaft"] = cams["in"]["cam"], cams["ex"]["cam"]
    PARTS["camshaft pulley"] = cams["in"]["pul"]

    # Timing belt: convex hull of the three pulleys, drawn as a thin tube.
    pts2 = []
    for (cx, cz, r) in ((0.0, CZ, 0.22), (-VX, CAM_Z, 0.41), (VX, CAM_Z, 0.41)):
        for i in range(36):
            a = 2 * math.pi * i / 36
            pts2.append((round(cx + (r + 0.02) * math.cos(a), 5), round(cz + (r + 0.02) * math.sin(a), 5)))
    loop = hull(pts2)
    bc = bpy.data.curves.new("Belt", "CURVE")
    bc.dimensions, bc.bevel_depth = "3D", 0.018
    sp = bc.splines.new("POLY")
    sp.points.add(len(loop) - 1)
    for i, (x, z) in enumerate(loop):
        sp.points[i].co = (x, PY, z, 1.0)
    sp.use_cyclic_u = True
    belt = bpy.data.objects.new("Belt", bc)
    belt.data.materials.append(dark)
    scene.collection.objects.link(belt)

    # Valves: head + stem + spring retainer + tappet cap move together under an empty.
    valves = {}
    for key, sx in (("in", -VX), ("ex", VX)):
        grp = bpy.data.objects.new(f"Valve_{key}", None)
        scene.collection.objects.link(grp)
        z_closed_top = CAM_Z - BASE_R                       # tappet top with the cam on its base circle
        seat_z = HEAD_BOT - 0.029                           # valve head centre when seated (0.004 clear of the head)
        stem_len = (z_closed_top - 0.03) - seat_z           # stem ends inside the tappet cap, never touching the cam
        vhead = cyl(f"ValveHead_{key}", SEAT, 0.05, (sx, 0, seat_z), mat=steel)
        stem = cyl(f"ValveStem_{key}", 0.045, stem_len, (sx, 0, seat_z + stem_len / 2), mat=steel, verts=16)
        retainer = cyl(f"Retainer_{key}", 0.14, 0.03, (sx, 0, z_closed_top - 0.1), mat=dark, verts=24)
        tappet = cyl(f"Tappet_{key}", 0.12, 0.05, (sx, 0, z_closed_top - 0.028), mat=accent, verts=24)
        for o_ in (vhead, stem, retainer, tappet):
            o_.parent = grp
        spring = helix(f"Spring_{key}", 0.09, 5, 0.012, dark)
        spring.location = (sx, 0, HEAD_TOP)
        valves[key] = {"grp": grp, "head": vhead, "spring": spring, "retainer_z": z_closed_top - 0.1}
        PARTS[f"{'intake' if key == 'in' else 'exhaust'} valve"] = vhead
        PARTS[f"{'intake' if key == 'in' else 'exhaust'} spring"] = spring

    # Spark plug (behind the cams so they never touch) and its flash.
    plug = cyl("SparkPlug", 0.07, 0.9, (0, 0.4, HEAD_TOP + 0.25), mat=material("Plug", "#e8e1d0", rough=0.5), verts=16)
    cyl("PlugTip", 0.025, 0.2, (0, 0.4, HEAD_BOT - 0.03), mat=steel, verts=12)
    PARTS["spark plug"] = plug
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.16, location=(0, 0.4, HEAD_BOT - 0.12))
    flash = bpy.context.active_object
    flash.name = "SparkFlash"
    flash.data.materials.append(material("Flash", "#fff3b0", emit=6.0))

    # Gas in the chamber (unit cylinder, origin at its base, scaled to the gap above the piston).
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.70, depth=1.0, location=(0, 0, 0))
    gas = bpy.context.active_object
    gas.name = "Gas"
    gas.data.transform(Matrix.Translation((0, 0, 0.5)))
    gas_mat = material("GasM", "#9fd8ff", rough=0.2, alpha=0.25, emit=0.4)
    gas.data.materials.append(gas_mat)
    gas_bsdf = gas_mat.node_tree.nodes["Principled BSDF"]
    PARTS["fuel-air mixture"] = gas

    # Flow particles along fixed paths (intake in, exhaust out).
    paths = {
        "in": [(-VX - 1.15, 0.0, 3.05), (-VX, 0.0, 3.05), (-VX, 0.0, HEAD_BOT - 0.3), (-VX + 0.15, 0.0, 2.3)],
        "ex": [(VX + 0.15, 0.0, 2.3), (VX, 0.0, HEAD_BOT - 0.3), (VX, 0.0, 3.05), (VX + 1.15, 0.0, 3.05)],
    }
    parts_mat = {"in": material("PIn", "#66b7ff", emit=2.0), "ex": material("PEx", "#8a8f99", emit=0.6)}
    flow = {"in": [], "ex": []}
    for key in ("in", "ex"):
        for i in range(14):
            bpy.ops.mesh.primitive_uv_sphere_add(radius=0.075, location=(0, 0, 0), segments=12, ring_count=8)
            o_ = bpy.context.active_object
            o_.name = f"Particle_{key}{i}"
            o_.data.materials.append(parts_mat[key])
            flow[key].append((o_, i / 14.0, ((i * 37) % 11 - 5) * 0.03))

    def along(path, s):
        seg = [(path[i], path[i + 1]) for i in range(len(path) - 1)]
        lens = [(Vector(b) - Vector(a)).length for a, b in seg]
        d = s * sum(lens)
        for (a, b), ln in zip(seg, lens):
            if d <= ln:
                return Vector(a).lerp(Vector(b), d / ln if ln else 0)
            d -= ln
        return Vector(path[-1])

    def lowest(cam_info, psi):
        """Valve drive from the cam geometry: lowest point of the rotated cam profile (flat follower)."""
        c, sn = math.cos(psi), math.sin(psi)
        return min(-x * sn + z * c for (x, z) in cam_info["prof"])

    STROKE_COL = [  # theta_start, rgb, alpha, emission
        (0.0, (0.62, 0.85, 1.0), 0.22, 0.4), (180.0, (0.62, 0.85, 1.0), 0.30, 0.4),
        (360.0, (1.0, 0.82, 0.48), 0.62, 0.8), (366.0, (1.0, 0.35, 0.12), 0.80, 3.0),
        (540.0, (0.70, 0.38, 0.25), 0.42, 0.5), (590.0, (0.55, 0.56, 0.60), 0.30, 0.1), (719.9, (0.55, 0.56, 0.60), 0.14, 0.1),
    ]

    @animate
    def _(f):
        t = f / FPS
        deg = theta_deg(t)
        th = math.radians(deg)
        u = deg % 720.0
        crank.rotation_euler = (math.radians(90), th, 0)
        crank_pulley.rotation_euler = (0, th, 0)
        tick_c.location = (math.sin(th) * 0.2, PY, CZ + math.cos(th) * 0.2)
        px, pz = R * math.sin(th), CZ + R * math.cos(th)
        wz = pz + math.sqrt(L * L - px * px)
        pin.location = (px, -0.2, pz)
        wrist.location = (0, -0.2, wz)
        piston.location = (0, 0, wz + 0.2)
        for r_, dz in rings:
            r_.location = (0, 0, wz + 0.2 + dz)
        rod.location = (px / 2, -0.2, (pz + wz) / 2)
        rod.scale = (1, 1, L)
        rod.rotation_euler = (0, math.atan2(-px, wz - pz), 0)

        # Camshafts turn at half crank speed; each valve follows its cam's lowest point.
        psi = th / 2.0
        lifts = {}
        for key, info in cams.items():
            info["cam"].rotation_euler = (0, psi, 0)
            info["pul"].rotation_euler = (0, psi, 0)
            info["tick"].location = (info["x"] + math.sin(psi) * 0.34, PY, CAM_Z + math.cos(psi) * 0.34)
            dz = lowest(info, psi) + BASE_R                 # <= 0: tappet drops when the lobe points down
            lifts[key] = -dz
            v = valves[key]
            v["grp"].location = (0, 0, dz)
            v["spring"].scale = (1, 1, max(0.02, (v["retainer_z"] + dz) - HEAD_TOP))

        top = wz + 0.2 + 0.35
        gas.location = (0, 0, top)
        gas.scale = (1, 1, max(0.02, HEAD_BOT - top))
        k = max(i for i, row in enumerate(STROKE_COL) if row[0] <= u)
        a, b = STROKE_COL[k], STROKE_COL[min(k + 1, len(STROKE_COL) - 1)]
        w = 0 if b[0] == a[0] else (u - a[0]) / (b[0] - a[0])
        col = blend(a[1], b[1], w)
        gas_bsdf.inputs["Base Color"].default_value = (*[c ** 2.2 for c in col], 1.0)
        gas_bsdf.inputs["Alpha"].default_value = a[2] + (b[2] - a[2]) * w
        try:
            gas_bsdf.inputs["Emission Color"].default_value = (*[c ** 2.2 for c in col], 1.0)
            gas_bsdf.inputs["Emission Strength"].default_value = a[3] + (b[3] - a[3]) * w
        except KeyError:
            pass
        sk = max(0.0, 1.0 - abs(((deg - 360.0 + 360.0) % 720.0) - 360.0) / 14.0)   # spark pulse at 360 deg
        flash.scale = (sk, sk, sk)

        for key in ("in", "ex"):
            vis = min(1.0, max(0.0, (lifts[key] - 0.01) / 0.05))
            for o_, off, jit in flow[key]:
                s_ = (off + deg / 360.0 * 0.5) % 1.0
                pos = along(paths[key], s_)
                o_.location = (pos.x + jit * 0.5, jit, pos.z)
                o_.scale = (vis, vis, vis)


KITS = {"crank_piston": crank_piston, "four_stroke": four_stroke}
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
    cu.size = 0.17
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
    LABELS.append({"txt": txt, "pad": pad, "part": part, "t0": float(lab["t0"]), "t1": float(lab.get("t1", SPEC["seconds"])), "side": side, "i": i, "w": 0.17 * 0.42 * len(lab["text"]) + 0.3})
    # Pad (white pill) built as a simple plane behind the text.
    pad.data.from_pydata([(0, -0.14, 0), (LABELS[-1]["w"], -0.14, 0), (LABELS[-1]["w"], 0.14, 0), (0, 0.14, 0)], [], [(0, 1, 2, 3)])
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
        px = L["side"] * (1.5 - w / 2) if L["side"] else 0
        py = ay + 0.0
        for (qx, qy) in placed:                                                  # keep pills apart vertically
            if abs(qy - py) < 0.4 and abs(qx - px) < w:
                py = qy + 0.38
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
    keys = SPEC.get("camera_keys")
    if keys:
        t = f / FPS
        a_ = b_ = keys[0] if t < keys[0]["t"] else keys[-1]
        for i_ in range(len(keys) - 1):
            if keys[i_]["t"] <= t <= keys[i_ + 1]["t"]:
                a_, b_ = keys[i_], keys[i_ + 1]
                break
        u = 1.0 if b_["t"] <= a_["t"] else ease_io((t - a_["t"]) / (b_["t"] - a_["t"]))
        cam.location = Vector(a_["pos"]).lerp(Vector(b_["pos"]), u)
        direction = Vector(a_["look"]).lerp(Vector(b_["look"]), u) - cam.location
    else:
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
    names = [o.name for o in bpy.data.objects if o.type == "MESH" and o.name not in KIT_IGNORE.get(kit, ()) and not o.name.startswith(KIT_PREFIX_IGNORE)]
    cycle = 720.0 if kit == "four_stroke" else 360.0
    steps, bad = (144 if kit == "four_stroke" else 72), {}
    for n in range(steps):
        STATE["theta_override"] = cycle * n / steps
        scene.frame_set(1 + n % 2)
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
    "four_stroke": [
        ("Crank", "CrankPin"), ("Crank", "Bearing"), ("Crank", "CrankShaft"), ("Bearing", "CrankShaft"), ("CrankShaft", "PulleyCrank"),
        ("Rod", "CrankPin"), ("Rod", "WristPin"), ("Rod", "Piston"), ("WristPin", "Piston"), ("Piston", "Ring"), ("WristPin", "Ring"), ("Rod", "Ring"),
        ("CamShaft_in", "Cam_in"), ("CamShaft_ex", "Cam_ex"), ("CamShaft_in", "PulleyCam_in"), ("CamShaft_ex", "PulleyCam_ex"),
        ("ValveHead_in", "ValveStem_in"), ("ValveHead_ex", "ValveStem_ex"), ("ValveStem_in", "Retainer_in"), ("ValveStem_ex", "Retainer_ex"),
        ("ValveStem_in", "Tappet_in"), ("ValveStem_ex", "Tappet_ex"), ("Retainer_in", "Tappet_in"), ("Retainer_ex", "Tappet_ex"),
        ("ValveStem_in", "Head"), ("ValveStem_ex", "Head"), ("CylinderRimTop", "Head"), ("SparkPlug", "Head"), ("SparkPlug", "PlugTip"), ("PlugTip", "Head"),
        ("TickCrank", "PulleyCrank"), ("TickCam_in", "PulleyCam_in"), ("TickCam_ex", "PulleyCam_ex"),
        ("CamShaft_in", "TickCam_in"), ("CamShaft_ex", "TickCam_ex"),
    ],
    "crank_piston": [
        ("Crank", "CrankPin"), ("Crank", "Bearing"), ("Rod", "CrankPin"), ("Rod", "WristPin"), ("Rod", "Piston"),
        ("WristPin", "Piston"), ("Piston", "Ring"), ("WristPin", "Ring"), ("Rod", "Ring"),
    ],
}
ok_prefix = {tuple(p) for k in KIT_CONTACTS.values() for p in k}
ok_prefix |= {(b, a) for a, b in ok_prefix}
KIT_IGNORE = {   # glass sleeve = solid stand-in for a hollow bore; the rest are visual effects
    "crank_piston": ("Cylinder",),
    "four_stroke": ("Cylinder", "Gas", "SparkFlash", "IntakePipe", "ExhaustPipe"),
}
KIT_PREFIX_IGNORE = ("Pad", "Lbl", "Particle")

if SPEC.get("check"):
    check_collisions()
    raise SystemExit
if SPEC.get("stills"):
    scene.render.resolution_percentage = int(SPEC.get("stills_scale", 50))
    for ts in SPEC["stills"]:
        scene.frame_set(1 + int(round(ts * FPS)))
        scene.render.filepath = os.path.join(SPEC["outDir"], f"still_{ts:07.2f}.png")
        bpy.ops.render.render(write_still=True)
    print("MECHANISM_OK")
    raise SystemExit
bpy.ops.render.render(animation=True)
print("MECHANISM_OK")
