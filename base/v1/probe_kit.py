"""
Probe: where does each labelled part appear on screen, frame by frame?

Not a 3D kit. It is handed to the frozen wrapper (base/v1/blender_entry.py) as the "kit file", wraps the real kit
(a built-in one, or the video's own kit.py named in spec["inner_kit_file"]) and, just before the frozen script would
render, replaces the render with a measurement:

    blender -b --factory-startup -P base/v1/blender_entry.py -- spec.json

spec.json is the normal mechanism spec (with "labels": [] so no pills are drawn into the render) plus:
    "probe": true
    "probe_parts":  ["intake valve", "piston", ...]   names registered in PARTS by the kit
    "probe_out":    path of the JSON to write
    "probe_step_frames": 2                            (optional) sample every n frames
    "kit_file":     this file;   "inner_kit_file": the video's own kit.py (omit for a built-in kit)

Output: {part: [[seconds, x, y, depth], ...]} with x and y as fractions of the frame (y counted downwards) and depth
the distance in front of the camera (<= 0 means behind it). The anchor is the same point the original in-Blender
pills pointed at (the centre of the part's geometry), seen through the same camera, shift and animation.

Nothing in the frozen script is edited: this file only reads what the script already defines.
"""
_inner_file = SPEC.get("inner_kit_file")
_inner_checks = None
if _inner_file:
    with open(_inner_file, encoding="utf-8") as _f:
        exec(compile(_f.read(), _inner_file, "exec"), globals())      # defines the video's build_kit()
    _inner_build = build_kit
    _inner_checks = globals().get("register_checks")
else:
    _inner_build = KITS[SPEC["kit"]]                                    # a built-in kit


def build_kit():
    _inner_build()


def register_checks():
    if not SPEC.get("probe"):
        if _inner_checks:
            _inner_checks()
        return
    from bpy_extras.object_utils import world_to_camera_view

    names = list(SPEC["probe_parts"])
    missing = [n for n in names if n not in PARTS]
    if missing:
        raise SystemExit("probe: the kit has no part(s) %s (it has %s)" % (missing, sorted(PARTS)))
    step = max(1, int(SPEC.get("probe_step_frames", 2)))
    frames = list(range(1, FRAMES + 1, step))
    if frames[-1] != FRAMES:
        frames.append(FRAMES)
    out = {n: [] for n in names}
    for f in frames:
        scene.frame_set(f)                  # runs the frozen frame handler: animation, camera, everything
        bpy.context.view_layer.update()
        t = (f - 1) / FPS
        for n in names:
            v = world_to_camera_view(scene, cam, part_anchor(PARTS[n]))
            out[n].append([round(t, 4), round(v.x, 5), round(1.0 - v.y, 5), round(v.z, 4)])
    with open(SPEC["probe_out"], "w", encoding="utf-8") as fh:
        json.dump(out, fh)
    print("PROBE_OK")
    raise SystemExit
