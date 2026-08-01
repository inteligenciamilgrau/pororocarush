// Boto-cor-de-rosa companion. It periodically joins the surfer for a few
// seconds, porpoising along the face of the wave before diving away again.
// Visual-only: it never participates in physics or collision queries.

import * as THREE from 'three';

const TAU = Math.PI * 2;
const FIRST_APPEARANCE = 6.5;
const EPISODE_LENGTH = 11.5;
const EPISODE_PERIOD = 31.0;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (a, b, value) => {
  const t = clamp((value - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
const damp = (current, target, rate, dt) =>
  current + (target - current) * (1 - Math.exp(-rate * Math.max(0, dt)));

function triangleGeometry(points) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export class Boto {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = ctx.state;
    this.bore = ctx.bore;
    this.bus = ctx.bus;
    this.root = new THREE.Group();
    this.root.name = 'boto-cor-de-rosa';
    this.root.visible = false;
    this.materials = [];
    this.episode = -1;
    this.side = 1;
    this.wasAbove = false;
    this.initialized = false;
    this._buildBoto();
    this._buildWake();
    ctx.scene.add(this.root, this.wake);
    ctx.boto = this;
  }

  _material(color, roughness = 0.72, metalness = 0) {
    const material = new THREE.MeshStandardMaterial({
      color, roughness, metalness, transparent: true, opacity: 1,
      side: THREE.DoubleSide,
    });
    material.userData.baseOpacity = 1;
    this.materials.push(material);
    return material;
  }

  _mesh(geometry, material, name) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    this.root.add(mesh);
    return mesh;
  }

  _buildBoto() {
    const pink = this._material(0xd9828c, 0.68);
    const lightPink = this._material(0xf0a7aa, 0.78);
    const darkPink = this._material(0xa95568, 0.72);
    const eyeMat = this._material(0x171116, 0.32);

    const body = this._mesh(new THREE.SphereGeometry(1, 22, 14), pink, 'boto:body');
    body.scale.set(0.52, 0.42, 1.42);
    body.position.z = -0.02;

    const belly = this._mesh(new THREE.SphereGeometry(1, 18, 10), lightPink, 'boto:belly');
    belly.scale.set(0.43, 0.29, 1.10);
    belly.position.set(0, -0.17, 0.13);

    const head = this._mesh(new THREE.SphereGeometry(0.58, 20, 12), pink, 'boto:head');
    head.scale.set(0.88, 0.78, 1.02);
    head.position.set(0, 0.07, 1.05);

    const melon = this._mesh(new THREE.SphereGeometry(0.42, 18, 10), lightPink, 'boto:melon');
    melon.scale.set(0.9, 0.72, 0.88);
    melon.position.set(0, 0.24, 1.30);

    const snout = this._mesh(
      new THREE.CylinderGeometry(0.09, 0.19, 0.80, 12, 2),
      lightPink,
      'boto:long-snout',
    );
    snout.rotation.x = Math.PI / 2;
    snout.position.set(0, -0.02, 1.62);

    const peduncle = this._mesh(
      new THREE.CylinderGeometry(0.21, 0.105, 0.82, 12, 3),
      darkPink,
      'boto:tail-stock',
    );
    peduncle.rotation.x = Math.PI / 2;
    peduncle.position.z = -1.48;

    const dorsal = this._mesh(triangleGeometry([
      0, 0.25, -0.28,  0, 0.88, -0.72,  0, 0.19, -1.00,
    ]), darkPink, 'boto:dorsal-fin');
    dorsal.position.y = 0.06;

    const leftFin = this._mesh(triangleGeometry([
      0.31, -0.03, 0.50,  1.05, -0.18, -0.03,  0.25, -0.15, -0.43,
    ]), darkPink, 'boto:left-fin');
    const rightFin = this._mesh(triangleGeometry([
      -0.31, -0.03, 0.50,  -1.05, -0.18, -0.03,  -0.25, -0.15, -0.43,
    ]), darkPink, 'boto:right-fin');
    this.leftFin = leftFin;
    this.rightFin = rightFin;

    this.tail = new THREE.Group();
    this.tail.name = 'boto:tail-flukes';
    this.tail.position.z = -1.86;
    this.root.add(this.tail);
    const leftFluke = new THREE.Mesh(triangleGeometry([
      0, 0, 0.12,  0.88, 0.035, -0.12,  0.50, 0.01, 0.30,
    ]), darkPink);
    const rightFluke = new THREE.Mesh(triangleGeometry([
      0, 0, 0.12,  -0.88, 0.035, -0.12,  -0.50, 0.01, 0.30,
    ]), darkPink);
    leftFluke.castShadow = rightFluke.castShadow = true;
    this.tail.add(leftFluke, rightFluke);

    for (const side of [-1, 1]) {
      const eye = this._mesh(new THREE.SphereGeometry(0.047, 10, 7), eyeMat, 'boto:eye');
      eye.position.set(side * 0.40, 0.18, 1.25);
      eye.scale.z = 0.55;
    }

    this.root.scale.setScalar(0.92);
  }

  _buildWake() {
    this.wake = new THREE.Group();
    this.wake.name = 'boto:wake';
    this.wake.visible = false;
    this.rings = [];
    for (let i = 0; i < 4; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: i % 2 ? 0xd7f0e7 : 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.52, 26), material);
      ring.rotation.x = -Math.PI / 2;
      ring.position.z = -0.45 - i * 0.48;
      ring.userData.phase = i * 0.23;
      this.wake.add(ring);
      this.rings.push(ring);
    }
  }

  step(dt) {
    const p = this.state.player;
    const t = Number(this.state.time) || 0;
    if (!p || t < FIRST_APPEARANCE || p.wipeout) {
      this._hide();
      return;
    }

    const sinceFirst = t - FIRST_APPEARANCE;
    const episode = Math.floor(sinceFirst / EPISODE_PERIOD);
    const age = sinceFirst - episode * EPISODE_PERIOD;
    if (age >= EPISODE_LENGTH) {
      this._hide();
      return;
    }

    if (episode !== this.episode) {
      this.episode = episode;
      this.side = episode % 2 === 0 ? 1 : -1;
      this.initialized = false;
      this.wasAbove = false;
      this._emit('boto:appear', { side: this.side });
    }

    const fadeIn = smoothstep(0, 1.0, age);
    const fadeOut = 1 - smoothstep(EPISODE_LENGTH - 1.6, EPISODE_LENGTH, age);
    const fade = fadeIn * fadeOut;
    const heading = Number.isFinite(p.heading) ? p.heading : 0;
    const rightX = Math.cos(heading), rightZ = -Math.sin(heading);
    const forwardX = Math.sin(heading), forwardZ = Math.cos(heading);
    const lateral = this.side * (4.1 + Math.sin(age * 0.74 + episode) * 0.55);
    const fore = -0.7 + Math.sin(age * 0.48 + episode * 0.9) * 1.35;
    let x = p.x + rightX * lateral + forwardX * fore;
    let z = p.z + rightZ * lateral + forwardZ * fore;
    if (this.ctx.river?.clampToChannel) x = this.ctx.river.clampToChannel(x, z, 9);

    const porpoise = age * TAU / 2.65 + episode * 0.71;
    const wave = Math.sin(porpoise);
    const leap = Math.max(0, wave) ** 1.55;
    const waterY = this._waterY(x, z, t);
    const y = waterY - 0.28 + leap * 1.34;

    if (!this.initialized) {
      this.root.position.set(x, y, z);
      this.initialized = true;
    } else {
      this.root.position.x = damp(this.root.position.x, x, 5.0, dt);
      this.root.position.y = damp(this.root.position.y, y, 7.5, dt);
      this.root.position.z = damp(this.root.position.z, z, 5.0, dt);
    }

    const pitch = wave > 0 ? -Math.cos(porpoise) * 0.34 : Math.sin(porpoise * 0.5) * 0.07;
    this.root.rotation.x = damp(this.root.rotation.x, pitch, 7, dt);
    this.root.rotation.y = damp(this.root.rotation.y, heading, 8, dt);
    this.root.rotation.z = damp(this.root.rotation.z, -this.side * 0.07 + Math.sin(age * 2.1) * 0.04, 6, dt);
    this.tail.rotation.x = Math.sin(t * 10.8) * (0.20 + (1 - leap) * 0.15);
    this.leftFin.rotation.z = Math.sin(t * 4.2) * 0.12;
    this.rightFin.rotation.z = -Math.sin(t * 4.2) * 0.12;

    this.root.visible = true;
    for (const material of this.materials) material.opacity = material.userData.baseOpacity * fade;
    this._updateWake(x, z, waterY, heading, fade * (1 - leap), t);

    const above = wave > 0.08 && fade > 0.35;
    if (above && !this.wasAbove) {
      this._emit('boto:surface', { side: this.side, x, y: waterY, z });
    }
    this.wasAbove = above;
  }

  _updateWake(x, z, waterY, heading, amount, time) {
    this.wake.visible = amount > 0.015;
    this.wake.position.set(x, waterY + 0.045, z);
    this.wake.rotation.y = heading;
    for (const ring of this.rings) {
      const pulse = (time * 0.7 + ring.userData.phase) % 1;
      const scale = 0.72 + pulse * 1.35;
      ring.scale.set(scale, scale, scale);
      ring.material.opacity = amount * (1 - pulse) * 0.32;
    }
  }

  _waterY(x, z, t) {
    if (this.ctx.river?.waterY) return this.ctx.river.waterY(x, z, t);
    try {
      const y = this.bore?.height?.(x, z, t);
      return Number.isFinite(y) ? y : 0;
    } catch { return 0; }
  }

  _hide() {
    this.root.visible = false;
    this.wake.visible = false;
    this.wasAbove = false;
    this.initialized = false;
  }

  _emit(event, payload) {
    try { this.bus?.emit?.(event, payload); } catch { /* visual companion is optional */ }
  }

  dispose() {
    this.ctx.scene.remove(this.root, this.wake);
    this.root.traverse((object) => object.geometry?.dispose?.());
    this.wake.traverse((object) => {
      object.geometry?.dispose?.();
      object.material?.dispose?.();
    });
    for (const material of this.materials) material.dispose();
    if (this.ctx.boto === this) this.ctx.boto = null;
  }
}
