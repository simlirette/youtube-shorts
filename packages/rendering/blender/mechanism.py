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


# ---------------------------------------------------------------- studio look (style: "studio")
STUDIO = SPEC.get("style") == "studio"


def studio_environment_image():
    """Procedural studio HDRI: dim grey room with a warm key softbox, a cool rim softbox, a broad fill and a top strip.
    It only lights and reflects off the metal; the camera sees a plain grey backdrop (see Light Path in the world)."""
    from array import array
    w_, h_ = 1024, 512
    boxes = [  # u0, v0, half-width u, half-height v, intensity, rgb
        (0.86, 0.64, 0.08, 0.20, 14.0, (1.0, 0.93, 0.84)),
        (0.39, 0.60, 0.07, 0.15, 10.0, (0.78, 0.88, 1.0)),
        (0.66, 0.56, 0.140, 0.10, 4.5, (1.0, 1.0, 1.0)),
        (0.12, 0.58, 0.060, 0.10, 2.0, (1.0, 0.97, 0.92)),
    ]
    px = array("f", [0.0]) * (w_ * h_ * 4)
    for y in range(h_):
        v = (y + 0.5) / h_
        base = 0.62 - 0.25 * max(0.0, v - 0.5) * 2 if v >= 0.5 else 0.62 - 0.10 * (0.5 - v) * 2
        top = 4.0 * max(0.0, min(1.0, (v - 0.80) / 0.12))
        for x in range(w_):
            u = (x + 0.5) / w_
            r = g = b = base + top * 0.6
            for (u0, v0, su, sv, inten, col) in boxes:
                du = abs(u - u0)
                du = min(du, 1.0 - du)
                s = (du / su) ** 4 + (abs(v - v0) / sv) ** 4
                if s < 4.0:
                    k = inten * math.exp(-s * 2.5)
                    r += k * col[0]
                    g += k * col[1]
                    b += k * col[2]
            i = (y * w_ + x) * 4
            px[i], px[i + 1], px[i + 2], px[i + 3] = r, g, b, 1.0
    img = bpy.data.images.new("studio_env", w_, h_, alpha=False, float_buffer=True)
    img.pixels.foreach_set(px)
    try:
        img.colorspace_settings.name = "Linear Rec.709"
    except TypeError:
        pass
    img.update()
    return img


def area_light(name, loc, target, size, energy, color):
    ld = bpy.data.lights.new(name, "AREA")
    ld.size, ld.energy, ld.color = size, energy, color
    try:
        ld.use_shadow = True
    except AttributeError:
        pass
    ob = bpy.data.objects.new(name, ld)
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(ob)
    return ob


def studio_setup():
    # World: environment image for light and reflections, plain grey for what the camera sees.
    wnt = world.node_tree
    for n_ in list(wnt.nodes):
        wnt.nodes.remove(n_)
    lp = wnt.nodes.new("ShaderNodeLightPath")
    env = wnt.nodes.new("ShaderNodeTexEnvironment")
    env.image = studio_environment_image()
    bg_env = wnt.nodes.new("ShaderNodeBackground")
    bg_env.inputs[1].default_value = 1.0
    coord_ = wnt.nodes.new("ShaderNodeTexCoord")
    sep_ = wnt.nodes.new("ShaderNodeSeparateXYZ")
    ramp_ = wnt.nodes.new("ShaderNodeValToRGB")
    ramp_.color_ramp.elements[0].position, ramp_.color_ramp.elements[1].position = 0.40, 0.70
    ramp_.color_ramp.elements[0].color, ramp_.color_ramp.elements[1].color = lin("#9a9791"), lin("#55565a")
    bg_cam = wnt.nodes.new("ShaderNodeBackground")
    mix = wnt.nodes.new("ShaderNodeMixShader")
    out_ = wnt.nodes.new("ShaderNodeOutputWorld")
    wnt.links.new(env.outputs[0], bg_env.inputs[0])
    wnt.links.new(coord_.outputs["Generated"], sep_.inputs[0])
    wnt.links.new(sep_.outputs["Z"], ramp_.inputs[0])
    wnt.links.new(ramp_.outputs[0], bg_cam.inputs[0])
    wnt.links.new(lp.outputs["Is Camera Ray"], mix.inputs[0])
    wnt.links.new(bg_env.outputs[0], mix.inputs[1])
    wnt.links.new(bg_cam.outputs[0], mix.inputs[2])
    wnt.links.new(mix.outputs[0], out_.inputs[0])

    bpy.data.objects.remove(sun)
    # Lights placed where the HDRI softboxes are, so shadows fall the way the reflections say.
    area_light("Key", (-6.5, -8.5, 7.5), (0, 0, 1.2), 6.0, float(SPEC.get("key_energy", 2600)), (1.0, 0.94, 0.86))
    area_light("Rim", (8.0, 6.5, 6.0), (0, 0, 1.5), 4.0, float(SPEC.get("rim_energy", 2000)), (0.78, 0.88, 1.0))
    area_light("Fill", (5.0, -12.0, 3.0), (0, 0, 1.2), 10.0, float(SPEC.get("fill_energy", 1100)), (1.0, 1.0, 1.0))

    # Floor.
    bpy.ops.mesh.primitive_plane_add(size=120, location=(0, 0, -1.84))
    fl = bpy.context.active_object
    fl.name = "Floor"
    fl.data.materials.append(material("FloorM", "#9b9892", metallic=0.0, rough=0.7, emit=0.55))

    cam_data.dof.use_dof = True
    cam_data.dof.aperture_fstop = float(SPEC.get("fstop", 4.5))
    for vt in ("AgX", "Filmic", "Standard"):
        try:
            scene.view_settings.view_transform = vt
            break
        except TypeError:
            continue
    scene.view_settings.exposure = float(SPEC.get("exposure", 0.6))
    try:
        scene.view_settings.look = "AgX - Medium High Contrast" if scene.view_settings.view_transform == "AgX" else "None"
    except TypeError:
        pass
    for attr, val in (("use_raytracing", False), ("use_shadows", True)):
        try:
            setattr(scene.eevee, attr, val)
        except (AttributeError, TypeError):
            pass


def micro(mat, scale=300.0, strength=0.04):
    """Brushed/machined micro-relief for metals."""
    nt_ = mat.node_tree
    b_ = nt_.nodes["Principled BSDF"]
    noise = nt_.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = 4.0
    bump = nt_.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    nt_.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt_.links.new(bump.outputs["Normal"], b_.inputs["Normal"])
    return mat


if STUDIO:
    studio_setup()


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



def tube_shell(name, r_in, r_out, z0, z1, a0, a1, mat, seg=56):
    """Sectioned tube (a barrel cut open along its axis): outer wall, inner wall, end rings and the two cut faces."""
    import bmesh
    verts, faces = [], []
    for i in range(seg + 1):
        a = a0 + (a1 - a0) * i / seg
        c, s_ = math.cos(a), math.sin(a)
        verts += [(r_out * c, r_out * s_, z0), (r_out * c, r_out * s_, z1), (r_in * c, r_in * s_, z1), (r_in * c, r_in * s_, z0)]
    for i in range(seg):
        b0, b1 = 4 * i, 4 * (i + 1)
        faces += [(b0, b1, b1 + 1, b0 + 1), (b0 + 2, b0 + 3, b1 + 3, b1 + 2), (b0 + 1, b1 + 1, b1 + 2, b0 + 2), (b0 + 3, b1 + 3, b1, b0)]
    last = 4 * seg
    faces += [(0, 1, 2, 3), (last + 3, last + 2, last + 1, last)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    for p_ in ob.data.polygons:
        p_.use_smooth = True
    return ob


def hole(slab, x, y, r, z, depth=0.6):
    """Cut a round hole through a slab with a boolean (the cutter is never rendered)."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=40, radius=r, depth=depth, location=(x, y, z))
    cutter = bpy.context.active_object
    cutter.name = f"Cutter_{slab.name}_{len(slab.modifiers)}"
    cutter.hide_render = True
    cutter.display_type = "WIRE"
    md = slab.modifiers.new("Hole", "BOOLEAN")
    md.object = cutter
    md.operation = "DIFFERENCE"
    md.solver = "EXACT"
    return cutter


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
    if STUDIO:
        steel = micro(material("Steel", "#d3d6dc", metallic=1.0, rough=0.24), 420, 0.03)
        dark = micro(material("DarkSteel", "#9aa0aa", metallic=0.7, rough=0.40), 300, 0.03)
        cast = material("CastIron", "#b9bec6", metallic=0.45, rough=0.52)
        alu = micro(material("Alu", "#d6d9de", metallic=1.0, rough=0.32), 500, 0.04)
        black = material("Black", "#17181b", metallic=0.2, rough=0.5)
        brass = material("Brass", "#b8935a", metallic=1.0, rough=0.3)
        ceramic = material("Ceramic", "#efebe0", metallic=0.0, rough=0.35)
        mark = material("Mark", "#f4f4f2", metallic=0.0, rough=0.4, emit=0.6)
        cam_in_m = micro(material("CamIn", "#7d9cc0", metallic=1.0, rough=0.34), 300, 0.03)
        cam_ex_m = micro(material("CamEx", "#a58a72", metallic=1.0, rough=0.34), 300, 0.03)
        crank_m = dark
        rod_m = material("Rod", "#5b5f67", metallic=1.0, rough=0.34)
        base_m = black
    else:
        steel = material("Steel", "#7b879b", metallic=0.5, rough=0.35)
        dark = material("Dark", THEME["dark"], metallic=0.4, rough=0.5)
        cast = alu = brass = ceramic = steel
        black = dark
        mark = material("Accent", THEME["accent"], metallic=0.2, rough=0.35)
        cam_in_m = material("CamIn", "#3d8bff", metallic=0.3, rough=0.35)
        cam_ex_m = material("CamEx", "#9aa3b2", metallic=0.3, rough=0.35)
        crank_m = material("CrankM", "#a9b4c4", metallic=0.3, rough=0.45)
        rod_m = material("Rod", "#4f5d75", metallic=0.3, rough=0.4)
        base_m = dark

    box("Base", (2.5, 1.2, 0.18), (0, 0, -1.75), base_m, bevel=0.04)

    # Block: barrel sectioned open at the front so the piston is visible; head as an open-fronted housing.
    sleeve = tube_shell("Cylinder", 0.72, 0.9, 0.3, HEAD_BOT, 0.0, math.pi, cast)
    PARTS["cylinder"] = sleeve
    slab_b = box("HeadBottom", (2.7, 1.5, 0.1), (0, 0, HEAD_BOT + 0.05), cast, bevel=0.015)
    slab_t = box("HeadTop", (2.7, 1.5, 0.1), (0, 0, HEAD_TOP - 0.05), cast, bevel=0.015)
    box("HeadBack", (2.7, 0.08, HEAD_TOP - HEAD_BOT - 0.2), (0, 0.71, (HEAD_BOT + HEAD_TOP) / 2), cast, bevel=0.01)
    box("HeadSide_L", (0.1, 1.5, HEAD_TOP - HEAD_BOT - 0.2), (-1.3, 0, (HEAD_BOT + HEAD_TOP) / 2), cast, bevel=0.01)
    box("HeadSide_R", (0.1, 1.5, HEAD_TOP - HEAD_BOT - 0.2), (1.3, 0, (HEAD_BOT + HEAD_TOP) / 2), cast, bevel=0.01)
    box("HeadDivider", (0.06, 1.5, HEAD_TOP - HEAD_BOT - 0.2), (0, 0, (HEAD_BOT + HEAD_TOP) / 2), cast)
    for sx in (-VX, VX):
        hole(slab_b, sx, 0, SEAT - 0.02, HEAD_BOT + 0.05)
        hole(slab_t, sx, 0, 0.07, HEAD_TOP - 0.05)
    hole(slab_b, 0, 0.4, 0.045, HEAD_BOT + 0.05)
    hole(slab_t, 0, 0.4, 0.095, HEAD_TOP - 0.05)
    PARTS["cylinder head"] = slab_t
    pipe_in = cyl("IntakePipe", 0.17, 1.0, (-VX - 0.5 - 0.15, 0, 3.05), rot=(0, math.radians(90), 0), mat=steel)
    pipe_ex = cyl("ExhaustPipe", 0.17, 1.0, (VX + 0.5 + 0.15, 0, 3.05), rot=(0, math.radians(90), 0), mat=dark)
    PARTS["intake port"], PARTS["exhaust port"] = pipe_in, pipe_ex

    # Crank assembly with a rear shaft carrying the timing pulley.
    crank = cyl("Crank", 0.78, 0.22, (0, 0, CZ), rot=(math.radians(90), 0, 0), mat=crank_m)
    cyl("Bearing", 0.22, 0.24, (0, 0, CZ), rot=(math.radians(90), 0, 0), mat=brass if STUDIO else dark)
    cyl("CrankShaft", 0.07, 1.2, (0, 0.6, CZ), rot=(math.radians(90), 0, 0), mat=steel, verts=24)
    pin = cyl("CrankPin", 0.1, 0.5, (R, -0.2, CZ), rot=(math.radians(90), 0, 0), mat=steel, verts=24)
    PARTS["crankshaft"] = crank
    PY = 1.0
    crank_pulley = star_mesh("PulleyCrank", 0.22, 0.17, 12, 0.12, (0, PY, CZ), black if STUDIO else steel)
    tick_c = cyl("TickCrank", 0.035, 0.16, (0, PY, CZ + 0.2), rot=(math.radians(90), 0, 0), mat=mark, verts=12)
    PARTS["timing belt"] = crank_pulley

    piston = cyl("Piston", 0.66, 0.7, (0, 0, 1.6), mat=alu if STUDIO else mark)
    rings = [(cyl(f"Ring{i}", 0.69, 0.05, (0, 0, 1.6 + dz), mat=dark), dz) for i, dz in enumerate((0.18, 0.02, -0.14))]
    wrist = cyl("WristPin", 0.09, 0.5, (0, -0.2, 1.6), rot=(math.radians(90), 0, 0), mat=steel, verts=24)
    PARTS["piston"] = piston
    rod = box("Rod", (0.2, 0.14, 1.0), (0, -0.2, 0.2), rod_m, bevel=0.03)
    PARTS["connecting rod"] = rod

    # Camshafts (two overhead) with real lobes; pulleys at 2:1 behind the engine.
    cams = {}
    for key, sx, peak, cmat in (("in", -VX, 135.0, cam_in_m), ("ex", VX, 225.0, cam_ex_m)):
        cyl(f"CamShaft_{key}", 0.07, 1.4, (sx, 0.45, CAM_Z), rot=(math.radians(90), 0, 0), mat=steel, verts=24)
        cam, prof = cam_mesh(f"Cam_{key}", BASE_R, LOBE, peak, HALF_W, 0.22, (sx, 0, CAM_Z), cmat)
        pul = star_mesh(f"PulleyCam_{key}", 0.41, 0.36, 24, 0.12, (sx, PY, CAM_Z), black if STUDIO else steel)
        tick = cyl(f"TickCam_{key}", 0.035, 0.16, (sx, PY, CAM_Z + 0.34), rot=(math.radians(90), 0, 0), mat=mark, verts=12)
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
    belt.data.materials.append(black)
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
        retainer = cyl(f"Retainer_{key}", 0.14, 0.03, (sx, 0, z_closed_top - 0.1), mat=brass if STUDIO else dark, verts=24)
        tappet = cyl(f"Tappet_{key}", 0.12, 0.05, (sx, 0, z_closed_top - 0.028), mat=dark, verts=24)
        for o_ in (vhead, stem, retainer, tappet):
            o_.parent = grp
        spring = helix(f"Spring_{key}", 0.09, 5, 0.012, steel if STUDIO else dark)
        spring.location = (sx, 0, HEAD_TOP)
        valves[key] = {"grp": grp, "head": vhead, "spring": spring, "retainer_z": z_closed_top - 0.1}
        PARTS[f"{'intake' if key == 'in' else 'exhaust'} valve"] = vhead
        PARTS[f"{'intake' if key == 'in' else 'exhaust'} spring"] = spring

    # Spark plug (behind the cams so they never touch) and its flash.
    plug = cyl("SparkPlug", 0.07, 0.9, (0, 0.4, HEAD_TOP + 0.25), mat=ceramic, verts=16)
    cyl("PlugTip", 0.025, 0.2, (0, 0.4, HEAD_BOT - 0.03), mat=steel, verts=12)
    PARTS["spark plug"] = plug
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.16, location=(0, 0.4, HEAD_BOT - 0.12))
    flash = bpy.context.active_object
    flash.name = "SparkFlash"
    flash.data.materials.append(material("Flash", "#fff3b0", emit=14.0 if STUDIO else 6.0))

    # Combustion light: a point light inside the chamber that follows the fire.
    fl_data = bpy.data.lights.new("Flame", "POINT")
    fl_data.energy, fl_data.color, fl_data.shadow_soft_size = 0.0, (1.0, 0.55, 0.2), 0.25
    flame_light = bpy.data.objects.new("Flame", fl_data)
    flame_light.location = (0, 0.1, 2.35)
    scene.collection.objects.link(flame_light)

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
    if STUDIO:
        parts_mat = {"in": material("PIn", "#58b4ff", emit=9.0), "ex": material("PEx", "#6f737b", rough=0.9, alpha=0.55, emit=0.15)}
    else:
        parts_mat = {"in": material("PIn", "#66b7ff", emit=2.0), "ex": material("PEx", "#8a8f99", emit=0.6)}
    flow = {"in": [], "ex": []}
    for key in ("in", "ex"):
        for i in range(14):
            bpy.ops.mesh.primitive_uv_sphere_add(radius=0.06, location=(0, 0, 0), segments=12, ring_count=8)
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

    if STUDIO:
        STROKE_COL = [  # theta_start, rgb, alpha, emission
            (0.0, (0.30, 0.62, 1.0), 0.20, 1.6), (180.0, (0.30, 0.62, 1.0), 0.26, 1.6),
            (330.0, (0.95, 0.80, 0.45), 0.45, 1.2), (360.0, (1.0, 0.85, 0.5), 0.70, 5.0), (368.0, (1.0, 0.45, 0.10), 0.80, 9.0),
            (450.0, (1.0, 0.40, 0.08), 0.62, 4.5), (540.0, (0.55, 0.22, 0.10), 0.40, 1.2), (590.0, (0.36, 0.37, 0.40), 0.34, 0.05), (719.9, (0.36, 0.37, 0.40), 0.12, 0.02),
        ]
    else:
        STROKE_COL = [
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
        emis = a[3] + (b[3] - a[3]) * w
        gas_bsdf.inputs["Base Color"].default_value = (*[c ** 2.2 for c in col], 1.0)
        gas_bsdf.inputs["Alpha"].default_value = a[2] + (b[2] - a[2]) * w
        try:
            gas_bsdf.inputs["Emission Color"].default_value = (*[c ** 2.2 for c in col], 1.0)
            gas_bsdf.inputs["Emission Strength"].default_value = emis
        except KeyError:
            pass
        flame_light.data.energy = (emis - 1.2) * 90.0 if (STUDIO and 360.0 <= u <= 560.0 and emis > 1.2) else 0.0
        flame_light.location = (0, 0.1, (top + HEAD_BOT) / 2)
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


# ---------------------------------------------------------------- labels: small dark pill + hairline + dot
LABEL_FONT = bpy.data.fonts.load(SPEC["label_font"]) if SPEC.get("label_font") and os.path.exists(SPEC["label_font"]) else FONT
LABEL_SIZE = 0.105
LABELS = []


def rounded_rect(w, h, r, n=7):
    pts = []
    for (cx, cy, a0) in ((w - r, h / 2 - r, 0.0), (r, h / 2 - r, 90.0), (r, -h / 2 + r, 180.0), (w - r, -h / 2 + r, 270.0)):
        for j in range(n + 1):
            a = math.radians(a0 + 90.0 * j / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a), 0.0))
    return pts


for i, lab in enumerate(SPEC.get("labels", [])):
    part = PARTS.get(lab["part"])
    if part is None:
        raise SystemExit(f"label {lab['text']!r}: kit {kit} has no part {lab['part']!r}")
    cu = bpy.data.curves.new(f"Lbl{i}", type="FONT")
    cu.body = lab["text"].upper()
    cu.size = LABEL_SIZE
    cu.align_x = "LEFT"
    cu.align_y = "CENTER"
    cu.space_character = 1.12
    if LABEL_FONT:
        cu.font = LABEL_FONT
    txt = bpy.data.objects.new(f"Lbl{i}", cu)
    txt.data.materials.append(material(f"LblM{i}", "#ffffff", emit=1.0))
    scene.collection.objects.link(txt)
    w = LABEL_SIZE * 0.80 * len(lab["text"]) + 0.26
    h = 0.20
    me = bpy.data.meshes.new(f"PadM{i}")
    poly = rounded_rect(w, h, 0.07)
    me.from_pydata(poly, [], [list(range(len(poly)))])
    pad = bpy.data.objects.new(f"Pad{i}", me)
    pad.data.materials.append(material(f"PadMat{i}", "#0a0c0f", rough=1.0, alpha=0.78))
    scene.collection.objects.link(pad)
    line = bpy.data.objects.new(f"Line{i}", bpy.data.curves.new(f"LineC{i}", "CURVE"))
    line.data.dimensions = "3D"
    line.data.bevel_depth = 0.01
    sp = line.data.splines.new("POLY")
    sp.points.add(1)
    line.data.materials.append(material(f"LineM{i}", "#ffffff", emit=1.0))
    scene.collection.objects.link(line)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, location=(0, 0, 0), segments=12, ring_count=8)
    dot = bpy.context.active_object
    dot.name = f"Dot{i}"
    dot.data.materials.append(material(f"DotM{i}", "#ffffff", emit=1.0))
    LABELS.append({"txt": txt, "pad": pad, "line": line, "dot": dot, "part": part, "t0": float(lab["t0"]), "t1": float(lab.get("t1", SPEC["seconds"])), "side": 1 if i % 2 == 0 else -1, "i": i, "w": w})


REF = 12.0      # reference distance for screen-space layout (world units)
DZ = 3.5        # labels float this far in front of the camera (always nearer than any shot), scaled so they look REF-sized


def place_labels(f):
    t = f / FPS
    q = cam.matrix_world.to_quaternion()
    right, up, fwd = q @ Vector((1, 0, 0)), q @ Vector((0, 1, 0)), q @ Vector((0, 0, -1))
    s = DZ / REF
    placed = []
    for L in LABELS:
        k = ease_io((t - L["t0"]) / 0.3) * (1.0 - ease_io((t - L["t1"] + 0.25) / 0.25))
        anchor = L["part"].matrix_world.translation
        rel = anchor - cam.location
        depth = max(0.1, rel.dot(fwd))
        ax, ay = rel.dot(right) * REF / depth, rel.dot(up) * REF / depth        # anchor in reference-plane units
        w = L["w"]
        px = L["side"] * (1.5 - w / 2) if L["side"] else 0
        py = ay + 0.0
        for (qx, qy) in placed:                                                  # keep pills apart vertically
            if abs(qy - py) < 0.34 and abs(qx - px) < w:
                py = qy + 0.30
        placed.append((px, py))
        left_edge = px - w / 2
        base = cam.location + fwd * DZ + right * (left_edge * s) + up * (py * s)
        for o in (L["txt"], L["pad"]):
            o.rotation_euler = cam.rotation_euler
        L["pad"].scale = (k * s, k * s, k * s)
        L["pad"].location = base
        L["txt"].scale = (k * s, k * s, k * s)
        L["txt"].location = base + right * (0.13 * s * k) - fwd * 0.01
        near = (px + (w / 2 if L["side"] < 0 else -w / 2))
        edge_world = cam.location + fwd * DZ + right * (near * s) + up * (py * s)
        pts = L["line"].data.splines[0].points
        pts[0].co = (*anchor, 1.0)
        pts[1].co = (*(anchor + (edge_world - anchor) * k), 1.0)
        L["line"].data.bevel_depth = 0.0006 * depth
        r_dot = 0.0009 * depth * k
        L["dot"].location = anchor
        L["dot"].scale = (r_dot, r_dot, r_dot)


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
    if STUDIO:
        cam_data.dof.focus_distance = max(0.5, direction.length)
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
                if frozenset((a, b)) in ok or (norm(a), norm(b)) in ok_prefix:
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
        ("SparkPlug", "PlugTip"), ("SparkPlug", "HeadDivider"), ("PlugTip", "HeadDivider"),
        ("HeadBottom", "HeadBack"), ("HeadBottom", "HeadSide"), ("HeadTop", "HeadBack"), ("HeadTop", "HeadSide"), ("HeadBack", "HeadSide"),
        ("HeadBottom", "HeadDivider"), ("HeadTop", "HeadDivider"), ("HeadBack", "HeadDivider"), ("Cylinder", "HeadBottom"),
        ("PlugTip", "HeadBottom"),
        ("TickCrank", "PulleyCrank"), ("TickCam_in", "PulleyCam_in"), ("TickCam_ex", "PulleyCam_ex"),
        ("CamShaft_in", "TickCam_in"), ("CamShaft_ex", "TickCam_ex"),
    ],
    "crank_piston": [
        ("Crank", "CrankPin"), ("Crank", "Bearing"), ("Rod", "CrankPin"), ("Rod", "WristPin"), ("Rod", "Piston"),
        ("WristPin", "Piston"), ("Piston", "Ring"), ("WristPin", "Ring"), ("Rod", "Ring"),
    ],
}
def norm(n):
    """Part family: strips the trailing index or _L/_R so one allowed pair covers Ring0..2 and HeadSide_L/R."""
    import re
    return re.sub(r"(_[LR])?\d*$", "", n)


ok_prefix = {tuple(p) for k in KIT_CONTACTS.values() for p in k}
ok_prefix |= {(b, a) for a, b in ok_prefix}
KIT_IGNORE = {   # glass sleeve = solid stand-in for a hollow bore; the rest are visual effects
    "crank_piston": ("Cylinder",),
    "four_stroke": ("Gas", "SparkFlash", "IntakePipe", "ExhaustPipe", "Floor"),
}
KIT_PREFIX_IGNORE = ("Pad", "Lbl", "Particle", "Cutter", "Dot")

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
