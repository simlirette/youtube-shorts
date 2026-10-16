"""
Runs the FROZEN Blender script (packages/rendering/blender/mechanism.py) with one extra, per-video 3D kit.

    blender -b --factory-startup -P base/v1/blender_entry.py -- spec.json

The frozen script is never edited. This wrapper reads its source, adds the video's kit at two marker lines in
memory, and executes the result, so a new subject gets the same studio, lighting, camera, labels, depth of
field and collision sweep as every other video.

spec.json is the normal mechanism spec plus:
    "kit":      name the kit registers under (also the "kit" the script dispatches on)
    "kit_file": absolute path of the video's kit.py

kit.py must define build_kit(). It runs with every helper of the frozen script in scope (material, micro, cyl,
box, cone, blade, tube_shell, hole, pipe_x, animate, theta_deg, PARTS, SPEC, scene, ...). It may also define
register_checks(), called just before the collision sweep, to extend KIT_CONTACTS / KIT_PREFIX_IGNORE for the kit.

If the frozen script's layout ever changes so that a marker line is missing or duplicated, this refuses to run
rather than guess.
"""
import json
import os
import sys

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if not args:
    raise SystemExit("usage: blender -b -P blender_entry.py -- spec.json")
with open(args[0], encoding="utf-8") as f:
    spec = json.load(f)

here = os.path.dirname(os.path.abspath(__file__))
script = os.path.normpath(spec.get("frozen_script") or os.path.join(here, "..", "..", "packages", "rendering", "blender", "mechanism.py"))
kit_file = spec.get("kit_file")
if not kit_file or not os.path.exists(kit_file):
    raise SystemExit("spec.kit_file is missing; built-in kits run mechanism.py directly")

with open(script, encoding="utf-8") as f:
    src = f.read()
with open(kit_file, encoding="utf-8") as f:
    kit_src = f.read()

PRE = 'kit = SPEC.get("kit", "crank_piston")\n'      # the kit dispatch
POST = 'if SPEC.get("check"):\n'                      # right before the collision sweep / stills / render
for marker in (PRE, POST):
    if src.count(marker) != 1:
        raise SystemExit("frozen script layout changed (marker not found exactly once): %r" % marker)
if "def build_kit" not in kit_src:
    raise SystemExit("%s must define build_kit()" % kit_file)

pre = kit_src + "\n\nKITS[%r] = build_kit\n" % spec["kit"]
post = "if 'register_checks' in globals():\n    register_checks()\n"
src = src.replace(PRE, pre + PRE, 1).replace(POST, post + POST, 1)

exec(compile(src, script, "exec"), {"__name__": "__main__", "__file__": script})
