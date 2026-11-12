/* SPDX-License-Identifier: Apache-2.0 */
import * as THREE from "./vendor/three/three.module.js";

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function decodePoints(encoded, count, geometry) {
    if (!Number.isInteger(count) || count < 0 || count > 131072)
        throw new Error("关键帧点云长度无效");
    let bytes;
    if (typeof Uint8Array.fromBase64 === "function")
        bytes = Uint8Array.fromBase64(encoded);
    else {
        const raw = atob(encoded);
        bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; ++i) bytes[i] = raw.charCodeAt(i);
    }
    if (bytes.length !== count * 16) throw new Error("关键帧点云长度无效");

    const reusable = geometry && geometry.attributes.position.count === count;
    const positions = reusable
        ? geometry.attributes.position.array
        : new Float32Array(count * 3);
    const colors = reusable
        ? geometry.attributes.color.array
        : new Uint8Array(count * 3);
    const floats =
        littleEndian && bytes.byteOffset % 4 === 0
            ? new Float32Array(bytes.buffer, bytes.byteOffset, count * 4)
            : null;
    const view = floats
        ? null
        : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    for (let i = 0, j = 0; i < count; ++i, j += 3) {
        const offset = i * 16,
            f = i * 4;
        const x = floats ? floats[f] : view.getFloat32(offset, true);
        const y = floats ? floats[f + 1] : view.getFloat32(offset + 4, true);
        const z = floats ? floats[f + 2] : view.getFloat32(offset + 8, true);
        positions[j] = x;
        positions[j + 1] = y;
        positions[j + 2] = z;
        colors[j] = bytes[offset + 12];
        colors[j + 1] = bytes[offset + 13];
        colors[j + 2] = bytes[offset + 14];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }
    if (!reusable) {
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            "position",
            new THREE.BufferAttribute(positions, 3),
        );
        geometry.setAttribute(
            "color",
            new THREE.BufferAttribute(colors, 3, true),
        );
    } else {
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.color.needsUpdate = true;
    }
    // A box-enclosing sphere is conservative and needs no second point traversal.
    geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3(minX, minY, minZ),
        new THREE.Vector3(maxX, maxY, maxZ),
    );
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(
        new THREE.Sphere(),
    );
    return geometry;
}

export class MapLayer {
    constructor() {
        this.points = new THREE.Group();
        this.nodes = new Map();
        this.count = 0;
        this.slots = [];
        this.capacity = 0;
        this.shapeSize = 0;
        this.matrixAttribute = null;
        this.matrixDirty = false;
        this.position = new THREE.Vector3();
        this.quaternion = new THREE.Quaternion();
        this.unitScale = new THREE.Vector3(1, 1, 1);
        this.pointMaterial = new THREE.PointsMaterial({
            vertexColors: true,
            size: 0.025,
            sizeAttenuation: true,
        });
        const material = new THREE.LineBasicMaterial({ color: "#f3b65c" });
        material.onBeforeCompile = (shader) => {
            shader.vertexShader =
                "attribute mat4 keyframeMatrix;\n" + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace(
                "#include <begin_vertex>",
                "vec3 transformed = (keyframeMatrix * vec4(position, 1.0)).xyz;",
            );
        };
        material.customProgramCacheKey = () => "cambold-keyframe-matrices-v1";
        const geometry = new THREE.InstancedBufferGeometry();
        geometry.setAttribute(
            "position",
            new THREE.BufferAttribute(new Float32Array(0), 3),
        );
        geometry.setDrawRange(0, 0);
        geometry.instanceCount = 0;
        this.keyframes = new THREE.LineSegments(geometry, material);
        this.keyframes.frustumCulled = false;
    }

    get keyframeCount() {
        return this.shapeSize ? this.nodes.size : 0;
    }

    setFrustumShape(shape) {
        const positions = new Float32Array(shape.length * 3);
        for (let i = 0; i < shape.length; ++i)
            shape[i].toArray(positions, i * 3);
        // Retire the previous GPU attributes when the camera geometry changes.
        const old = this.keyframes.geometry,
            geometry = new THREE.InstancedBufferGeometry();
        geometry.setAttribute(
            "position",
            new THREE.BufferAttribute(positions, 3),
        );
        if (this.matrixAttribute)
            geometry.setAttribute("keyframeMatrix", this.matrixAttribute);
        geometry.setDrawRange(0, shape.length);
        geometry.instanceCount = this.nodes.size;
        this.keyframes.geometry = geometry;
        old.dispose();
        this.shapeSize = shape.length;
    }

    ensureCapacity(size) {
        if (size <= this.capacity) return;
        this.capacity = Math.max(64, this.capacity * 2, size);
        const matrices = new Float32Array(this.capacity * 16);
        if (this.matrixAttribute) matrices.set(this.matrixAttribute.array);
        this.matrixAttribute = new THREE.InstancedBufferAttribute(
            matrices,
            16,
        ).setUsage(THREE.DynamicDrawUsage);
        const old = this.keyframes.geometry,
            geometry = new THREE.InstancedBufferGeometry();
        geometry.setAttribute("position", old.attributes.position);
        geometry.setAttribute("keyframeMatrix", this.matrixAttribute);
        geometry.setDrawRange(0, this.shapeSize);
        geometry.instanceCount = this.nodes.size;
        this.keyframes.geometry = geometry;
        old.dispose();
    }

    setPose(node, p, q) {
        if (
            node.p &&
            p.every((v, i) => v === node.p[i]) &&
            q.every((v, i) => v === node.q[i])
        )
            return;
        node.p = p;
        node.q = q;
        this.position.fromArray(p);
        this.quaternion.fromArray(q).normalize();
        node.matrix.compose(this.position, this.quaternion, this.unitScale);
        this.matrixAttribute.array.set(node.matrix.elements, node.slot * 16);
        this.matrixAttribute.addUpdateRange(node.slot * 16, 16);
        this.matrixDirty = true;
    }

    erase(id) {
        const node = this.nodes.get(id);
        if (!node) return;
        if (node.object) {
            this.points.remove(node.object);
            node.object.geometry.dispose();
        }
        this.count -= node.count;
        const lastId = this.slots.pop();
        if (lastId !== id) {
            const moved = this.nodes.get(lastId),
                source = moved.slot * 16;
            this.slots[node.slot] = lastId;
            moved.slot = node.slot;
            this.matrixAttribute.array.copyWithin(
                node.slot * 16,
                source,
                source + 16,
            );
            this.matrixAttribute.addUpdateRange(node.slot * 16, 16);
            this.matrixDirty = true;
        }
        this.nodes.delete(id);
    }

    clear() {
        for (const node of this.nodes.values())
            if (node.object) {
                this.points.remove(node.object);
                node.object.geometry.dispose();
            }
        this.nodes.clear();
        this.slots.length = 0;
        this.count = 0;
        this.keyframes.geometry.instanceCount = 0;
        if (this.matrixAttribute) this.matrixAttribute.clearUpdateRanges();
        this.matrixDirty = false;
    }

    apply(delta) {
        if (delta.reset) this.clear();
        for (const change of delta.updates || []) {
            const id = String(change.id);
            if (change.action === "erase") {
                this.erase(id);
                continue;
            }
            let node = this.nodes.get(id);
            if (change.action === "upsert") {
                const count = Number(change.count);
                const previous = node?.object?.geometry;
                const geometry = decodePoints(change.xyzrgb16, count, previous);
                if (!node) {
                    this.ensureCapacity(this.nodes.size + 1);
                    node = {
                        slot: this.slots.length,
                        count: 0,
                        object: null,
                        matrix: new THREE.Matrix4(),
                        p: null,
                        q: null,
                    };
                    this.slots.push(id);
                    this.nodes.set(id, node);
                }
                this.count += count - node.count;
                node.count = count;
                if (count) {
                    if (!node.object) {
                        node.object = new THREE.Points(
                            geometry,
                            this.pointMaterial,
                        );
                        node.object.matrixAutoUpdate = false;
                        this.points.add(node.object);
                    } else node.object.geometry = geometry;
                } else if (node.object) {
                    this.points.remove(node.object);
                    node.object = null;
                }
                if (previous && previous !== geometry) previous.dispose();
                if (!count) geometry.dispose();
            }
            if (!node) throw new Error("关键帧位姿缺少对应节点");
            this.setPose(node, change.p, change.q);
            if (node.object) {
                node.object.matrix.copy(node.matrix);
                node.object.matrixWorldNeedsUpdate = true;
            }
        }
        this.keyframes.geometry.instanceCount = this.nodes.size;
        if (this.matrixDirty) {
            this.matrixAttribute.needsUpdate = true;
            this.matrixDirty = false;
        }
    }
}
