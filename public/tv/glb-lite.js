// Minimal GLB (binary glTF) loader — no dependencies beyond three itself.
//
// Same house style as lib/ws-lite.js, lib/qrcode-lite.js and
// lib/selfsigned-lite.js: a small, readable implementation of exactly the
// slice this project needs, rather than a general-purpose library.
//
// WHY NOT three's own GLTFLoader: it is ~108KB of parser covering textures,
// animation, skinning, Draco compression, morph targets and a dozen glTF
// extensions. The asset pack in public/tv/models/ uses none of that — the
// files were inspected before this was written and between them they carry:
//
//   * POSITION only (no normals, no UVs, no vertex colours)
//   * mode 4 (TRIANGLES) only
//   * float32 VEC3 positions, uint32 scalar indices
//   * materials with nothing but pbrMetallicRoughness.baseColorFactor
//   * nodes with `children` and no transforms at all
//   * no extensions, no textures, no animations, no skins
//
// On a Fire TV Stick, 108KB of parser to read 1,344 triangles is the wrong
// trade. This is about 4KB and does the whole job.
//
// IF THE ASSETS EVER GROW BEYOND THAT — textured, animated or Draco-packed
// models — this parser will not silently produce something wrong: it throws,
// loadModel() catches, and the caller falls back to the hand-built box
// version of that object. The game keeps running; the model just doesn't
// appear. See ensureModels() in game.js for the fallback contract.

import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

// glTF componentType -> typed array
const COMPONENT = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function parseContainer(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB file');
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < view.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length)));
    } else if (type === CHUNK_BIN) {
      bin = buffer.slice(start, start + length);
    }
    offset = start + length;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

// Reads one accessor out of the binary chunk. Only the tightly-packed case
// is handled (byteStride absent), which is what every file in the pack uses;
// anything else throws rather than returning quietly-wrong geometry.
function readAccessor(json, bin, index) {
  const accessor = json.accessors[index];
  const ArrayType = COMPONENT[accessor.componentType];
  if (!ArrayType) throw new Error(`unsupported componentType ${accessor.componentType}`);
  const size = NUM_COMPONENTS[accessor.type];
  if (!size) throw new Error(`unsupported accessor type ${accessor.type}`);
  const view = json.bufferViews[accessor.bufferView];
  if (view.byteStride && view.byteStride !== size * ArrayType.BYTES_PER_ELEMENT) {
    throw new Error('interleaved accessors are not supported');
  }
  const offset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  return new ArrayType(bin, offset, accessor.count * size);
}

function materialFor(json, index) {
  const def = (json.materials || [])[index];
  const factor = def?.pbrMetallicRoughness?.baseColorFactor;
  const color = new THREE.Color();
  if (factor) {
    // baseColorFactor is linear; three's Color.setRGB defaults to the
    // working (linear) space, so this converts correctly on output rather
    // than arriving washed out the way an untagged sRGB value would.
    color.setRGB(factor[0], factor[1], factor[2]);
  } else {
    color.set(0xcccccc);
  }
  // Lambert, not Standard. The models ship PBR materials, but a Fire TV
  // Stick pays real per-pixel cost for metalness/roughness on every surface
  // and this art style — flat, saturated, no texture maps — gets nothing
  // back for it. The base colour is the whole of the information here.
  return new THREE.MeshLambertMaterial({ color });
}

function buildMesh(json, bin, meshIndex, materialCache) {
  const group = new THREE.Group();
  for (const prim of json.meshes[meshIndex].primitives) {
    if (prim.mode !== undefined && prim.mode !== 4) throw new Error('only TRIANGLES are supported');
    const position = prim.attributes.POSITION;
    if (position === undefined) throw new Error('primitive has no POSITION');

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(readAccessor(json, bin, position), 3));
    if (prim.attributes.NORMAL !== undefined) {
      geometry.setAttribute('normal', new THREE.BufferAttribute(readAccessor(json, bin, prim.attributes.NORMAL), 3));
    }
    if (prim.indices !== undefined) {
      geometry.setIndex(new THREE.BufferAttribute(readAccessor(json, bin, prim.indices), 1));
    }
    // These models carry positions only. Without normals every face would be
    // lit identically and the whole model would read as a flat silhouette —
    // which is exactly the failure that makes low-poly look broken rather
    // than stylised.
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();

    const key = prim.material === undefined ? -1 : prim.material;
    if (!materialCache.has(key)) materialCache.set(key, materialFor(json, key));
    group.add(new THREE.Mesh(geometry, materialCache.get(key)));
  }
  return group;
}

function buildNode(json, bin, nodeIndex, materialCache) {
  const def = json.nodes[nodeIndex];
  const node = new THREE.Group();
  node.name = def.name || '';
  if (def.mesh !== undefined) node.add(buildMesh(json, bin, def.mesh, materialCache));
  // Node transforms: the pack uses none, but honouring them is a few lines
  // and means a model authored with them doesn't silently come out wrong.
  if (def.matrix) {
    node.applyMatrix4(new THREE.Matrix4().fromArray(def.matrix));
  } else {
    if (def.translation) node.position.fromArray(def.translation);
    if (def.rotation) node.quaternion.fromArray(def.rotation);
    if (def.scale) node.scale.fromArray(def.scale);
  }
  for (const child of def.children || []) node.add(buildNode(json, bin, child, materialCache));
  return node;
}

/**
 * Fetches and parses a .glb into a THREE.Group, normalised for this game:
 *
 *   - rotated from glTF/Blender Z-up into three's Y-up
 *   - centred on x/z and sat on the ground, so position.y = 0 means "feet
 *     on the floor" for every model regardless of how it was authored
 *   - scaled so its height matches `height` in game units, if given
 *
 * Normalising here rather than at each call site is what lets the game treat
 * a downloaded model and a hand-built box as interchangeable.
 */
export async function loadModel(url, options = {}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const { json, bin } = parseContainer(await response.arrayBuffer());
  if (!bin) throw new Error('GLB has no binary chunk');

  const materialCache = new Map();
  const root = new THREE.Group();
  const scene = json.scenes[json.scene || 0];
  for (const nodeIndex of scene.nodes) root.add(buildNode(json, bin, nodeIndex, materialCache));

  // Z-up -> Y-up. Applied to a wrapper so the measurement below sees the
  // model the way the game will.
  const oriented = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  oriented.add(root);

  const box = new THREE.Box3().setFromObject(oriented);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);

  // Scale by height OR width. Height is the natural choice for anything
  // that stands up — a soldier, a column, a dinosaur. But the pack also
  // contains flat, wide things (a road gap, a portal disc, a drone) whose
  // height is nearly zero, and normalising those by height inflates them to
  // absurd sizes: the portal came out 47 units across. Whichever dimension
  // actually characterises the object is the one to scale by.
  const target = options.height ? options.height / size.y
    : options.width ? options.width / size.x
      : 0;
  if (target > 0 && Number.isFinite(target)) {
    root.scale.multiplyScalar(target);
    box.setFromObject(oriented);
    box.getSize(size);
    box.getCenter(centre);
  }
  root.position.x -= centre.x;
  root.position.z -= centre.z;
  root.position.y -= box.min.y;

  oriented.userData.size = size.clone();
  return oriented;
}
