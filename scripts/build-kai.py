# Builds the bundled 3D Kai (stylized, rigged with the Mixamo-style skeleton the 3D adapter drives) and exports
# src/renderer/shared/avatars/models/kai.glb plus a preview render.
#
#   "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup --python scripts/build-kai.py
#
# Authoring space is Blender's: Z up, character faces -Y, character's left = +X. glTF export converts to Y up / +Z
# forward, which is what the adapter expects (T-pose bind, each bone's child along its local +Y).
import bpy
import bmesh
import math
import os
from mathutils import Vector, Matrix

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT_GLB = os.path.join(ROOT, 'src', 'renderer', 'shared', 'avatars', 'models', 'kai.glb')
OUT_DIR = os.path.join(ROOT, 'output', 'kai3d')
os.makedirs(OUT_DIR, exist_ok=True)

# ----------------------------------------------------------------------------------------------- scene reset
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c) + (1.0,)


def material(name, color, rough=0.6, metal=0.0, sheen=0.0, emit=None, coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = srgb(color)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if coat and 'Coat Weight' in p.inputs:
        p.inputs['Coat Weight'].default_value = coat
    if sheen and 'Sheen Weight' in p.inputs:
        p.inputs['Sheen Weight'].default_value = sheen
    if emit:
        p.inputs['Emission Color'].default_value = srgb(emit)
        p.inputs['Emission Strength'].default_value = 1.0
    return m


M = {
    'primary': material('kai_primary', '#169C8F', 0.82),  # hoodie (tinted by the buddy colour setting)
    'rib': material('kai_rib', '#117E74', 0.88),
    'pants': material('kai_pants', '#26324D', 0.82),
    'cuff': material('kai_cuff', '#E6E9EE', 0.9),
    'ankle': material('kai_ankle', '#1C2640', 0.85),
    'skin': material('kai_skin', '#E7AC84', 0.5),
    'hair': material('kai_tuft', '#33231A', 0.66),
    'brow': material('kai_brow', '#2A1B14', 0.6),
    'white': material('kai_eyewhite', '#FBFBFA', 0.22),
    'iris': material('kai_iris', '#5A3317', 0.25),
    'pupil': material('kai_pupil', '#120B08', 0.18),
    'glint': material('kai_glint', '#FFFFFF', 0.1, emit='#FFFFFF'),
    'mouth': material('kai_mouth', '#7A3426', 0.5),
    'shoe': material('kai_shoe', '#F1F2F4', 0.58),
    'inner': material('kai_inner', '#3A4150', 0.8),
    'lace': material('kai_lace', '#FFFFFF', 0.7),
    'sole': material('kai_sole', '#E3E6EB', 0.72),
    'tread': material('kai_tread', '#9AA3B0', 0.85),
    'stripe': material('kai_stripe', '#2EC5DA', 0.45),
    'string': material('kai_string', '#F4EFE6', 0.7),
    'metal': material('kai_metal', '#C9CED6', 0.3, metal=0.9),
}


def link(obj):
    scene.collection.objects.link(obj)
    return obj


def shade_smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


def apply_modifiers(obj):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    obj.select_set(False)


def ellipsoid(name, center, radii, mat, segments=40, rings=24):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * radii[0], v.co.y * radii[1], v.co.z * radii[2])) + Vector(center)
    bm.to_mesh(me)
    bm.free()
    o = link(bpy.data.objects.new(name, me))
    o.data.materials.append(mat)
    shade_smooth(o)
    return o


def rounded_box(name, center, size, mat, bevel=0.4, subdiv=2):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    bm.to_mesh(me)
    bm.free()
    o = link(bpy.data.objects.new(name, me))
    o.location = center
    b = o.modifiers.new('bevel', 'BEVEL')
    b.width = min(size) * bevel
    b.segments = 3
    s = o.modifiers.new('sub', 'SUBSURF')
    s.levels = subdiv
    s.render_levels = subdiv
    apply_modifiers(o)
    o.data.materials.append(mat)
    shade_smooth(o)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    o.select_set(False)
    return o


def tube(name, pts, radius, mat, res=10):
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = radius
    cu.bevel_resolution = 4
    cu.use_fill_caps = True
    sp = cu.splines.new('BEZIER')
    sp.bezier_points.add(len(pts) - 1)
    for bp, p in zip(sp.bezier_points, pts):
        bp.co = p
        bp.handle_left_type = bp.handle_right_type = 'AUTO'
    cu.resolution_u = res
    o = link(bpy.data.objects.new(name, cu))
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.convert(target='MESH')
    o = bpy.context.view_layer.objects.active
    o.select_set(False)
    o.data.materials.clear()
    o.data.materials.append(mat)
    shade_smooth(o)
    return o


# ----------------------------------------------------------------------------------------------- skeleton
# joint positions (Blender space, metres); proportions follow the adapter's tuned human rig (~1.8 m)
J = {
    'Hips': (0, 0.01, 0.98), 'Spine': (0, 0.006, 1.08), 'Spine1': (0, 0.0, 1.20), 'Spine2': (0, 0.0, 1.32),
    'Neck': (0, 0.012, 1.50), 'Head': (0, 0.004, 1.60), 'HeadTop': (0, 0.0, 1.80),
}
for s, sx in (('Left', 1), ('Right', -1)):
    J[f'{s}Shoulder'] = (0.05 * sx, 0.0, 1.44)
    J[f'{s}Arm'] = (0.17 * sx, 0.02, 1.445)
    J[f'{s}ForeArm'] = (0.44 * sx, 0.03, 1.445)
    J[f'{s}Hand'] = (0.685 * sx, 0.02, 1.445)
    J[f'{s}HandEnd'] = (0.75 * sx, 0.02, 1.445)
    fingers = {
        'Index': (-0.028, 0.0, [0.772, 0.802, 0.824, 0.842]),
        'Middle': (-0.009, 0.001, [0.776, 0.809, 0.834, 0.853]),
        'Ring': (0.010, 0.0, [0.773, 0.803, 0.826, 0.843]),
        'Pinky': (0.027, -0.002, [0.766, 0.789, 0.806, 0.820]),
    }
    for f, (fy, fz, xs) in fingers.items():
        for i, x in enumerate(xs):
            nm = f'{s}Hand{f}{i + 1}' if i < 3 else f'{s}Hand{f}End'
            J[nm] = (x * sx, 0.02 + fy, 1.447 + fz - 0.002 * i)
    for i, (x, y, z) in enumerate([(0.708, -0.012, 1.432), (0.732, -0.040, 1.424), (0.752, -0.058, 1.421), (0.768, -0.071, 1.420)]):
        nm = f'{s}HandThumb{i + 1}' if i < 3 else f'{s}HandThumbEnd'
        J[nm] = (x * sx, y, z)
    J[f'{s}UpLeg'] = (0.09 * sx, 0.0, 0.94)
    J[f'{s}Leg'] = (0.095 * sx, -0.006, 0.515)
    J[f'{s}Foot'] = (0.10 * sx, 0.018, 0.092)
    J[f'{s}ToeBase'] = (0.10 * sx, -0.105, 0.022)
    J[f'{s}ToeEnd'] = (0.10 * sx, -0.165, 0.022)

# bone: (head joint, tail joint, parent, roll-target) ; roll target = desired local +Z direction
HIER = [('Hips', 'Spine', None), ('Spine', 'Spine1', 'Hips'), ('Spine1', 'Spine2', 'Spine'), ('Spine2', 'Neck', 'Spine1'),
        ('Neck', 'Head', 'Spine2'), ('Head', 'HeadTop', 'Neck')]
for s in ('Left', 'Right'):
    HIER += [(f'{s}Shoulder', f'{s}Arm', 'Spine2'), (f'{s}Arm', f'{s}ForeArm', f'{s}Shoulder'),
             (f'{s}ForeArm', f'{s}Hand', f'{s}Arm'), (f'{s}Hand', f'{s}HandEnd', f'{s}ForeArm')]
    for f in ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky'):
        HIER += [(f'{s}Hand{f}1', f'{s}Hand{f}2', f'{s}Hand'), (f'{s}Hand{f}2', f'{s}Hand{f}3', f'{s}Hand{f}1'),
                 (f'{s}Hand{f}3', f'{s}Hand{f}End', f'{s}Hand{f}2')]
    HIER += [(f'{s}UpLeg', f'{s}Leg', 'Hips'), (f'{s}Leg', f'{s}Foot', f'{s}UpLeg'),
             (f'{s}Foot', f'{s}ToeBase', f'{s}Leg'), (f'{s}ToeBase', f'{s}ToeEnd', f'{s}Foot')]

arm_data = bpy.data.armatures.new('Armature')
rig = link(bpy.data.objects.new('Armature', arm_data))
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_data.edit_bones
for name, tail, parent in HIER:
    b = eb.new(name)
    b.head = J[name]
    b.tail = J[tail]
    # Hands/fingers: local +Z toward the palm (down in the palms-down T-pose) so finger flex is about local X.
    if 'Hand' in name:
        b.align_roll(Vector((0, 0, -1)))
    elif 'Leg' in name or 'Foot' in name or 'Toe' in name:
        b.align_roll(Vector((0, -1, 0)))
    else:
        b.align_roll(Vector((0, -1, 0)))
    if parent:
        b.parent = eb[parent]
        b.use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')
rig.select_set(False)

# ----------------------------------------------------------------------------------------------- body (skin modifier)
# graph of (position, radius_x, radius_y); edges connect indices
V = []
E = []


def node(p, rx, ry=None):
    V.append((Vector(p), rx, ry if ry is not None else rx))
    return len(V) - 1


def chain(ids):
    for a, b in zip(ids, ids[1:]):
        E.append((a, b))


hips = node((0, 0.012, 0.975), 0.150, 0.118)
belly = node((0, 0.006, 1.08), 0.150, 0.120)
waist = node((0, 0.0, 1.20), 0.158, 0.122)
chest = node((0, 0.0, 1.32), 0.172, 0.128)
upchest = node((0, 0.004, 1.415), 0.160, 0.118)
neck0 = node((0, 0.012, 1.485), 0.060, 0.060)
neck1 = node((0, 0.010, 1.565), 0.056, 0.056)
chain([hips, belly, waist, chest, upchest, neck0, neck1])
for sx in (1, -1):
    sh = node((0.155 * sx, 0.018, 1.432), 0.072, 0.072)
    E.append((upchest, sh))
    elbow = node((0.44 * sx, 0.03, 1.445), 0.056, 0.056)
    cuff0 = node((0.61 * sx, 0.025, 1.445), 0.050, 0.050)
    wrist = node((0.665 * sx, 0.022, 1.445), 0.034, 0.030)
    palm = node((0.725 * sx, 0.018, 1.444), 0.040, 0.016)
    chain([sh, elbow, cuff0, wrist, palm])
    for f, fy in (('Index', -0.028), ('Middle', -0.009), ('Ring', 0.010), ('Pinky', 0.027)):
        xs = {'Index': [0.772, 0.802, 0.824, 0.840], 'Middle': [0.776, 0.809, 0.834, 0.850],
              'Ring': [0.773, 0.803, 0.826, 0.840], 'Pinky': [0.766, 0.789, 0.806, 0.817]}[f]
        r = 0.0105 if f != 'Pinky' else 0.0088
        ids = [palm] + [node((x * sx, 0.02 + fy, 1.447 - 0.002 * i), r * (1 - 0.06 * i)) for i, x in enumerate(xs)]
        chain(ids)
    th = [palm] + [node((x * sx, y, z), 0.0125 - 0.001 * i) for i, (x, y, z) in enumerate([(0.708, -0.014, 1.433), (0.732, -0.040, 1.425), (0.752, -0.058, 1.422), (0.766, -0.069, 1.421)])]
    chain(th)
    hipj = node((0.092 * sx, 0.004, 0.925), 0.098, 0.096)
    E.append((hips, hipj))
    knee = node((0.096 * sx, -0.004, 0.515), 0.066, 0.068)
    calf = node((0.098 * sx, 0.008, 0.30), 0.060, 0.062)
    ank = node((0.10 * sx, 0.016, 0.07), 0.043, 0.045)
    chain([hipj, knee, calf, ank])

me = bpy.data.meshes.new('kai_body')
me.from_pydata([v[0] for v in V], E, [])
body = link(bpy.data.objects.new('kai_body', me))
sk = body.modifiers.new('skin', 'SKIN')
sk.use_smooth_shade = True
sk.branch_smoothing = 0.6
for i, (_, rx, ry) in enumerate(V):
    body.data.skin_vertices[0].data[i].radius = (rx, ry)
body.data.skin_vertices[0].data[hips].use_root = True
sub = body.modifiers.new('sub', 'SUBSURF')
sub.levels = 2
sub.render_levels = 2
apply_modifiers(body)
for k in ('primary', 'rib', 'pants', 'cuff', 'skin'):
    body.data.materials.append(M[k])
MI = {k: i for i, k in enumerate(('primary', 'rib', 'pants', 'cuff', 'skin'))}
for p in body.data.polygons:
    c = p.center
    ax = abs(c.x)
    if ax > 0.64:
        p.material_index = MI['skin']
    elif c.z > 1.50 and ax < 0.09:
        p.material_index = MI['skin']  # neck
    elif c.z < 0.118:
        p.material_index = MI['cuff']  # sock (hidden mostly by the shoe collar)
    elif c.z < 0.955:
        p.material_index = MI['pants']
    else:
        p.material_index = MI['primary']
shade_smooth(body)

# hood bunched behind the neck, kangaroo pocket, drawstrings
hood = ellipsoid('kai_hood', (0, 0.055, 1.49), (0.128, 0.092, 0.062), M['primary'])
for v in hood.data.vertices:  # hollow front so the collar sits around the neck
    if v.co.y < 0.0 and v.co.z > 1.45:
        v.co.y += 0.02
def ring(name, center, major, minor, mat, axis='Z', squash=1.0):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=48, minor_segments=12, location=center,
                                     rotation=(0, math.pi / 2, 0) if axis == 'X' else (0, 0, 0))
    o = bpy.context.view_layer.objects.active
    o.name = name
    if squash != 1.0:
        o.scale = (1, squash, 1) if axis == 'Z' else (1, squash, 1)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    o.select_set(False)
    o.data.materials.append(mat)
    shade_smooth(o)
    return o


# rib bands hide the material seams of the skin-modifier body
hem = ring('kai_hem', (0, 0.012, 0.958), 0.150, 0.024, M['rib'], squash=0.80)
collar = ring('kai_collar', (0, 0.012, 1.505), 0.064, 0.021, M['rib'])
cuffs = [ring(f'kai_cuff{sx}', (0.632 * sx, 0.023, 1.445), 0.046, 0.014, M['rib'], axis='X') for sx in (1, -1)]
ankles = [ring(f'kai_ankle{sx}', (0.10 * sx, 0.016, 0.126), 0.049, 0.014, M['ankle']) for sx in (1, -1)]
strings = [tube(f'kai_string{i}', [Vector((x, -0.128, 1.448)), Vector((x * 1.1, -0.150, 1.38)), Vector((x * 1.15, -0.150, 1.32))], 0.0042, M['string']) for i, x in enumerate((0.028, -0.028))]
tips = [rounded_box(f'kai_tip{i}', (x * 1.15, -0.150, 1.305), (0.009, 0.009, 0.024), M['metal'], bevel=0.45, subdiv=1) for i, x in enumerate((0.028, -0.028))]

# ----------------------------------------------------------------------------------------------- head & face
HC = Vector((0, 0.004, 1.684))
HR = (0.116, 0.121, 0.132)
head = ellipsoid('kai_head', HC, HR, M['skin'], 48, 32)
for v in head.data.vertices:  # soften the jaw: narrow the lower face slightly
    d = (v.co.z - HC.z) / HR[2]
    if d < -0.2:
        k = 1 - 0.12 * (-d - 0.2)
        v.co.x *= k
        v.co.y = HC.y + (v.co.y - HC.y) * (1 - 0.05 * (-d - 0.2))


def on_head(x, z, inset=0.0):
    """front surface point of the head ellipsoid at (x, z)."""
    u = (x / HR[0]) ** 2 + ((z - HC.z) / HR[2]) ** 2
    y = HC.y - HR[1] * math.sqrt(max(0.0, 1 - u))
    return Vector((x, y + inset, z))


ears = [ellipsoid(f'kai_ear{i}', (sx * 0.117, 0.012, 1.676), (0.018, 0.030, 0.040), M['skin']) for i, sx in enumerate((1, -1))]
nose_p = on_head(0, 1.654, 0.004)
nose = ellipsoid('kai_nose', nose_p, (0.017, 0.014, 0.015), M['skin'])
eye_parts = []
EYE_Z = 1.698
for sx in (1, -1):
    s = on_head(0.044 * sx, EYE_Z, 0.0)
    c = s + Vector((0, 0.017, 0))  # sphere centre, sunk into the head
    r = 0.030
    eye_parts.append(ellipsoid(f'kai_eye{sx}', c, (r * 0.92, r * 0.75, r * 1.05), M['white'], 32, 20))
    front = c + Vector((0, -r * 0.75, 0))
    eye_parts.append(ellipsoid(f'kai_iris{sx}', front + Vector((0, 0.0045, -0.001)), (0.0178, 0.006, 0.0196), M['iris'], 28, 16))
    eye_parts.append(ellipsoid(f'kai_pupil{sx}', front + Vector((0, 0.0015, -0.001)), (0.0092, 0.004, 0.0102), M['pupil'], 20, 12))
    eye_parts.append(ellipsoid(f'kai_glint{sx}', front + Vector((-0.006 * sx + 0.0, -0.0012, 0.0075)), (0.0042, 0.002, 0.0042), M['glint'], 12, 8))
    eye_parts.append(ellipsoid(f'kai_glint2{sx}', front + Vector((0.006 * sx, -0.0008, -0.006)), (0.0019, 0.0015, 0.0019), M['glint'], 10, 6))
brows = []
for sx in (1, -1):
    pts = [on_head(x * sx, z, -0.004) for x, z in ((0.020, 1.738), (0.044, 1.746), (0.066, 1.740))]
    brows.append(tube(f'kai_brow{sx}', pts, 0.0058, M['brow']))
mouth = tube('kai_mouth', [on_head(x, z, -0.003) for x, z in ((-0.026, 1.617), (-0.012, 1.608), (0.0, 1.606), (0.012, 1.608), (0.026, 1.617))], 0.0035, M['mouth'])

# hair: a cap that sinks into the scalp below the hairline (no open edges), plus clumps for a messy swept fringe
def smooth01(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


cap = ellipsoid('kai_tuft', HC + Vector((0, 0.010, 0.012)), (HR[0] * 1.085, HR[1] * 1.08, HR[2] * 1.07), M['hair'], 64, 40)
for v in cap.data.vertices:
    d = v.co - HC
    t = abs(math.atan2(d.x, -d.y)) / math.pi  # 0 front, 0.5 sides, 1 back
    line = 1.742 - 0.026 * smooth01(t / 0.5) if t < 0.5 else 1.716 - 0.10 * smooth01((t - 0.5) / 0.5)
    b = smooth01((line - v.co.z) / 0.022)
    if b > 0:
        v.co = HC + d * (1 - 0.13 * b)
clumps = []
for p, r, rot in (
    ((0.050, -0.098, 1.784), (0.050, 0.030, 0.026), (0.2, 0.0, 0.5)),
    ((0.012, -0.110, 1.786), (0.054, 0.030, 0.026), (0.25, 0.0, 0.25)),
    ((-0.030, -0.108, 1.789), (0.046, 0.028, 0.025), (0.25, 0.0, -0.15)),
    ((-0.066, -0.088, 1.778), (0.040, 0.026, 0.024), (0.2, 0.0, -0.5)),
    ((0.000, -0.040, 1.826), (0.090, 0.070, 0.040), (0.15, 0.0, 0.0)),
    ((0.060, 0.010, 1.812), (0.060, 0.070, 0.040), (0.0, 0.25, 0.0)),
    ((-0.060, 0.010, 1.812), (0.060, 0.070, 0.040), (0.0, -0.25, 0.0)),
    ((0.000, 0.070, 1.790), (0.080, 0.060, 0.050), (-0.3, 0.0, 0.0)),
):
    c = ellipsoid('kai_clump', (0, 0, 0), r, M['hair'], 24, 14)
    c.rotation_euler = rot
    c.location = p
    bpy.context.view_layer.objects.active = c
    c.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    c.select_set(False)
    clumps.append(c)
hair = cap
cowlick = tube('kai_cowlick', [Vector((0.004, 0.0, 1.85)), Vector((0.010, -0.006, 1.876)), Vector((0.030, -0.014, 1.882))], 0.0075, M['hair'])

# ----------------------------------------------------------------------------------------------- sneakers
def smooth01b(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


HEEL_Y, TOE_Y = 0.078, -0.178  # foot length ≈ 0.256 m (toe toward -Y)


def last_profile(t):
    """half-width and upper height along the foot (t: 0 heel → 1 toe)."""
    half = 0.036 + 0.014 * smooth01b(t / 0.65) - 0.016 * smooth01b((t - 0.82) / 0.18)
    top = 0.104 - 0.012 * smooth01b((t - 0.05) / 0.25) - 0.05 * smooth01b((t - 0.42) / 0.5)
    return half, top


def foot_mesh(name, sx, kind, mat):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=28, radius=1.0)
    x0 = 0.10 * sx
    for v in bm.verts:
        u, yn, w = v.co.x, v.co.y, v.co.z  # unit sphere coords
        t = (1 - yn) / 2  # yn = +1 heel, -1 toe
        half, top = last_profile(t)
        y = HEEL_Y + (TOE_Y - HEEL_Y) * t
        spring = 0.012 * smooth01b((t - 0.8) / 0.2)  # toe spring
        if kind == 'upper':
            base = 0.030 + spring * 0.6
            z = base + (top - base) * max(0.0, w) ** 0.85 if w > 0 else base - 0.004 * (-w)
            x = x0 + u * half
        else:  # sole: slightly wider, flat bottom, bumper rising at the toe
            bump = 0.016 * smooth01b((t - 0.86) / 0.14)
            z = spring + (0.032 + bump) * (w + 1) / 2
            x = x0 + u * (half + 0.006)
        v.co = Vector((x, y, z))
    bm.to_mesh(me)
    bm.free()
    o = link(bpy.data.objects.new(name, me))
    sub = o.modifiers.new('sub', 'SUBSURF')
    sub.levels = 1
    apply_modifiers(o)
    o.data.materials.append(mat)
    if kind == 'upper':
        o.data.materials.append(M['inner'])
        for poly in o.data.polygons:  # collar opening: the inside reads dark from above
            c = poly.center
            t = (HEEL_Y - c.y) / (HEEL_Y - TOE_Y)
            half, top = last_profile(t)
            if 0.08 < t < 0.40 and c.z > top - 0.012 and abs(c.x - x0) < half * 0.62:
                poly.material_index = 1
    else:
        o.data.materials.append(M['tread'])
        for poly in o.data.polygons:
            if poly.center.z < 0.004 + 0.012 * smooth01b(((HEEL_Y - poly.center.y) / (HEEL_Y - TOE_Y) - 0.8) / 0.2):
                poly.material_index = 1
    shade_smooth(o)
    return o


def upper_point(x0, t, a, out=0.0015):
    """point on the upper at foot fraction t and cross-section angle a (0 = top, ±pi/2 = sides), nudged outward."""
    yn = 1 - 2 * t
    rho = math.sqrt(max(0.0, 1 - yn * yn))
    u, w = rho * math.sin(a), rho * math.cos(a)
    half, top = last_profile(t)
    base = 0.030 + 0.012 * smooth01b((t - 0.8) / 0.2) * 0.6
    p = Vector((x0 + u * half, HEEL_Y + (TOE_Y - HEEL_Y) * t, base + (top - base) * max(0.0, w) ** 0.85))
    n = Vector((u / max(half, 1e-4), 0, w / max(top - base, 1e-4))).normalized()
    return p + n * out


shoes_by_side = {1: [], -1: []}
for sx in (1, -1):
    x0 = 0.10 * sx
    parts = [foot_mesh(f'kai_upper{sx}', sx, 'upper', M['shoe']), foot_mesh(f'kai_sole{sx}', sx, 'sole', M['sole'])]
    # side swooshes (both sides of each shoe) and a heel tab in the accent colour
    for side in (1, -1):
        parts.append(tube(f'kai_swoosh{sx}{side}', [upper_point(x0, t, side * a) for t, a in ((0.16, 0.95), (0.32, 1.12), (0.50, 1.20), (0.64, 1.05))], 0.0036, M['stripe'], res=12))
    parts.append(tube(f'kai_heeltab{sx}', [upper_point(x0, 0.035, math.pi * 0.62), upper_point(x0, 0.03, math.pi * 0.42)], 0.0055, M['stripe']))
    # laces across the vamp, lying on the surface
    for i, t in enumerate((0.44, 0.52, 0.60, 0.68)):
        parts.append(tube(f'kai_lace{sx}{i}', [upper_point(x0, t, a, 0.0022) for a in (-0.55, 0.0, 0.55)], 0.0026, M['lace']))
    shoes_by_side[sx] = parts

# ----------------------------------------------------------------------------------------------- binding
def bind_rigid(objs, bone):
    for o in objs:
        vg = o.vertex_groups.new(name=bone)
        vg.add([v.index for v in o.data.vertices], 1.0, 'REPLACE')
        o.parent = rig
        m = o.modifiers.new('rig', 'ARMATURE')
        m.object = rig


bind_rigid([head, nose, mouth, hair, cowlick, *clumps, *ears, *eye_parts, *brows], 'Head')
bind_rigid([hood, *strings, *tips], 'Spine2')
bind_rigid([hem], 'Hips')
bind_rigid([collar], 'Spine2')
bind_rigid([cuffs[0]], 'LeftForeArm')
bind_rigid([cuffs[1]], 'RightForeArm')
bind_rigid([ankles[0]], 'LeftLeg')
bind_rigid([ankles[1]], 'RightLeg')
bind_rigid(shoes_by_side[1], 'LeftFoot')
bind_rigid(shoes_by_side[-1], 'RightFoot')

# body: automatic (bone heat) weights
bpy.ops.object.select_all(action='DESELECT')
body.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
bpy.ops.object.select_all(action='DESELECT')

# join rigid head/face pieces into a few meshes to keep draw calls low
def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.select_set(False)
    return o


face = join([head, nose, mouth, *ears, *eye_parts, *brows], 'kai_face')
hairm = join([hair, cowlick, *clumps], 'kai_tuft')
top = join([hood, collar, *strings, *tips], 'kai_hood')
feet_l = join(shoes_by_side[1], 'kai_shoe_l')
feet_r = join(shoes_by_side[-1], 'kai_shoe_r')

# ----------------------------------------------------------------------------------------------- anchors (glTF space)
def gl(v):
    return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]


hair_top = max((hair_v.co.z for hair_v in hairm.data.vertices), default=1.82)
eyeL = on_head(0.044, EYE_Z, -0.012)
anchors = {
    'top': ('Head', gl((0, 0.0, hair_top))),
    'mouth': ('Head', gl(on_head(0, 1.608, -0.004))),
    'chin': ('Head', gl(on_head(0, 1.571, 0.0))),
    'nose': ('Head', gl(nose_p)),
    'eye_l': ('Head', gl(eyeL)),
    'eye_r': ('Head', gl(Vector((-eyeL.x, eyeL.y, eyeL.z)))),
    'ear_l': ('Head', gl((0.118, 0.012, 1.676))),
    'ear_r': ('Head', gl((-0.118, 0.012, 1.676))),
    'chest': ('Spine2', gl((0, -0.14, 1.36))),
    'belly': ('Spine', gl((0, -0.15, 1.10))),
}
scene['nudgi'] = {'height': round(hair_top, 4), 'anchors': {k: {'bone': b, 'p': p} for k, (b, p) in anchors.items()}}

# ----------------------------------------------------------------------------------------------- export
bpy.ops.object.select_all(action='DESELECT')
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB, export_format='GLB', export_skins=True, export_animations=False, export_yup=True,
    export_apply=False, export_extras=True, export_morph=False, export_texcoords=False,
)
print('KAI GLB', OUT_GLB, os.path.getsize(OUT_GLB), 'height', round(hair_top, 3))

# ----------------------------------------------------------------------------------------------- preview render
cam_data = bpy.data.cameras.new('cam')
cam_data.lens = 85
cam = link(bpy.data.objects.new('cam', cam_data))
cam.location = (1.6, -5.2, 1.25)
direction = Vector((0, 0, 0.95)) - cam.location
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
scene.camera = cam
for name, loc, energy, color in (('key', (2.5, -3.0, 3.5), 900, (1.0, 0.96, 0.9)), ('fill', (-3.0, -2.0, 2.0), 300, (0.85, 0.9, 1.0)), ('rim', (0.0, 3.0, 2.8), 700, (0.75, 0.9, 1.0))):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.energy = energy
    ld.size = 2.5
    ld.color = color
    lo = link(bpy.data.objects.new(name, ld))
    lo.location = loc
    lo.rotation_euler = (Vector((0, 0, 1.0)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
world = bpy.data.worlds.new('w')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.06, 0.08, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
scene.world = world
for eng in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
    try:
        scene.render.engine = eng
        break
    except TypeError:
        continue
scene.render.resolution_x = 900
scene.render.resolution_y = 1200
scene.render.film_transparent = False
for view, loc in (('front', (0.0, -5.4, 1.0)), ('three-quarter', (2.6, -4.6, 1.15)), ('face', (0.35, -1.7, 1.69)), ('shoes', (0.75, -0.95, 0.32))):
    cam.location = loc
    target = Vector((0, 0, 1.69)) if view == 'face' else Vector((0.05, -0.05, 0.05)) if view == 'shoes' else Vector((0, 0, 0.93))
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data.lens = 85 if view != 'face' else 90
    scene.render.filepath = os.path.join(OUT_DIR, f'preview-{view}.png')
    bpy.ops.render.render(write_still=True)
print('KAI PREVIEWS', OUT_DIR)
