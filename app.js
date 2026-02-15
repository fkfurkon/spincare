/* ===================================================================
   SpinCare — Wound Healing Game  v2
   Direct-aim spray · Accurate coverage · Random wound shapes
   =================================================================== */

import * as THREE from 'three';

// ─── Game State ──────────────────────────────────────────────────────
const G = {
    phase: 'intro',     // intro | playing | won
    isSpraying: false,
    coverage: 0,
    totalFibers: 0,
    power: 3,           // 1-5
    polymer: 'PCL',
    startTime: 0,
    elapsed: 0,
    // Aim point (raycast hit on wound plane in world coords)
    aimX: 0,
    aimZ: 0,
    mouseScreen: { x: 0, y: 0 },
    mouseNDC: new THREE.Vector2(0, 0),
    hasAim: false,       // true when mouse is over the wound area
};

const POLYMERS = {
    PCL: { hex: 0x0891b2, css: '#0891b2', fiber: 'rgba(8,145,178,' },
    PVA: { hex: 0x7c3aed, css: '#7c3aed', fiber: 'rgba(124,58,237,' },
    PLGA: { hex: 0x059669, css: '#059669', fiber: 'rgba(5,150,105,' },
    Chitosan: { hex: 0xd97706, css: '#d97706', fiber: 'rgba(217,119,6,' },
};

// ─── Wound Shape ─────────────────────────────────────────────────────
// The wound is defined by a 128×128 mask (1 = wound, 0 = skin)
const W_GRID = 128;
const woundMask = new Uint8Array(W_GRID * W_GRID);   // 1 = wound cell
const coverageGrid = new Float32Array(W_GRID * W_GRID);  // 0.0-1.0 coverage
const WOUND_WORLD = 3.5;   // world-space radius the wound texture covers
const CELL_SIZE = (WOUND_WORLD * 2) / W_GRID;        // world units per grid cell
// Coverage = average of all cell values (0.0–1.0), so it matches visual appearance

let woundCellCount = 0;     // total wound cells (for % calculation)

// Wound types — each returns a function (gx, gy) => boolean
const WOUND_TYPES = [
    // Irregular blob — overlapping circles
    () => {
        const numBlobs = 3 + Math.floor(Math.random() * 4);
        const blobs = [];
        for (let i = 0; i < numBlobs; i++) {
            blobs.push({
                cx: W_GRID / 2 + (Math.random() - 0.5) * W_GRID * 0.35,
                cy: W_GRID / 2 + (Math.random() - 0.5) * W_GRID * 0.35,
                r: W_GRID * (0.12 + Math.random() * 0.2),
            });
        }
        return (gx, gy) => blobs.some(b => {
            const dx = gx - b.cx, dy = gy - b.cy;
            return dx * dx + dy * dy < b.r * b.r;
        });
    },
    // Elongated oval
    () => {
        const angle = Math.random() * Math.PI;
        const rx = W_GRID * (0.15 + Math.random() * 0.15);
        const ry = W_GRID * (0.28 + Math.random() * 0.12);
        const cos = Math.cos(angle), sin = Math.sin(angle);
        return (gx, gy) => {
            const dx = gx - W_GRID / 2, dy = gy - W_GRID / 2;
            const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
            return (u * u) / (rx * rx) + (v * v) / (ry * ry) < 1;
        };
    },
    // Star-shaped burn
    () => {
        const cx = W_GRID / 2, cy = W_GRID / 2;
        const points = 5 + Math.floor(Math.random() * 4);
        const rOuter = W_GRID * (0.25 + Math.random() * 0.1);
        const rInner = rOuter * (0.4 + Math.random() * 0.2);
        const rot = Math.random() * Math.PI * 2;
        return (gx, gy) => {
            const dx = gx - cx, dy = gy - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const angle = Math.atan2(dy, dx) + rot;
            const t = ((angle / (Math.PI * 2)) * points % 1 + 1) % 1;
            const rAt = t < 0.5
                ? rInner + (rOuter - rInner) * (1 - Math.abs(t - 0.25) * 4)
                : rInner + (rOuter - rInner) * (1 - Math.abs(t - 0.75) * 4);
            return dist < rAt;
        };
    },
    // Linear gash (thick line)
    () => {
        const cx = W_GRID / 2, cy = W_GRID / 2;
        const angle = Math.random() * Math.PI;
        const length = W_GRID * (0.3 + Math.random() * 0.15);
        const width = W_GRID * (0.08 + Math.random() * 0.06);
        const cos = Math.cos(angle), sin = Math.sin(angle);
        // Add some branching
        const branches = [];
        const numBranch = Math.floor(Math.random() * 3);
        for (let i = 0; i < numBranch; i++) {
            const t = 0.2 + Math.random() * 0.6;
            const bAngle = angle + (Math.random() - 0.5) * 1.5;
            branches.push({
                ox: cx + cos * length * (t - 0.5), oy: cy + sin * length * (t - 0.5),
                cos: Math.cos(bAngle), sin: Math.sin(bAngle),
                len: length * (0.2 + Math.random() * 0.3), w: width * 0.6
            });
        }
        return (gx, gy) => {
            // Main line
            const dx = gx - cx, dy = gy - cy;
            const along = dx * cos + dy * sin;
            const perp = Math.abs(-dx * sin + dy * cos);
            if (Math.abs(along) < length / 2 && perp < width) return true;
            // Branches
            for (const b of branches) {
                const bdx = gx - b.ox, bdy = gy - b.oy;
                const ba = bdx * b.cos + bdy * b.sin;
                const bp = Math.abs(-bdx * b.sin + bdy * b.cos);
                if (Math.abs(ba) < b.len / 2 && bp < b.w) return true;
            }
            return false;
        };
    },
    // Multi-spot wounds (scattered small circles)
    () => {
        const spots = [];
        const n = 4 + Math.floor(Math.random() * 5);
        for (let i = 0; i < n; i++) {
            spots.push({
                cx: W_GRID / 2 + (Math.random() - 0.5) * W_GRID * 0.5,
                cy: W_GRID / 2 + (Math.random() - 0.5) * W_GRID * 0.5,
                r: W_GRID * (0.05 + Math.random() * 0.1),
            });
        }
        return (gx, gy) => spots.some(s => {
            const dx = gx - s.cx, dy = gy - s.cy;
            return dx * dx + dy * dy < s.r * s.r;
        });
    },
];

function generateWound() {
    woundMask.fill(0);
    coverageGrid.fill(0);
    G.coverage = 0;

    // Pick random wound type
    const typeFn = WOUND_TYPES[Math.floor(Math.random() * WOUND_TYPES.length)]();

    woundCellCount = 0;
    for (let y = 0; y < W_GRID; y++) {
        for (let x = 0; x < W_GRID; x++) {
            // Keep wound within visible circle (canvas/texture is circular)
            const dx = x - W_GRID / 2, dy = y - W_GRID / 2;
            const inCircle = dx * dx + dy * dy < (W_GRID * 0.44) * (W_GRID * 0.44);
            if (inCircle && typeFn(x, y)) {
                woundMask[y * W_GRID + x] = 1;
                woundCellCount++;
            }
        }
    }
    // Ensure at least some wound cells
    if (woundCellCount < 50) return generateWound();
}

function isWoundCell(gx, gy) {
    if (gx < 0 || gx >= W_GRID || gy < 0 || gy >= W_GRID) return false;
    return woundMask[gy * W_GRID + gx] === 1;
}

// ── World ↔ Grid coordinate helpers ─────────────────────────────────
function worldToGrid(wx, wz) {
    return {
        gx: (wx + WOUND_WORLD) / (WOUND_WORLD * 2) * W_GRID,
        gy: (wz + WOUND_WORLD) / (WOUND_WORLD * 2) * W_GRID,
    };
}

// Spray at aim point with Gaussian falloff (world-space radius)
// dt = delta time for frame-rate independence
let _lastOverlayUpdate = 0;

function sprayAtAim(worldX, worldZ, worldRadius, dt) {
    const { gx, gy } = worldToGrid(worldX, worldZ);
    const gridRadius = worldRadius / CELL_SIZE;
    const r = Math.ceil(gridRadius);
    const sigma = gridRadius * 0.85;  // wider spread so edges accumulate properly
    const sigma2 = sigma * sigma;
    const rate = G.power * 1.5 * dt;  // faster accumulation to match visual

    const s = 512;
    const cellPx = s / W_GRID;
    const poly = POLYMERS[G.polymer];
    let changed = false;

    for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
            const dist2 = dx * dx + dy * dy;
            if (dist2 > gridRadius * gridRadius) continue;
            const nx = Math.round(gx + dx);
            const ny = Math.round(gy + dy);
            if (!isWoundCell(nx, ny)) continue;
            const idx = ny * W_GRID + nx;
            if (coverageGrid[idx] >= 1.0) continue;

            const falloff = Math.exp(-dist2 / (2 * sigma2));
            const add = rate * falloff * (0.8 + Math.random() * 0.4);
            const prev = coverageGrid[idx];
            coverageGrid[idx] = Math.min(1.0, prev + add);

            if (coverageGrid[idx] !== prev) {
                changed = true;
                // Paint this cell directly on canvas (incremental)
                const alpha = Math.min(0.55, coverageGrid[idx] * 0.55);
                const px = (nx / W_GRID) * s;
                const py = (ny / W_GRID) * s;
                woundCtx.fillStyle = poly.fiber + alpha + ')';
                woundCtx.fillRect(px, py, cellPx + 0.5, cellPx + 0.5);
            }
        }
    }
    if (changed) {
        recalcCoverage();
        // Throttle texture upload to GPU (max ~15/s)
        const now = performance.now();
        if (now - _lastOverlayUpdate > 66) {
            woundTexture.needsUpdate = true;
            _lastOverlayUpdate = now;
        }
    }
}

function recalcCoverage() {
    if (woundCellCount === 0) { G.coverage = 0; return; }
    let totalCoverage = 0;
    for (let i = 0; i < W_GRID * W_GRID; i++) {
        if (!woundMask[i]) continue;
        totalCoverage += coverageGrid[i]; // each cell is 0.0–1.0
    }
    // Pure average: directly reflects what the user sees
    G.coverage = (totalCoverage / woundCellCount) * 100;
}

// ─── Three.js Globals ────────────────────────────────────────────────
let scene, camera, renderer;
let deviceGroup, raycaster, woundPlane;
let woundCanvas, woundCtx, woundTexture;
let clock;

// Particles
const P_COUNT = 800;
const pPos = new Float32Array(P_COUNT * 3);
const pVel = new Float32Array(P_COUNT * 3);
const pAlpha = new Float32Array(P_COUNT);
const pSize = new Float32Array(P_COUNT);
const pLife = new Float32Array(P_COUNT);
const pPhase = new Float32Array(P_COUNT);
const pActive = new Uint8Array(P_COUNT);
let particleGeo, particleMat, particleMesh;

// 3D fiber meshes on the wound
let fiberGroup;
const MAX_FIBERS_3D = 250;

// ─── Init ────────────────────────────────────────────────────────────
function init() {
    clock = new THREE.Clock();
    raycaster = new THREE.Raycaster();
    generateWound();
    setupScene();
    setupLights();
    buildEnvironment();
    buildDevice();
    buildWound();
    buildParticles();
    fiberGroup = new THREE.Group();
    scene.add(fiberGroup);
    bindUI();
    animate();
}

// ─── Scene ───────────────────────────────────────────────────────────
function setupScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe8eef4);

    camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.set(0, 14, 10);
    camera.lookAt(0, -1, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

// ─── Lights ──────────────────────────────────────────────────────────
function setupLights() {
    scene.add(new THREE.AmbientLight(0xd0e0f0, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(5, 18, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 40;
    [-12, 12, 12, -12].forEach((v, i) => {
        ['left', 'right', 'top', 'bottom'][i] && (sun.shadow.camera[['left', 'right', 'top', 'bottom'][i]] = v);
    });
    sun.shadow.bias = -0.001;
    scene.add(sun);
    scene.add(new THREE.DirectionalLight(0xc8e0ff, 0.4).translateX(-6).translateY(8));
    scene.add(new THREE.HemisphereLight(0xd4e8ff, 0xf0e0d0, 0.4));
}

// ─── Environment ─────────────────────────────────────────────────────
function buildEnvironment() {
    // Table
    const table = new THREE.Mesh(
        new THREE.BoxGeometry(18, 0.3, 14),
        new THREE.MeshStandardMaterial({ color: 0xf5f5f0, roughness: 0.3, metalness: 0.05 })
    );
    table.position.y = -2.15;
    table.receiveShadow = true;
    table.castShadow = true;
    scene.add(table);

    // Steel rim
    const rim = new THREE.Mesh(
        new THREE.BoxGeometry(18.1, 0.04, 14.1),
        new THREE.MeshStandardMaterial({ color: 0xc8cdd4, roughness: 0.15, metalness: 0.8 })
    );
    rim.position.y = -2.0;
    scene.add(rim);

    // Floor
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(60, 60),
        new THREE.MeshStandardMaterial({ color: 0xdde3eb, roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -4;
    floor.receiveShadow = true;
    scene.add(floor);

    // Invisible plane for raycasting (at wound surface level)
    woundPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(18, 14),
        new THREE.MeshBasicMaterial({ visible: false })
    );
    woundPlane.rotation.x = -Math.PI / 2;
    woundPlane.position.y = -1.85;
    scene.add(woundPlane);
}

// ─── Device (gun shape, aims straight down) ──────────────────────────
const DEVICE_HEIGHT = 4.5;   // world Y of device above wound
const DEVICE_TILT = -Math.PI / 6; // slight tilt (30°) — small enough to stay aligned

function buildDevice() {
    deviceGroup = new THREE.Group();

    const white = new THREE.MeshStandardMaterial({ color: 0xf5f5f0, roughness: 0.35, metalness: 0.05 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x2970b4, roughness: 0.3, metalness: 0.15 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xd0d5dc, roughness: 0.15, metalness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.5, metalness: 0.2 });

    // Body
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.8, 3.2), white);
    body.castShadow = true;
    deviceGroup.add(body);

    // Blue top panel
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.3, 2.8), blue);
    top.position.y = 0.4;
    top.castShadow = true;
    deviceGroup.add(top);

    // Front taper
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 1.0, 12), white);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = -2.1;
    nose.castShadow = true;
    deviceGroup.add(nose);

    // Nozzle
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.18, 0.6, 10), metal);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.z = -2.9;
    deviceGroup.add(nozzle);

    // Emitter tip
    const emitMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0x0891b2, emissiveIntensity: 0,
        roughness: 0.1, metalness: 0.8,
    });
    const emit = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), emitMat);
    emit.position.z = -3.2;
    emit.name = 'emitter';
    deviceGroup.add(emit);

    // Emitter light
    const emitLight = new THREE.PointLight(0x0891b2, 0, 5);
    emitLight.position.z = -3.2;
    emitLight.name = 'emitLight';
    deviceGroup.add(emitLight);

    // Handle
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.8, 0.9), white);
    grip.position.set(0, -1.1, 0.7);
    grip.rotation.x = 0.2;
    grip.castShadow = true;
    deviceGroup.add(grip);

    // Rubber grip
    const rubber = new THREE.Mesh(
        new THREE.BoxGeometry(0.82, 1.2, 0.75),
        new THREE.MeshStandardMaterial({ color: 0x8890a0, roughness: 0.85, metalness: 0 })
    );
    rubber.position.set(0, -1.25, 0.73);
    rubber.rotation.x = 0.2;
    deviceGroup.add(rubber);

    // Trigger
    const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.6, 0.4), dark);
    trigger.position.set(0, -0.5, 0.0);
    trigger.name = 'trigger';
    deviceGroup.add(trigger);

    // Cartridge
    const cart = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.45, 0.7),
        new THREE.MeshStandardMaterial({ color: 0xc8d4e0, roughness: 0.2, metalness: 0.4, transparent: true, opacity: 0.75 })
    );
    cart.position.set(0, 0.85, 0.3);
    cart.castShadow = true;
    deviceGroup.add(cart);

    // Liquid inside
    const liq = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.35, 0.55),
        new THREE.MeshStandardMaterial({ color: POLYMERS[G.polymer].hex, transparent: true, opacity: 0.5, roughness: 0.05 })
    );
    liq.position.set(0, 0.82, 0.3);
    liq.name = 'liquid';
    deviceGroup.add(liq);

    // LED
    const led = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0x94a3b8, emissive: 0x333333, emissiveIntensity: 0.2 })
    );
    led.position.set(0.51, 0.2, -0.8);
    led.name = 'led';
    deviceGroup.add(led);

    // Initial pose — less tilt so nozzle points closer to directly below
    deviceGroup.rotation.x = DEVICE_TILT;
    deviceGroup.position.set(0, DEVICE_HEIGHT, 1.5);
    deviceGroup.castShadow = true;
    scene.add(deviceGroup);
}

// ─── Wound Surface ──────────────────────────────────────────────────
function buildWound() {
    woundCanvas = document.createElement('canvas');
    woundCanvas.width = 512;
    woundCanvas.height = 512;
    woundCtx = woundCanvas.getContext('2d');
    drawWoundTexture();

    woundTexture = new THREE.CanvasTexture(woundCanvas);

    // Wound circle
    const wound = new THREE.Mesh(
        new THREE.CircleGeometry(WOUND_WORLD, 64),
        new THREE.MeshStandardMaterial({ map: woundTexture, roughness: 0.8, metalness: 0.02 })
    );
    wound.rotation.x = -Math.PI / 2;
    wound.position.y = -1.86;
    wound.receiveShadow = true;
    scene.add(wound);

    // Skin border
    const border = new THREE.Mesh(
        new THREE.RingGeometry(WOUND_WORLD, WOUND_WORLD + 0.7, 48),
        new THREE.MeshStandardMaterial({ color: 0xd4a088, roughness: 0.75, side: THREE.DoubleSide })
    );
    border.rotation.x = -Math.PI / 2;
    border.position.y = -1.87;
    scene.add(border);

    // Outer skin
    const skin = new THREE.Mesh(
        new THREE.RingGeometry(WOUND_WORLD + 0.7, 7, 48),
        new THREE.MeshStandardMaterial({ color: 0xecc9ae, roughness: 0.85, side: THREE.DoubleSide })
    );
    skin.rotation.x = -Math.PI / 2;
    skin.position.y = -1.88;
    skin.receiveShadow = true;
    scene.add(skin);

    // Sterile drape
    const drape = new THREE.Mesh(
        new THREE.RingGeometry(6.5, 8.5, 4),
        new THREE.MeshStandardMaterial({ color: 0x4a90d9, roughness: 0.7, side: THREE.DoubleSide })
    );
    drape.rotation.x = -Math.PI / 2;
    drape.rotation.z = Math.PI / 4;
    drape.position.y = -1.9;
    scene.add(drape);
}

function drawWoundTexture() {
    const c = woundCtx;
    const s = 512;

    // Background skin
    const bg = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    bg.addColorStop(0, '#d4a088');
    bg.addColorStop(1, '#d4a088');
    c.fillStyle = bg;
    c.fillRect(0, 0, s, s);

    // Draw wound shape from mask, using varied wound colors
    const woundColors = [
        ['#c06060', '#b55555', '#c47068', '#a04848'],
        ['#c45555', '#b04050', '#d07060', '#9c4040'],
        ['#b85858', '#a84848', '#c86858', '#984040'],
    ][Math.floor(Math.random() * 3)];

    for (let gy = 0; gy < W_GRID; gy++) {
        for (let gx = 0; gx < W_GRID; gx++) {
            if (!woundMask[gy * W_GRID + gx]) continue;
            const px = (gx / W_GRID) * s;
            const py = (gy / W_GRID) * s;
            const size = s / W_GRID;
            c.fillStyle = woundColors[Math.floor(Math.random() * woundColors.length)];
            c.fillRect(px, py, size + 1, size + 1);
        }
    }

    // Organic texture noise
    for (let i = 0; i < 3000; i++) {
        const gx = Math.floor(Math.random() * W_GRID);
        const gy = Math.floor(Math.random() * W_GRID);
        if (!woundMask[gy * W_GRID + gx]) continue;
        const px = (gx / W_GRID) * s + Math.random() * (s / W_GRID);
        const py = (gy / W_GRID) * s + Math.random() * (s / W_GRID);
        const br = Math.random() * 30 - 15;
        c.fillStyle = `rgba(${192 + br | 0},${100 + br * 0.5 | 0},${96 + br * 0.3 | 0},0.4)`;
        c.beginPath();
        c.arc(px, py, Math.random() * 3 + 0.5, 0, Math.PI * 2);
        c.fill();
    }

    // Moisture highlights inside wound
    for (let i = 0; i < 150; i++) {
        const gx = Math.floor(Math.random() * W_GRID);
        const gy = Math.floor(Math.random() * W_GRID);
        if (!woundMask[gy * W_GRID + gx]) continue;
        const px = (gx / W_GRID) * s + Math.random() * (s / W_GRID);
        const py = (gy / W_GRID) * s + Math.random() * (s / W_GRID);
        c.fillStyle = `rgba(255,200,180,${Math.random() * 0.12})`;
        c.beginPath();
        c.arc(px, py, Math.random() * 5 + 1, 0, Math.PI * 2);
        c.fill();
    }

    // Soft wound edges (blur-like by drawing semi-transparent ring around wound cells)
    for (let gy = 1; gy < W_GRID - 1; gy++) {
        for (let gx = 1; gx < W_GRID - 1; gx++) {
            if (!woundMask[gy * W_GRID + gx]) continue;
            // Check if edge cell
            const hasEmpty = !woundMask[(gy - 1) * W_GRID + gx] || !woundMask[(gy + 1) * W_GRID + gx]
                || !woundMask[gy * W_GRID + gx - 1] || !woundMask[gy * W_GRID + gx + 1];
            if (!hasEmpty) continue;
            const px = (gx / W_GRID) * s + (s / W_GRID) / 2;
            const py = (gy / W_GRID) * s + (s / W_GRID) / 2;
            c.fillStyle = 'rgba(180,90,80,0.3)';
            c.beginPath();
            c.arc(px, py, s / W_GRID, 0, Math.PI * 2);
            c.fill();
        }
    }
}

function paintFiberOnCanvas(worldX, worldZ) {
    const cx = ((worldX + WOUND_WORLD) / (WOUND_WORLD * 2)) * 512;
    const cy = ((worldZ + WOUND_WORLD) / (WOUND_WORLD * 2)) * 512;
    if (cx < 2 || cx > 510 || cy < 2 || cy > 510) return;

    const poly = POLYMERS[G.polymer];
    const numStrands = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < numStrands; i++) {
        const len = 4 + Math.random() * 16;
        const angle = Math.random() * Math.PI * 2;
        const ex = cx + Math.cos(angle) * len;
        const ey = cy + Math.sin(angle) * len;

        woundCtx.strokeStyle = poly.fiber + (0.15 + Math.random() * 0.3) + ')';
        woundCtx.lineWidth = 0.3 + Math.random() * 1.2;
        woundCtx.beginPath();
        woundCtx.moveTo(cx + (Math.random() - 0.5) * 3, cy + (Math.random() - 0.5) * 3);
        woundCtx.quadraticCurveTo(
            (cx + ex) / 2 + (Math.random() - 0.5) * 8,
            (cy + ey) / 2 + (Math.random() - 0.5) * 8,
            ex, ey
        );
        woundCtx.stroke();
    }
    // Soft glow
    woundCtx.fillStyle = poly.fiber + '0.03)';
    woundCtx.beginPath();
    woundCtx.arc(cx, cy, 5 + Math.random() * 8, 0, Math.PI * 2);
    woundCtx.fill();

    woundTexture.needsUpdate = true;
}

// ─── Particle System ─────────────────────────────────────────────────
function buildParticles() {
    particleGeo = new THREE.BufferGeometry();
    for (let i = 0; i < P_COUNT; i++) { pActive[i] = 0; pAlpha[i] = 0; }

    particleGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    particleGeo.setAttribute('alpha', new THREE.BufferAttribute(pAlpha, 1));
    particleGeo.setAttribute('size', new THREE.BufferAttribute(pSize, 1));

    particleMat = new THREE.ShaderMaterial({
        uniforms: {
            uColor: { value: new THREE.Color(POLYMERS[G.polymer].hex) },
            uTime: { value: 0 },
        },
        vertexShader: `
            attribute float alpha;
            attribute float size;
            varying float vAlpha;
            void main() {
                vAlpha = alpha;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = size * (160.0 / -mv.z);
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: `
            uniform vec3 uColor;
            uniform float uTime;
            varying float vAlpha;
            void main() {
                float d = length(gl_PointCoord - vec2(0.5));
                if (d > 0.5) discard;
                float g = pow(1.0 - smoothstep(0.0, 0.5, d), 2.0);
                gl_FragColor = vec4(uColor + 0.15 * sin(uTime * 3.0), vAlpha * g);
            }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });

    particleMesh = new THREE.Points(particleGeo, particleMat);
    scene.add(particleMesh);
}

// Emit particles from emitter toward the aim point
function emitParticles(emitterPos, targetX, targetZ, count) {
    const woundY = -1.86;
    let emitted = 0;
    for (let i = 0; i < P_COUNT && emitted < count; i++) {
        if (pActive[i]) continue;
        const i3 = i * 3;
        pPos[i3] = emitterPos.x + (Math.random() - 0.5) * 0.08;
        pPos[i3 + 1] = emitterPos.y + (Math.random() - 0.5) * 0.08;
        pPos[i3 + 2] = emitterPos.z + (Math.random() - 0.5) * 0.08;

        // Velocity aimed at target with some spread
        const dx = targetX - emitterPos.x + (Math.random() - 0.5) * G.power * 0.3;
        const dy = woundY - emitterPos.y;
        const dz = targetZ - emitterPos.z + (Math.random() - 0.5) * G.power * 0.3;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const speed = 8 + G.power * 2;
        pVel[i3] = (dx / dist) * speed;
        pVel[i3 + 1] = (dy / dist) * speed;
        pVel[i3 + 2] = (dz / dist) * speed;

        pAlpha[i] = 0.6 + Math.random() * 0.4;
        pSize[i] = 1.5 + Math.random() * 3;
        pLife[i] = 0;
        pPhase[i] = Math.random() * Math.PI * 2;
        pActive[i] = 1;
        emitted++;
    }
}

function updateParticles(dt) {
    const woundY = -1.86;
    for (let i = 0; i < P_COUNT; i++) {
        if (!pActive[i]) continue;
        const i3 = i * 3;
        pLife[i] += dt;

        // Spiral
        const phase = pPhase[i] + pLife[i] * 4;
        const spiral = 0.01 * G.power;
        pPos[i3] += (pVel[i3] + Math.cos(phase) * spiral) * dt;
        pPos[i3 + 1] += pVel[i3 + 1] * dt;
        pPos[i3 + 2] += (pVel[i3 + 2] + Math.sin(phase) * spiral) * dt;

        // Hit wound surface
        if (pPos[i3 + 1] <= woundY) {
            // Paint visual fiber at impact
            paintFiberOnCanvas(pPos[i3], pPos[i3 + 2]);
            if (Math.random() < 0.25) addFiber3D(pPos[i3], pPos[i3 + 2]);
            G.totalFibers++;
            pAlpha[i] = 0;
            pActive[i] = 0;
            continue;
        }
        // Timeout
        if (pLife[i] > 1.5) {
            pAlpha[i] *= 0.85;
            if (pAlpha[i] < 0.01) { pAlpha[i] = 0; pActive[i] = 0; }
        }
    }
    // Fade if not spraying
    if (!G.isSpraying) {
        for (let i = 0; i < P_COUNT; i++) {
            if (pActive[i]) {
                pAlpha[i] *= 0.9;
                if (pAlpha[i] < 0.01) { pAlpha[i] = 0; pActive[i] = 0; }
            }
        }
    }
    particleGeo.attributes.position.needsUpdate = true;
    particleGeo.attributes.alpha.needsUpdate = true;
}

// ─── 3D Fibers ───────────────────────────────────────────────────────
function addFiber3D(wx, wz) {
    if (fiberGroup.children.length > MAX_FIBERS_3D) {
        const old = fiberGroup.children[0];
        fiberGroup.remove(old);
        old.geometry.dispose();
        old.material.dispose();
    }
    const pts = [];
    const len = 0.15 + Math.random() * 0.5;
    const angle = Math.random() * Math.PI * 2;
    for (let s = 0; s <= 4; s++) {
        const t = s / 4;
        pts.push(new THREE.Vector3(
            wx + Math.cos(angle) * len * t + (Math.random() - 0.5) * 0.03,
            -1.84 + Math.random() * 0.012,
            wz + Math.sin(angle) * len * t + (Math.random() - 0.5) * 0.03
        ));
    }
    fiberGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
            color: POLYMERS[G.polymer].hex,
            transparent: true,
            opacity: 0.4 + Math.random() * 0.4,
        })
    ));
}

// ─── UI Binding ──────────────────────────────────────────────────────
function bindUI() {
    const cursor = document.getElementById('custom-cursor');
    const sprayInd = document.getElementById('spray-indicator');
    const canvasEl = renderer.domElement;

    // Helper: convert screen coords to correct NDC using actual canvas rect
    function screenToNDC(clientX, clientY) {
        const rect = canvasEl.getBoundingClientRect();
        G.mouseNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        G.mouseNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    }

    // Mouse move → update aim point via raycast
    document.addEventListener('mousemove', (e) => {
        G.mouseScreen.x = e.clientX;
        G.mouseScreen.y = e.clientY;
        screenToNDC(e.clientX, e.clientY);

        cursor.style.left = e.clientX + 'px';
        cursor.style.top = e.clientY + 'px';
        sprayInd.style.left = e.clientX + 'px';
        sprayInd.style.top = e.clientY + 'px';

        if (G.phase === 'playing') {
            raycaster.setFromCamera(G.mouseNDC, camera);
            const hits = raycaster.intersectObject(woundPlane);
            if (hits.length) {
                G.aimX = hits[0].point.x;
                G.aimZ = hits[0].point.z;
                G.hasAim = true;
            } else {
                G.hasAim = false;
            }
        }
    });

    // Mouse down/up — spray (on document to not be blocked by HUD)
    document.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || G.phase !== 'playing') return;
        const tag = e.target.tagName;
        if (tag === 'BUTTON' || tag === 'INPUT' || e.target.closest('button, input')) return;
        G.isSpraying = true;
        cursor.classList.add('spraying');
        sprayInd.classList.add('active');
    });
    document.addEventListener('mouseup', () => {
        G.isSpraying = false;
        cursor.classList.remove('spraying');
        sprayInd.classList.remove('active');
    });

    // Touch support
    canvasEl.addEventListener('touchstart', (e) => {
        if (G.phase !== 'playing') return;
        G.isSpraying = true;
        sprayInd.classList.add('active');
        updateTouch(e.touches[0]);
    }, { passive: true });
    canvasEl.addEventListener('touchmove', (e) => {
        updateTouch(e.touches[0]);
        sprayInd.style.left = e.touches[0].clientX + 'px';
        sprayInd.style.top = e.touches[0].clientY + 'px';
    }, { passive: true });
    canvasEl.addEventListener('touchend', () => {
        G.isSpraying = false;
        sprayInd.classList.remove('active');
    });

    function updateTouch(t) {
        G.mouseScreen.x = t.clientX;
        G.mouseScreen.y = t.clientY;
        screenToNDC(t.clientX, t.clientY);
        raycaster.setFromCamera(G.mouseNDC, camera);
        const hits = raycaster.intersectObject(woundPlane);
        if (hits.length) {
            G.aimX = hits[0].point.x;
            G.aimZ = hits[0].point.z;
            G.hasAim = true;
        }
    }

    // Buttons
    document.getElementById('btn-play').addEventListener('click', startGame);
    document.getElementById('btn-replay').addEventListener('click', () => {
        document.getElementById('win-screen').style.display = 'none';
        resetGame();
        startGame();
    });

    // Power slider
    document.getElementById('power-slider').addEventListener('input', e => {
        G.power = parseInt(e.target.value);
        document.getElementById('power-value').textContent = G.power;
    });

    // Polymer buttons
    document.querySelectorAll('.hud-poly').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.hud-poly').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            G.polymer = btn.dataset.polymer;
            particleMat.uniforms.uColor.value.set(POLYMERS[G.polymer].hex);
            const liq = deviceGroup.getObjectByName('liquid');
            if (liq) liq.material.color.set(POLYMERS[G.polymer].hex);
        });
    });

    // Info modal
    document.getElementById('btn-info').addEventListener('click', () => {
        document.getElementById('info-modal').style.display = 'flex';
    });
    document.getElementById('close-modal').addEventListener('click', () => {
        document.getElementById('info-modal').style.display = 'none';
    });
    document.getElementById('info-modal').addEventListener('click', e => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });

    // Reset
    document.getElementById('btn-reset').addEventListener('click', () => {
        resetGame();
        startGame();
    });
}

function startGame() {
    document.getElementById('intro-screen').style.display = 'none';
    document.getElementById('hud').style.display = 'block';
    document.getElementById('custom-cursor').style.display = 'block';
    G.phase = 'playing';
    G.startTime = performance.now();
}

function resetGame() {
    G.coverage = 0;
    G.totalFibers = 0;
    G.elapsed = 0;
    G.isSpraying = false;

    // New random wound
    generateWound();
    drawWoundTexture();
    woundTexture.needsUpdate = true;

    // Clear particles
    for (let i = 0; i < P_COUNT; i++) { pAlpha[i] = 0; pActive[i] = 0; }
    particleGeo.attributes.alpha.needsUpdate = true;

    // Clear 3D fibers
    while (fiberGroup.children.length) {
        const c = fiberGroup.children[0];
        fiberGroup.remove(c);
        c.geometry.dispose();
        c.material.dispose();
    }
    updateHUD();
}

function triggerWin() {
    G.phase = 'won';
    G.isSpraying = false;

    const m = Math.floor(G.elapsed / 60).toString().padStart(2, '0');
    const s = Math.floor(G.elapsed % 60).toString().padStart(2, '0');
    document.getElementById('win-time').textContent = `${m}:${s}`;
    document.getElementById('win-fibers').textContent = G.totalFibers.toLocaleString();

    setTimeout(() => {
        document.getElementById('win-screen').style.display = 'flex';
        document.getElementById('custom-cursor').style.display = 'none';
    }, 400);

    for (let i = 0; i < 30; i++) {
        setTimeout(() => spawnHitParticle(
            window.innerWidth / 2 + (Math.random() - 0.5) * 300,
            window.innerHeight / 2 + (Math.random() - 0.5) * 200,
            ['#0891b2', '#22d3ee', '#10b981', '#34d399'][Math.floor(Math.random() * 4)]
        ), i * 30);
    }
}

// ─── CSS Hit Particles ───────────────────────────────────────────────
function spawnHitParticle(x, y, color) {
    const el = document.createElement('div');
    el.className = 'hit-particle';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.background = color || POLYMERS[G.polymer].css;
    el.style.setProperty('--dx', (Math.random() - 0.5) * 80 + 'px');
    el.style.setProperty('--dy', (Math.random() - 0.5) * 80 + 'px');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 700);
}

// ─── HUD ─────────────────────────────────────────────────────────────
function updateHUD() {
    const pct = Math.min(100, G.coverage);
    document.getElementById('coverage-fill').style.width = pct + '%';
    document.getElementById('coverage-text').textContent = Math.round(pct) + '%';
    document.getElementById('coverage-glow').style.opacity = pct > 0 ? '1' : '0';

    if (pct >= 80) {
        document.getElementById('coverage-fill').style.background =
            'linear-gradient(90deg, #0891b2, #10b981, #34d399)';
    } else {
        document.getElementById('coverage-fill').style.background =
            'linear-gradient(90deg, #0891b2, #22d3ee)';
    }

    if (G.phase === 'playing') {
        G.elapsed = (performance.now() - G.startTime) / 1000;
    }
    const m = Math.floor(G.elapsed / 60).toString().padStart(2, '0');
    const s = Math.floor(G.elapsed % 60).toString().padStart(2, '0');
    document.getElementById('timer-text').textContent = `${m}:${s}`;
}

// ─── Animation Loop ──────────────────────────────────────────────────
function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.getElapsedTime();

    // ── Device follows aim point directly ──
    const lerpSpeed = 10;
    deviceGroup.position.x += (G.aimX - deviceGroup.position.x) * lerpSpeed * dt;
    deviceGroup.position.z += (G.aimZ - deviceGroup.position.z) * lerpSpeed * dt;

    // Subtle tilt toward movement
    const mvX = G.aimX - deviceGroup.position.x;
    const mvZ = G.aimZ - deviceGroup.position.z;
    deviceGroup.rotation.x = DEVICE_TILT + mvZ * 0.04;
    deviceGroup.rotation.z = -mvX * 0.04;

    // Float
    deviceGroup.position.y = DEVICE_HEIGHT + Math.sin(time * 1.5) * 0.06;

    // ── Spray logic (directly at aim point) ──
    const emitter = deviceGroup.getObjectByName('emitter');
    const emitLight = deviceGroup.getObjectByName('emitLight');
    const led = deviceGroup.getObjectByName('led');
    const trigger = deviceGroup.getObjectByName('trigger');

    if (G.isSpraying && G.phase === 'playing' && G.hasAim) {
        // Glow emitter
        if (emitter) {
            emitter.material.emissive.setHex(POLYMERS[G.polymer].hex);
            emitter.material.emissiveIntensity = 1.5 + Math.sin(time * 10) * 0.5;
        }
        if (emitLight) {
            emitLight.color.setHex(POLYMERS[G.polymer].hex);
            emitLight.intensity = 2 + Math.sin(time * 8) * 0.5;
        }
        if (led) {
            led.material.color.setHex(0x22c55e);
            led.material.emissive.setHex(0x22c55e);
            led.material.emissiveIntensity = 0.5 + Math.sin(time * 4) * 0.3;
        }
        if (trigger) trigger.position.z = -0.08;

        // ★ Direct coverage at aim point — world-space radius, Gaussian falloff
        const sprayRadius = 0.3 + G.power * 0.15;  // world units (0.45 – 1.05)
        sprayAtAim(G.aimX, G.aimZ, sprayRadius, dt);

        // Emit visual particles from device toward aim point
        const emitWorldPos = new THREE.Vector3();
        if (emitter) emitter.getWorldPosition(emitWorldPos);
        else emitWorldPos.set(deviceGroup.position.x, DEVICE_HEIGHT - 1, deviceGroup.position.z);

        const emitCount = Math.floor(G.power * 12 * dt * 60);
        emitParticles(emitWorldPos, G.aimX, G.aimZ, emitCount);

        // CSS particles
        if (Math.random() < 0.12) {
            spawnHitParticle(
                G.mouseScreen.x + (Math.random() - 0.5) * 25,
                G.mouseScreen.y + (Math.random() - 0.5) * 25
            );
        }
    } else {
        if (emitter) emitter.material.emissiveIntensity *= 0.9;
        if (emitLight) emitLight.intensity *= 0.9;
        if (led) {
            led.material.color.setHex(0x94a3b8);
            led.material.emissive.setHex(0x444444);
            led.material.emissiveIntensity = 0.2;
        }
        if (trigger) trigger.position.z = 0;
    }

    // Particles
    particleMat.uniforms.uTime.value = time;
    updateParticles(dt);

    // HUD
    updateHUD();

    // Win
    if (G.phase === 'playing' && G.coverage >= 99) {
        triggerWin();
    }

    renderer.render(scene, camera);
}

// ─── Start ───────────────────────────────────────────────────────────
init();
