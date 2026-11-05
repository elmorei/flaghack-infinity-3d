/** Bake mobile building cutouts from the real desktop models, without changing gameplay. */
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = 5197;
const executablePath = process.env.CHROMIUM_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
if (!executablePath) throw new Error('Stock Chrome is required for native building-sprite baking.');

const server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--host', '127.0.0.1', '--strictPort'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  await new Promise((ready, reject) => {
    server.stdout.on('data', bytes => { if (bytes.toString().includes(String(port))) ready(); });
    server.stderr.on('data', bytes => process.stderr.write(bytes));
    server.on('exit', code => reject(new Error(`Vite stopped: ${code}`)));
    setTimeout(() => reject(new Error('Vite startup timeout')), 20000).unref();
  });
  // Use the actual browser's native WebGL, with its sandbox and no backend overrides.
  browser = await chromium.launch({ executablePath, headless: false, chromiumSandbox: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => { pageErrors.push(String(error)); console.error(error); });
  await page.route('**/building-sprite-bake', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><body></body>'}));
  await page.goto(`http://127.0.0.1:${port}/building-sprite-bake`);
  const result = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const {createMatch} = await import('/src/sim/setup.ts');
    const {spawnBuilding} = await import('/src/sim/factory.ts');
    const {StructureKit} = await import('/src/render/structures/kit.ts');
    const {TableMap} = await import('/src/render/structures/tableMap.ts');
    const {HearthView} = await import('/src/render/structures/hearthView.ts');
    const {WorkshopView} = await import('/src/render/structures/workshopView.ts');
    const {DrumCircleView} = await import('/src/render/structures/drumCircleView.ts');
    const {WardView} = await import('/src/render/structures/wardView.ts');
    const {DrugLabView} = await import('/src/render/structures/drugLabView.ts');
    const {GccView} = await import('/src/render/structures/gccView.ts');
    const CELL = 128, FRAMES = 4, DIRECTIONS = 4, PAGE = 2048, TILE = CELL * FRAMES;
    const PITCH = .27, DURATION = .14;
    const world = createMatch({seed: 'mobile-building-art-v1', difficulty: 'normal', humans: [0, 1, 2, 3], mode: 'standard'});
    world.flags.clear(); world.hippies.clear(); world.buildings.clear();
    world.boss = null;
    world.factions[0].hearthIds = [];
    world.factions[0].color = 0xffffff;
    const renderer = new THREE.WebGLRenderer({alpha: true, antialias: false, preserveDrawingBuffer: true});
    renderer.setSize(CELL, CELL); renderer.setPixelRatio(1); renderer.setClearColor(0, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 1000);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x69687b, 2));
    const sun = new THREE.DirectionalLight(0xfff1d4, 2.5); sun.position.set(-15, 25, 20); scene.add(sun);
    const kit = new StructureKit(renderer, 'high');
    const table = new TableMap(world, 'low', 1); table.update(1, world, 0); kit.tableTexture = table.texture;
    const frame = {ctx: {world, scene, camera, renderer, shared: {groundOffset: () => 0}}, world,
      dt: DURATION, t: 0, night: .3, windYaw: -.3, wind: .6, stock: new Map(),
      smoke: {emit() {}}, sparks: {emit() {}}};
    const constructors = {hearth: HearthView, workshop: WorkshopView, drumcircle: DrumCircleView, ward: WardView, druglab: DrugLabView, gcc: GccView};
    const heights = {hearth: 8.41, workshop: 3, drumcircle: 2.4, ward: 5.405, druglab: 3.2, gcc: 3.4};
    const states = {hearth: ['idle', 'seated'], workshop: ['idle', 'working'], drumcircle: ['idle', 'active'],
      ward: ['idle', 'pulse'], druglab: ['idle', 'brewing'], gcc: ['idle', 'moving', 'channel', 'wreck']};
    const sheets = [], clips = {}, references = {};
    const capture = new OffscreenCanvas(CELL, CELL);
    const context = capture.getContext('2d', {willReadFrequently: true});
    const capturePixels = () => {
      renderer.render(scene, camera); context.clearRect(0, 0, CELL, CELL); context.drawImage(renderer.domElement, 0, 0);
      return context.getImageData(0, 0, CELL, CELL);
    };
    // Exact visible tabletop pixels carry local x/z coordinates instead of a
    // frozen miniature map. Runtime samples the existing live map texture there.
    // Differential captures preserve real rim/mast occlusion at every angle.
    const tableDataMaterial = new THREE.ShaderMaterial({
      uniforms: {uMode: {value: 0}}, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vLocal; void main(){vLocal=position.xz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'uniform float uMode; varying vec2 vLocal; void main(){gl_FragColor=vec4(uMode<.5?vec3(0.):uMode<1.5?vec3(1.):vec3(.5+.5*vLocal,1.),1.);\n#include <colorspace_fragment>\n}',
      toneMapped: false,
    });
    const visibleBounds = root => {
      root.updateMatrixWorld(true); const bounds = new THREE.Box3();
      root.traverseVisible(object => {
        if (!object.isMesh || object.count === 0) return;
        object.geometry.computeBoundingBox();
        bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
      });
      if (bounds.isEmpty()) throw new Error('Building model has no visible geometry.');
      return bounds;
    };
    const pose = (view, building, state, index) => {
      frame.t = 20 + index * DURATION; world.time = frame.t;
      kit.global.uTime.value = frame.t; kit.global.uNight.value = frame.night;
      kit.global.uWind.value = frame.wind; kit.global.uWindPhase.value = index * .35;
      building.progress = index * .1;
      if (building.kind === 'workshop') {
        view.working = state === 'working' ? 1 : 0;
        view.hammerPhase = index * .14 % 1;
        view.lastProgress = state === 'working' ? building.progress - .1 : building.progress;
      }
      if (building.kind === 'drumcircle') {
        view.drumming = state === 'active' ? 1 : 0;
        for (let i = 0; i < view.phase.length; i++) {view.phase[i] = (i * .37 + index * .21) % 1; view.hit[i] = 0;}
        world.hippies.clear();
        if (state === 'active') for (let i = 0; i < 4; i++) world.hippies.set(500 + i, {status: 'drumming', faction: 0, pos: {x: 0, z: 0}});
      }
      if (building.kind === 'ward') {
        view.eye.rotation.y = index * .16;
        if (state === 'pulse') {view.pulse = index * .18; view.flare = 1 - index * .2;}
      }
      if (building.lab) {building.lab.brewing = state === 'brewing' ? 'saffron' : null; view.boil = state === 'brewing' ? 1 : 0;}
      if (building.gcc) {
        building.gcc.channelUntil = state === 'channel' ? 1000 : 0;
        building.gcc.destroyedUntil = state === 'wreck' ? 1000 : 0;
        building.disabled = state === 'wreck';
        building.gcc.pushedBy = state === 'moving' ? 10 : -1;
        view.heading = 0; view.wheelAngle = index * .5;
        if (state === 'moving') {view.lastX = building.pos.x - .2; view.speed = 1;}
        if (state === 'wreck') {view.wrecked = true; view.wreck = 1; view.tilt = 1;}
      }
      view.update(building, frame);
      view.root.position.set(0, 0, 0); view.root.rotation.y = 0;
      // Art contains the model only. Runtime preserves live fire, stock, capture rings,
      // sparks, steam and range indicators, so none of them is baked twice.
      if (view.fire) view.fire.mesh.visible = false;
      if (view.effects) view.effects.visible = false;
      if (view.stockPoles) view.stockPoles.count = 0;
      if (view.stockCloth) view.stockCloth.count = 0;
      for (const child of view.root.children) if (child !== view.body) child.visible = false;
      view.body.visible = true;
    };
    let clipIndex = 0;
    for (const [kind, variants] of Object.entries(states)) for (const state of variants) {
      world.hippies.clear(); world.buildings.clear(); world.flags.clear();
      const building = spawnBuilding(world, kind, 0, 0, 1); building.pos = {x: 0, z: 0}; building.yaw = 0;
      world.hearthOf = () => kind === 'hearth' ? building : undefined;
      world.factions[0].controlMode = state === 'seated' ? 'rts' : 'avatar';
      const view = kind === 'hearth' ? new HearthView(kit, building, null) : new constructors[kind](kit, building);
      pose(view, building, state, 0);
      const bounds = visibleBounds(view.root);
      // Include off-center awnings and a collapsed GCC mast. Merely using model
      // width assumes a centered model and would crop these asymmetric silhouettes.
      const radius = Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x), Math.abs(bounds.min.z), Math.abs(bounds.max.z));
      const minUp = bounds.min.y * Math.cos(PITCH) - radius * Math.sin(PITCH);
      const maxUp = bounds.max.y * Math.cos(PITCH) + radius * Math.sin(PITCH);
      const height = state === 'seated' ? 2 : heights[kind];
      const extent = Math.max(radius * 2, maxUp - minUp) * 1.18;
      const pixelScale = CELL / extent;
      const anchorY = Math.round(CELL / 2 + (maxUp + minUp) / 2 * pixelScale);
      const targetY = (anchorY / CELL - .5) * extent / Math.cos(PITCH);
      const pageIndex = Math.floor(clipIndex / 16), slot = clipIndex % 16;
      const x = slot % 4 * TILE, y = Math.floor(slot / 4) * TILE;
      if (!sheets[pageIndex]) {
        const canvas = new OffscreenCanvas(PAGE, PAGE); sheets[pageIndex] = {canvas, ctx: canvas.getContext('2d')};
      }
      const footprint = [];
      for (let direction = 0; direction < DIRECTIONS; direction++) for (let index = 0; index < FRAMES; index++) {
        pose(view, building, state, index);
        const yaw = direction * Math.PI / 2, target = new THREE.Vector3(0, targetY, 0);
        camera.left = camera.bottom = -extent / 2; camera.right = camera.top = extent / 2;
        camera.position.copy(target).add(new THREE.Vector3(Math.sin(yaw) * Math.cos(PITCH), Math.sin(PITCH), Math.cos(yaw) * Math.cos(PITCH)).multiplyScalar(100));
        camera.lookAt(target); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
        scene.add(view.root); view.mats.setFaction(0xffffff); const pixels = capturePixels();
        view.mats.setFaction(0x000000); const black = capturePixels();
        let tableBlack, tableWhite, tableData;
        if (kind === 'gcc') {
          const material = view.table.material;
          try {
            view.table.material = tableDataMaterial;
            tableDataMaterial.uniforms.uMode.value = 0; tableBlack = capturePixels();
            tableDataMaterial.uniforms.uMode.value = 1; tableWhite = capturePixels();
            tableDataMaterial.uniforms.uMode.value = 2; tableData = capturePixels();
          } finally {view.table.material = material;}
        }
        scene.remove(view.root);
        let opaque = 0, owner = 0, liveMap = 0, left = CELL, right = 0, top = CELL, bottom = 0;
        for (let i = 0; i < pixels.data.length; i += 4) {
          if (pixels.data[i + 3] < 128) {pixels.data[i + 3] = 0; continue;}
          const delta = Math.max(Math.abs(pixels.data[i] - black.data[i]), Math.abs(pixels.data[i + 1] - black.data[i + 1]), Math.abs(pixels.data[i + 2] - black.data[i + 2]));
          pixels.data[i + 3] = delta > 8 ? 224 : 255;
          opaque++;
          const mapPixel = tableData && Math.max(...[0, 1, 2].map(channel => Math.abs(tableWhite.data[i + channel] - tableBlack.data[i + channel]))) > 128;
          if (mapPixel) {
            pixels.data[i] = tableData.data[i]; pixels.data[i + 1] = tableData.data[i + 1];
            pixels.data[i + 2] = 255; pixels.data[i + 3] = 160; liveMap++;
          } else if (delta > 8) owner++;
          const px = i / 4 % CELL, py = Math.floor(i / 4 / CELL);
          left = Math.min(left, px); right = Math.max(right, px); top = Math.min(top, py); bottom = Math.max(bottom, py);
        }
        if (opaque < 20) throw new Error(`Empty building sprite: ${kind}:${state}/${direction}/${index}`);
        if (left < 1 || top < 1 || right >= CELL - 1 || bottom >= CELL - 1) throw new Error(`Clipped building sprite: ${kind}:${state}/${direction}/${index} [${left},${top},${right},${bottom}]`);
        footprint.push({direction, frame: index, opaque, owner, liveMap, bounds: [left, top, right, bottom]});
        sheets[pageIndex].ctx.putImageData(pixels, x + index * CELL, y + direction * CELL);
      }
      const key = `building:${kind}:${state}`;
      clips[key] = {page: pageIndex, x, y, w: TILE, h: TILE, cellWidth: CELL, cellHeight: CELL,
        columns: FRAMES, rows: DIRECTIONS, anchor: [CELL / 2, anchorY], footYByCell: Array.from({length: DIRECTIONS}, () => Array(FRAMES).fill(anchorY)),
        heightPixels: height * pixelScale, worldHeight: height, frameDurationMs: DURATION * 1000, loop: true,
        directionRows: {front: 0, right: 1, away: 2, left: 3}};
      references[key] = {modelBounds: {min: bounds.min.toArray(), max: bounds.max.toArray()}, height, extent, pitch: PITCH, footprint};
      view.dispose(); clipIndex++;
    }
    const images = [];
    for (const sheet of sheets) {
      const blob = await sheet.canvas.convertToBlob({type: 'image/png'}), bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); images.push(btoa(binary));
    }
    tableDataMaterial.dispose(); table.dispose(); kit.dispose(); renderer.dispose();
    return {images, references, manifest: {schemaVersion: 1,
      pages: sheets.map((_, index) => ({image: `/assets/mobile-sprites/buildings-${index}.png`, width: PAGE, height: PAGE})), clips}};
  });
  if (pageErrors.length) throw new Error(pageErrors.join('\n'));
  mkdirSync(resolve(root, 'public/assets/mobile-sprites'), {recursive: true});
  mkdirSync(resolve(root, '../art/mobile-sprites'), {recursive: true});
  for (let index = 0; index < result.images.length; index++) writeFileSync(resolve(root, `public/assets/mobile-sprites/buildings-${index}.png`), Buffer.from(result.images[index], 'base64'));
  writeFileSync(resolve(root, 'src/render/actors/mobileSpriteBuildings.json'), JSON.stringify(result.manifest, null, 2) + '\n');
  const sourceFiles = ['buildingView', 'hearthView', 'workshopView', 'drumCircleView', 'wardView', 'drugLabView', 'gccView', 'kit', 'shapes', 'canvasArt', 'tableMap'];
  const sources = Object.fromEntries(sourceFiles.map(name => [`web/src/render/structures/${name}.ts`, createHash('sha256').update(readFileSync(resolve(root, `src/render/structures/${name}.ts`))).digest('hex')]));
  writeFileSync(resolve(root, '../art/mobile-sprites/buildings-reference.json'), JSON.stringify({
    source: 'Actual game model render, native Chrome WebGL. Four orthographic views and four animation frames. Alpha224 marks exact faction-material differences. Alpha160 marks visible live GCC map pixels; sRGB-encoded RG stores .5+.5*localTableXZ.',
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), sources,
    references: result.references,
  }, null, 2) + '\n');
  console.log(`Baked ${Object.keys(result.manifest.clips).length} building clips on ${result.images.length} transparent PNG pages.`);
} finally {
  await browser?.close(); server.kill('SIGTERM');
}
