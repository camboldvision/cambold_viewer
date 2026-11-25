/* SPDX-License-Identifier: Apache-2.0 */
import { DynamicDrawUsage } from "./vendor/three/three.module.js";
import { LineSegments2 } from "./vendor/three/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "./vendor/three/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "./vendor/three/lines/LineMaterial.js";

export const TRAJECTORY_CAPACITY = 60000;
const SAMPLE_PERIOD_MS = 50;
const MAX_GAP_MS = 500;

// Each ring slot holds the segment ending at one recorded pose. Independent
// segments allow FIFO eviction and stream gaps without copying the trajectory.
export class TrajectoryLayer {
    constructor(capacity = TRAJECTORY_CAPACITY) {
        if (!Number.isInteger(capacity) || capacity < 2)
            throw new RangeError("Trajectory capacity must be at least two.");
        this.capacity = capacity;
        this.positions = new Float32Array(capacity * 6);
        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(this.positions);
        this.buffer = geometry.attributes.instanceStart.data;
        this.buffer.setUsage(DynamicDrawUsage);
        this.line = new LineSegments2(
            geometry,
            new LineMaterial({
                color: "#62c6ff",
                linewidth: 2,
                depthTest: false,
                depthWrite: false,
            }),
        );
        this.line.frustumCulled = false;
        this.line.renderOrder = 5;
        this.clear();
    }

    clear() {
        this.count = 0;
        this.next = 0;
        this.context = null;
        this.lastTimestamp = null;
        this.lastBucket = null;
        this.discontinuous = true;
        this.dirtyStart = this.positions.length;
        this.dirtyEnd = 0;
        this.line.geometry.instanceCount = 0;
    }

    breakSegment() {
        this.discontinuous = true;
    }

    record(pose) {
        const p = pose?.p;
        const timestamp = Number(pose?.timestamp_ns) / 1e6;
        if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite) ||
            !Number.isFinite(timestamp) || timestamp <= 0) {
            this.breakSegment();
            return false;
        }
        const context = `${pose.run_id}:${pose.epoch}`;
        if (this.context !== context) {
            this.clear();
            this.context = context;
        }
        if (this.lastTimestamp !== null) {
            if (timestamp <= this.lastTimestamp) return false;
            if (timestamp - this.lastTimestamp > MAX_GAP_MS)
                this.breakSegment();
        }
        this.lastTimestamp = timestamp;
        // Device-time buckets sample at 20 Hz even when UI refresh timing varies.
        const bucket = Math.floor(timestamp / SAMPLE_PERIOD_MS);
        if (bucket === this.lastBucket) return false;
        this.lastBucket = bucket;

        const offset = this.next * 6;
        const previous = ((this.next + this.capacity - 1) % this.capacity) * 6;
        for (let axis = 0; axis < 3; axis++) {
            this.positions[offset + axis] = this.discontinuous
                ? p[axis] : this.positions[previous + 3 + axis];
            this.positions[offset + 3 + axis] = p[axis];
        }
        this.markDirty(offset);
        this.next = (this.next + 1) % this.capacity;
        if (this.count < this.capacity) this.count++;
        else {
            // The new oldest point must not reference the evicted point.
            const oldest = this.next * 6;
            for (let axis = 0; axis < 3; axis++)
                this.positions[oldest + axis] = this.positions[oldest + 3 + axis];
            this.markDirty(oldest);
        }
        this.discontinuous = false;
        this.line.geometry.instanceCount = this.count;
        return true;
    }

    markDirty(offset) {
        this.dirtyStart = Math.min(this.dirtyStart, offset);
        this.dirtyEnd = Math.max(this.dirtyEnd, offset + 6);
    }

    prepareRender() {
        if (this.dirtyEnd <= this.dirtyStart) return;
        // Keep dirty bookkeeping bounded even while hidden or display-paused.
        this.buffer.clearUpdateRanges();
        this.buffer.addUpdateRange(this.dirtyStart, this.dirtyEnd - this.dirtyStart);
        this.buffer.needsUpdate = true;
        this.dirtyStart = this.positions.length;
        this.dirtyEnd = 0;
    }
}
