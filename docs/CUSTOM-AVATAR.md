# Create your own avatar

1. Open **Buddy → Make it yours · Avatar guide**.
2. Choose **Open avaturn.me**, then create your avatar on [Avaturn](https://avaturn.me/).
3. Export a **GLB in T-pose**, with its skeleton and embedded textures, under 25 MB. Export availability is controlled by Avaturn.
4. Choose **Import 3D avatar** and select the file.
5. Test a reminder to check walking, hand-held props and entrances.

The procedural adapter supports Avaturn-style humanoid skeletons with unprefixed standard bone names
(such as `Hips`, `LeftArm`, `LeftHand`, `LeftUpLeg`). It is tuned for adult proportions near 1.86 m in a T-pose.
Other proportions may need adjustments; arbitrary GLB models are not supported. Compressed models,
external textures and files without the required rig are rejected.

The model is copied into `%APPDATA%\Nudge Buddy\avatars\avatar.glb`; replacing it keeps the old model as
`avatar.glb.previous`. Nudgi never uploads models, reminders or statistics. Creating an avatar on Avaturn is
an online activity governed by that service's own terms and privacy policy.

Select Kai to return to the bundled 3D character. If a model cannot render, Nudgi falls back to Kai (and to the
2D Kai when WebGL is unavailable).
The public repository and app do not contain the author's personal avatar.
