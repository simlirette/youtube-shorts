"""
Per-video 3D kit: a hydroelectric dam, sectioned open at the front like the other kits.

Registered through base/v1/blender_entry.py, which runs the frozen scene (studio, lights, camera, labels, collision
sweep) with this file's build_kit() added. Nothing in the frozen script is edited; this file only uses its helpers
(material, micro, cyl, box, cone, blade, tube_shell, hole, animate, theta_deg, PARTS, SPEC, scene, ...).

Layout (x right, z up; solids occupy y 0..D behind the cut plane y = 0, so the section is visible):
  reservoir (left) -> dam wall -> intake gate -> penstock dropping through the dam and bedrock
  -> turbine hall (Francis runner) -> shaft -> generator above it (stator coils, rotor with magnets)
  -> cable shaft to the surface -> transformer -> pylon and power lines (right); water leaves through the tailrace.

Animation: the shaft angle comes from the video's narration-timed drive (theta_deg). The intake gate opens on the
"gate" event the video config places in a scene. Water flows once the gate opens, coils glow as magnets pass them,
and electric charge particles run to the transformer and out along the lines.
"""
D = 1.6                       # depth of the solids behind the section plane
XT, ZT = 3.4, -4.5            # turbine axis (x) and runner height
ZG = -1.9                     # generator centre height
GATE_Z = 1.6
GATE_X = -1.66                # just upstream of the dam face (x = -1.5), clear of the penstock lining

# penstock centre line (x, z): intake mouth -> through the dam -> down the shaft -> into the turbine's spiral case
PEN = [(-1.62, GATE_Z), (-0.55, 0.75), (0.55, -0.7), (0.9, -1.5), (0.9, -3.7), (2.28, ZT)]
TAIL_Z = -5.4


def seg_len(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _basis(d):
    """Rotation whose local Z follows d (a vector in the XZ plane) and whose local Y stays the world Y."""
    z = Vector(d).normalized()
    y = Vector((0.0, 1.0, 0.0))
    x = y.cross(z)
    return Matrix(((x.x, y.x, z.x, 0), (x.y, y.y, z.y, 0), (x.z, y.z, z.z, 0), (0, 0, 0, 1)))


def prism(name, pts, y0, y1, mat):
    """Polygon (x, z) extruded along Y."""
    import bmesh
    bm = bmesh.new()
    bot = [bm.verts.new((x, y0, z)) for x, z in pts]
    top = [bm.verts.new((x, y1, z)) for x, z in pts]
    bm.faces.new(bot)
    bm.faces.new(top)
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([bot[i], bot[j], top[j], top[i]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    return ob


def _cutter(target, ob):
    ob.hide_render = True
    ob.display_type = "WIRE"
    md = target.modifiers.new("Cut", "BOOLEAN")
    md.object = ob
    md.operation = "DIFFERENCE"
    md.solver = "EXACT"


def cut_box(target, size, loc):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    ob = bpy.context.active_object
    ob.name = f"Cutter_{target.name}_{len(target.modifiers)}"
    ob.scale = size
    bpy.ops.object.transform_apply(scale=True)
    _cutter(target, ob)


def cut_along(target, p0, p1, r):
    """Round channel between two points of the XZ plane (centred on the section plane, so it shows as a groove)."""
    d = Vector((p1[0] - p0[0], 0, p1[1] - p0[1]))
    mid = Vector((p0[0], 0, p0[1])) + d / 2
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=r, depth=d.length + 0.5, location=(0, 0, 0))
    ob = bpy.context.active_object
    ob.name = f"Cutter_{target.name}_{len(target.modifiers)}"
    ob.matrix_world = Matrix.Translation(mid) @ _basis(d)
    _cutter(target, ob)


def cut_ball(target, p, r):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=(p[0], 0, p[1]), segments=24, ring_count=12)
    ob = bpy.context.active_object
    ob.name = f"Cutter_{target.name}_{len(target.modifiers)}"
    _cutter(target, ob)


def half_pipe(name, p0, p1, r_in, r_out, mat):
    """Steel lining: a pipe cut in half along the section plane, running from p0 to p1 (XZ plane points)."""
    d = Vector((p1[0] - p0[0], 0, p1[1] - p0[1]))
    ob = tube_shell(name, r_in, r_out, 0.0, d.length, 0.0, math.pi, mat)
    ob.matrix_world = Matrix.Translation((p0[0], 0, p0[1])) @ _basis(d)
    return ob


def build_kit():
    # ---- materials
    steel = micro(material("Steel", "#d3d6dc", metallic=1.0, rough=0.24), 420, 0.03)
    dark = micro(material("DarkSteel", "#8d939d", metallic=0.7, rough=0.40), 300, 0.03)
    cast = material("CastIron", "#7f848c", metallic=0.55, rough=0.5)
    copper = micro(material("Copper", "#c77b36", metallic=1.0, rough=0.32), 300, 0.03)
    brass = material("Brass", "#b8935a", metallic=1.0, rough=0.3)
    black = material("Black", "#17181b", metallic=0.2, rough=0.5)
    rock = micro(material("Rock", "#6b665d", rough=0.95), 5.0, 0.4)
    concrete = micro(material("Concrete", "#bdbbb4", rough=0.85), 36, 0.1)
    runner_m = micro(material("Runner", "#b88a5a", metallic=1.0, rough=0.34), 300, 0.03)
    north = material("MagnetN", "#d8432f", metallic=0.4, rough=0.4)
    south = material("MagnetS", "#2f6fd8", metallic=0.4, rough=0.4)
    water_m = material("WaterBody", "#3f8fd8", rough=0.08, alpha=0.42, emit=0.35)
    drop_m = material("WaterDrop", "#5ab8ff", emit=3.0)
    spark_m = material("Charge", "#ffe066", emit=9.0)

    events = {e["name"]: e for e in SPEC.get("events", [])}

    def ev(name, t):
        e = events.get(name)
        if not e:
            return 0.0
        return min(1.0, max(0.0, (t - e["t0"]) / max(1e-6, e["t1"] - e["t0"])))

    # ---- ground, dam, reservoir
    bed = box("H_Bedrock", (16.5, D, 6.4), (2.75, D / 2, -3.2), rock)
    cut_box(bed, (3.35, D + 0.4, 5.6), (3.425, D / 2, -3.2))                      # turbine pit and generator hall (x 1.75..5.1)
    cut_box(bed, (0.55, D + 0.4, 1.5), (5.45, D / 2, -0.75))                     # cable shaft to the surface
    for a, b in zip(PEN[:-1], PEN[1:]):
        cut_along(bed, a, b, 0.34)
        cut_ball(bed, a, 0.34)
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.5, depth=8.4, location=(XT + 4.2, 0, TAIL_Z), rotation=(0, math.radians(90), 0))
    tail_cut = bpy.context.active_object
    tail_cut.name = "Cutter_tail"
    _cutter(bed, tail_cut)
    dam = prism("H_Dam", [(-1.5, 0.0), (1.9, 0.0), (0.3, 5.2), (-1.5, 5.2)], 0.0, D, concrete)
    for a, b in zip(PEN[:3], PEN[1:4]):
        cut_along(dam, a, b, 0.34)
        cut_ball(dam, a, 0.34)
    PARTS["dam"] = dam
    PARTS["bedrock"] = bed
    water = box("Water_Reservoir", (4.0, D, 4.5), (-3.5, D / 2, 2.25), water_m)
    PARTS["reservoir"] = water

    # ---- intake gate and penstock lining
    gate = box("Gate", (0.14, 0.8, 0.8), (GATE_X, 0.4, GATE_Z), dark, bevel=0.02)
    PARTS["intake gate"] = gate
    for i, (a, b) in enumerate(zip(PEN[:-1], PEN[1:])):
        if i == 0:   # the lining starts inside the dam, so the gate in front of the intake never touches it
            L0 = seg_len(a, b)
            a = (a[0] + 0.3 * (b[0] - a[0]) / L0, a[1] + 0.3 * (b[1] - a[1]) / L0)
        h = half_pipe(f"H_Pen{i}", a, b, 0.30, 0.34, steel)
        if i == 3:
            PARTS["penstock"] = h

    # ---- turbine hall: spiral case, draft tube, tailrace lining, bearing and the generator floor
    case = tube_shell("H_SpiralCase", 0.95, 1.12, ZT - 0.55, ZT + 0.55, 0.0, math.pi, cast)
    case.location = (XT, 0, 0)
    hole(case, XT - 1.03, 0, 0.31, ZT, depth=0.6, rot=(0.0, math.radians(90), 0.0))
    PARTS["spiral case"] = case
    plate_top = tube_shell("H_CasePlateTop", 0.22, 1.12, ZT + 0.5, ZT + 0.56, 0.0, math.pi, cast)
    plate_top.location = (XT, 0, 0)
    plate_bot = tube_shell("H_CasePlateBot", 0.46, 1.12, ZT - 0.56, ZT - 0.5, 0.0, math.pi, cast)
    plate_bot.location = (XT, 0, 0)
    draft = tube_shell("H_DraftTube", 0.46, 0.6, TAIL_Z - 0.1, ZT - 0.5, 0.0, math.pi, dark)
    draft.location = (XT, 0, 0)
    tail = pipe_x("H_Tailrace", 0.42, 0.5, XT, XT + 8.2, TAIL_Z, dark)
    PARTS["tailrace"] = tail
    brg = tube_shell("H_Bearing", 0.13, 0.3, -3.65, -3.3, 0.0, 2 * math.pi, brass)
    brg.location = (XT, 0, 0)
    box("H_BearingArmL", (XT - 0.3 - 1.75, 0.3, 0.12), ((1.75 + XT - 0.3) / 2, 0.45, -3.47), cast)
    box("H_BearingArmR", (5.1 - XT - 0.3, 0.3, 0.12), ((5.1 + XT + 0.3) / 2, 0.45, -3.47), cast)
    floor_slab = box("H_GenFloor", (3.35, D, 0.14), (3.425, D / 2, -3.0), concrete)
    hole(floor_slab, XT, 0.0, 0.2, -3.0, depth=0.5)

    # ---- rotating assembly (one group about the turbine axis): runner, shaft, rotor
    grp = bpy.data.objects.new("RotatingAssembly", None)
    scene.collection.objects.link(grp)
    hub = cone("RunHub", 0.13, 0.4, 0.6, (0, 0, ZT), runner_m)
    hub.parent = grp
    for i in range(12):
        blade(f"RunBlade{i}", 0.36, 0.9, 0.46, 0.03, 2 * math.pi * i / 12, ZT, 32.0, runner_m, grp)
    shaft = cyl("Shaft", 0.12, 3.6, (0, 0, ZT + 1.8), mat=steel, verts=32)
    shaft.parent = grp
    PARTS["shaft"] = shaft
    core = cyl("RotorCore", 0.74, 1.0, (0, 0, ZG), mat=dark, verts=48)
    core.parent = grp
    PARTS["rotor"] = core
    PARTS["turbine runner"] = hub
    for j in range(8):
        a = 2 * math.pi * j / 8
        m = box(f"RotorMag{j}", (0.22, 0.34, 0.86), (0.78 * math.cos(a), 0.78 * math.sin(a), ZG), north if j % 2 == 0 else south, bevel=0.02)
        m.rotation_euler = (0, 0, a)
        m.parent = grp
    grp.location = (XT, 0, 0)

    # ---- generator stator with coils (copper) that glow as the magnets pass
    stator = tube_shell("H_Stator", 0.95, 1.25, ZG - 0.65, ZG + 0.65, 0.0, math.pi, cast)
    stator.location = (XT, 0, 0)
    PARTS["generator"] = stator
    coils = []
    for k in range(7):
        a = math.pi * k / 6
        cm = material(f"CoilM{k}", "#c77b36", metallic=1.0, rough=0.32)
        c = box(f"H_Coil{k}", (0.14, 0.36, 1.3), (XT + 1.0 * math.cos(a), 1.0 * math.sin(a), ZG), cm, bevel=0.015)
        c.rotation_euler = (0, 0, a)
        coils.append((c, a, cm))
    PARTS["coils"] = coils[0][0]
    PARTS["magnets"] = bpy.data.objects["RotorMag2"]

    # ---- cable, transformer, pylon, power lines
    cable_pts = [(XT + 1.25, ZG), (5.45, ZG), (5.45, 0.2), (6.1, 0.55)]
    cu = bpy.data.curves.new("Cable", "CURVE")
    cu.dimensions, cu.bevel_depth = "3D", 0.035
    sp = cu.splines.new("POLY")
    sp.points.add(len(cable_pts) - 1)
    for i, (x, z) in enumerate(cable_pts):
        sp.points[i].co = (x, 0.15, z, 1.0)
    cobj = bpy.data.objects.new("H_Cable", cu)
    cobj.data.materials.append(black)
    scene.collection.objects.link(cobj)
    xf = box("H_Transformer", (0.95, 0.9, 1.2), (6.35, 0.45, 0.6), dark, bevel=0.03)
    for i in range(3):
        cyl(f"H_Bushing{i}", 0.08, 0.5, (6.1 + i * 0.25, 0.45, 1.45), mat=black, verts=16)
    PARTS["transformer"] = xf
    leg_a = box("H_PylonA", (0.1, 0.1, 4.5), (7.2, 0.5, 2.25), steel)
    leg_a.rotation_euler = (0, math.radians(2.2), 0)
    leg_b = box("H_PylonB", (0.1, 0.1, 4.5), (7.8, 0.5, 2.25), steel)
    leg_b.rotation_euler = (0, math.radians(-2.2), 0)
    box("H_PylonBrace1", (0.62, 0.06, 0.06), (7.5, 0.5, 1.2), steel)
    box("H_PylonBrace2", (0.55, 0.06, 0.06), (7.5, 0.5, 2.6), steel)
    arm = box("H_PylonArm", (2.0, 0.08, 0.1), (7.5, 0.5, 4.55), steel)
    PARTS["power lines"] = arm
    wire_tips = [(6.55, 0.5), (7.5, 0.5), (8.45, 0.5)]
    for wi, (wx, wy) in enumerate(wire_tips):
        cyl(f"H_Insulator{wi}", 0.05, 0.3, (wx, wy, 4.35), mat=black, verts=12)
        wc = bpy.data.curves.new(f"Wire{wi}", "CURVE")
        wc.dimensions, wc.bevel_depth = "3D", 0.016
        wsp = wc.splines.new("POLY")
        npts = 14
        wsp.points.add(npts - 1)
        for i in range(npts):
            u = i / (npts - 1)
            x = wx + u * (12.5 - wx)
            wsp.points[i].co = (x, wy, 4.2 - 0.35 * u, 1.0)
        wo = bpy.data.objects.new(f"H_Wire{wi}", wc)
        wo.data.materials.append(black)
        scene.collection.objects.link(wo)

    # ---- a little light for the underground hall (the studio lights do not reach it)
    lt = bpy.data.lights.new("HallLight", "POINT")
    lt.energy, lt.color, lt.shadow_soft_size = 1400.0, (1.0, 0.96, 0.9), 0.6
    lo = bpy.data.objects.new("HallLight", lt)
    lo.location = (XT, -2.6, -3.0)
    scene.collection.objects.link(lo)

    # ---- flowing water and charge
    def along_pts(pts, s):
        lens = [seg_len(a, b) for a, b in zip(pts[:-1], pts[1:])]
        d = s * sum(lens)
        for (a, b), ln in zip(zip(pts[:-1], pts[1:]), lens):
            if d <= ln:
                u = d / ln if ln else 0.0
                return (a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u)
            d -= ln
        return pts[-1]

    def water_path(s):
        """Position (x, y, z) of a water drop at path parameter s: penstock, spiral round the runner, draft tube, tailrace."""
        if s < 0.62:
            x, z = along_pts(PEN, s / 0.62)
            return (x, 0.0, z)
        if s < 0.82:
            u = (s - 0.62) / 0.2
            r_, a_ = 0.9 - 0.45 * u, math.pi - 2.1 * math.pi * u
            return (XT + r_ * math.cos(a_), r_ * math.sin(a_) * 0.9, ZT - 0.2 * u)
        x, z = along_pts([(XT, ZT - 0.55), (XT, TAIL_Z), (XT + 8.2, TAIL_Z)], (s - 0.82) / 0.18)
        return (x, 0.0, z)

    NW = 46
    drops = []
    for i in range(NW):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.1, location=(0, 0, 0), segments=12, ring_count=8)
        o = bpy.context.active_object
        o.name = f"Particle_w{i}"
        o.data.materials.append(drop_m)
        drops.append((o, i / NW, ((i * 29) % 7 - 3) * 0.03))
    NC = 28
    charges = []
    wire_path = [(5.45, 0.2), (6.1, 0.55), (6.35, 1.45), (7.5, 4.4), (12.4, 3.9)]
    elec_path = [(XT + 1.25, ZG), (5.45, ZG), (5.45, 0.2)] + wire_path[1:]
    for i in range(NC):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.075, location=(0, 0, 0), segments=10, ring_count=6)
        o = bpy.context.active_object
        o.name = f"Particle_e{i}"
        o.data.materials.append(spark_m)
        charges.append((o, i / NC))
    NR = 12
    ripples = []
    for i in range(NR):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.07, location=(0, 0, 0), segments=10, ring_count=6)
        o = bpy.context.active_object
        o.name = f"Particle_r{i}"
        o.data.materials.append(drop_m)
        ripples.append((o, i / NR, 0.1 + 0.14 * ((i * 5) % 6)))

    vmax = float(SPEC.get("max_speed", 300.0))

    def speed_at(t):
        h = 0.05
        return abs(theta_deg(t + h) - theta_deg(max(0.0, t - h))) / (2 * h)

    @animate
    def _(f):
        t = f / FPS
        th = math.radians(theta_deg(t))
        grp.rotation_euler = (0, 0, th)
        gate_u = ev("gate", t)
        gate.location = (GATE_X, 0.4, GATE_Z + 1.05 * gate_u)
        spool = min(1.0, speed_at(t) / vmax)
        # water: only while the gate is open; it speeds up as it falls (position parameter grows faster late in the path)
        flow = (t * (0.07 + 0.2 * gate_u)) % 1.0
        for o, off, jit in drops:
            s = (off + flow) % 1.0
            x, y, z = water_path(s ** 1.5)                     # speeds up along the fall
            o.location = (x + jit, y + jit * 0.6, z)
            k = gate_u
            o.scale = (k, k, k)
        # the lake: a few drops drifting towards the intake
        for o, off, hh in ripples:
            s = (off + t * 0.05) % 1.0
            o.location = (-4.6 + s * 2.75, 0.4, 0.5 + hh * 3.0 * (1 - s) + 1.0 * s)
            o.scale = (1, 1, 1)
        # generator: coils glow as magnets pass; charge runs to the grid
        for c, a, cm in coils:
            field = abs(math.sin(4.0 * (a - th)))
            b = cm.node_tree.nodes["Principled BSDF"]
            try:
                b.inputs["Emission Color"].default_value = lin("#ffcf4a")
                b.inputs["Emission Strength"].default_value = 14.0 * field * spool
            except KeyError:
                pass
        run = (t * (0.1 + 0.9 * spool)) % 1.0
        for o, off in charges:
            s = (off + run) % 1.0
            x, z = along_pts(elec_path, s)
            o.location = (x, 0.15, z)
            k = min(1.0, spool * 3.0)
            o.scale = (k, k, k)


def register_checks():
    """Called by the wrapper just before the collision sweep: what may touch, and what is only an effect."""
    global KIT_PREFIX_IGNORE
    KIT_PREFIX_IGNORE = KIT_PREFIX_IGNORE + ("Water",)
    pairs = [("Shaft", "RunHub"), ("Shaft", "RotorCore"), ("RunBlade", "RunHub"), ("RotorMag", "RotorCore"), ("RunBlade", "RunBlade")]
    KIT_CONTACTS["dam"] = pairs
    ok_prefix.update(tuple(p) for p in pairs)
    ok_prefix.update((b, a) for a, b in pairs)
