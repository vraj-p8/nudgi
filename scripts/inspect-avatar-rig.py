"""Read-only GLB inspection in Blender. Does not save or modify the source model."""
import bpy
import json
from pathlib import Path
from mathutils import Vector

root = Path(__file__).resolve().parent.parent
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(root / 'src/renderer/shared/avatars/models/me.glb'))
armature = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.name.startswith('avaturn_')]
bones = armature.data.bones
required = ['Hips', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
            'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase']
assert all(name in bones for name in required)
points = [o.matrix_world @ Vector(v) for o in meshes for v in o.bound_box]
report = {
    'blender_version': bpy.app.version_string,
    'bones': len(bones), 'meshes': [o.name for o in meshes],
    'height_m': max(p.z for p in points) - min(p.z for p in points),
    'mesh_floor_m': min(p.z for p in points),
    'animations': len(bpy.data.actions),
    'morph_targets': sum(len(o.data.shape_keys.key_blocks) if o.data.shape_keys else 0 for o in meshes),
    'joints': {name: list(armature.matrix_world @ bones[name].head_local) for name in required},
}
target = root / 'output/avatar/blender-rig.json'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(report, indent=2), encoding='utf-8')
print('BLENDER RIG PASS', json.dumps({k: v for k, v in report.items() if k != 'joints'}))
