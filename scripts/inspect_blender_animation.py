"""Read-only semantic inspection for GUI-authored Reef Skitter .blend files.

Run with Blender, never ordinary Python:
  blender --background scene.blend --python scripts/inspect_blender_animation.py -- \
    --stage clip --expected-clip idle --output inspection.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

import bpy


CLIPS = {"idle", "walk", "run", "attack", "death"}


def action_fcurves(action):
    direct = getattr(action, "fcurves", None)
    if direct is not None:
        return list(direct)
    result = []
    for layer in getattr(action, "layers", ()):
        for strip in getattr(layer, "strips", ()):
            for channelbag in getattr(strip, "channelbags", ()):
                result.extend(channelbag.fcurves)
    return result


def inspect(stage: str, expected_clip: str | None) -> dict:
    meshes = [obj for obj in bpy.data.objects if obj.type == "MESH"]
    armatures = [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]
    if len(meshes) != 15 or len(armatures) != 1:
        raise RuntimeError(f"expected 15 mesh parts and one armature, got {len(meshes)} and {len(armatures)}")
    if any(len(obj.material_slots) < 1 or any(slot.material is None for slot in obj.material_slots) for obj in meshes):
        raise RuntimeError("every retained mesh part must keep a material binding")
    armature = armatures[0]
    root_bone_names = {bone.name for bone in armature.data.bones if bone.parent is None}
    unbound = []
    for mesh in meshes:
        parent_bound = mesh.parent == armature
        modifier_bound = any(modifier.type == "ARMATURE" and modifier.object == armature for modifier in mesh.modifiers)
        if not parent_bound and not modifier_bound:
            unbound.append(mesh.name)
    if unbound:
        raise RuntimeError("mesh parts are not bound to the canonical rig: " + ", ".join(sorted(unbound)))

    actions = {action.name: action for action in bpy.data.actions}
    expected_actions = set() if stage == "rig" else ({expected_clip} if stage == "clip" else CLIPS)
    if set(actions) != expected_actions:
        raise RuntimeError(f"expected Actions {sorted(expected_actions)}, got {sorted(actions)}")

    action_receipts = []
    for name, action in sorted(actions.items()):
        fcurves = action_fcurves(action)
        if not fcurves:
            raise RuntimeError(f"Action {name} has no animation curves")
        keyed = [curve for curve in fcurves if len(curve.keyframe_points) >= 2]
        keyframes = sorted({round(float(point.co.x), 5) for curve in keyed for point in curve.keyframe_points})
        if len(keyed) == 0 or len(keyframes) < 2 or keyframes[-1] <= keyframes[0]:
            raise RuntimeError(f"Action {name} has no nonzero keyed time range")
        if any(curve.data_path == "location" for curve in fcurves):
            raise RuntimeError(f"Action {name} animates scene-root/object location")
        for curve in fcurves:
            match = re.fullmatch(r'pose\.bones\["(.+)"\]\.location', curve.data_path)
            if match and match.group(1) in root_bone_names and curve.array_index in {0, 1}:
                values = [float(point.co.y) for point in curve.keyframe_points]
                if values and max(values) - min(values) > 1e-4:
                    raise RuntimeError(f"Action {name} has horizontal root-bone motion")
        loop = name in {"idle", "walk", "run"}
        endpoint_matches = sum(
            abs(float(curve.keyframe_points[0].co.y) - float(curve.keyframe_points[-1].co.y)) <= 1e-4
            for curve in keyed
        )
        if loop and endpoint_matches != len(keyed):
            raise RuntimeError(f"looping Action {name} has mismatched keyed endpoints")
        action_receipts.append({
            "name": name,
            "loop": loop,
            "root_motion": False,
            "frame_start": keyframes[0],
            "frame_end": keyframes[-1],
            "fcurves": len(fcurves),
            "keyed_fcurves": len(keyed),
            "loop_endpoint_matches": endpoint_matches,
        })

    return {
        "format": "myth-maker.blender-animation-inspection/v1",
        "stage": stage,
        "blend_filepath": bpy.data.filepath,
        "mesh_parts": len(meshes),
        "mesh_names": sorted(obj.name for obj in meshes),
        "material_bound_parts": len(meshes),
        "armature_count": len(armatures),
        "armature_name": armature.name,
        "bound_parts": len(meshes),
        "actions": action_receipts,
    }


def main() -> None:
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=("rig", "clip", "integration"), required=True)
    parser.add_argument("--expected-clip", choices=sorted(CLIPS))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(arguments)
    if (args.stage == "clip") != bool(args.expected_clip):
        raise ValueError("only clip inspection requires --expected-clip")
    if not bpy.data.filepath or not re.search(r"\.blend$", bpy.data.filepath, re.IGNORECASE):
        raise RuntimeError("Blender did not reopen a saved native file")
    result = inspect(args.stage, args.expected_clip)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
