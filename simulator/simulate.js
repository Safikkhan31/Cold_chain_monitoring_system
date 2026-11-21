// Cold chain simulator: publishes MQTT messages for many boxes, in the same JSON format as the ESP32.
// Usage: copy .env.example to .env, fill it in, then run "npm start".
// "npm run dry" (or DRY_RUN=1) prints the messages instead of sending them.
require('dotenv').config();

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 0.5; // roughly -3..3
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 1) => Number(v.toFixed(d));

// 20 behaviours, interleaved so neighbouring boxes differ
const MIX = [
  'healthy', 'lid_openings', 'healthy', 'slow_warming', 'healthy', 'rough_handling', 'healthy',
  'freezing', 'healthy', 'high_humidity', 'healthy', 'lid_openings', 'overheat', 'healthy',
  'long_excursion', 'healthy', 'goes_offline', 'slow_warming', 'healthy', 'lid_openings',
];

// Routes between Indian cities: [start lat, lng], [end lat, lng]
const ROUTES = [
  [[23.0225, 72.5714], [19.0760, 72.8777]], // Ahmedabad to Mumbai
  [[28.6139, 77.2090], [26.9124, 75.7873]], // Delhi to Jaipur
  [[12.9716, 77.5946], [13.0827, 80.2707]], // Bengaluru to Chennai
  [[18.5204, 73.8567], [17.3850, 78.4867]], // Pune to Hyderabad
  [[22.5726, 88.3639], [20.2961, 85.8245]], // Kolkata to Bhubaneswar
];

const bearing = (a, b) => {
  const r = Math.PI / 180, dl = (b[1] - a[1]) * r;
  const y = Math.sin(dl) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

function createBoxes(count, start) {
  return Array.from({ length: count }, (_, i) => ({
    id: 'BOX-' + String(start + i).padStart(3, '0'),
    scenario: MIX[i % MIX.length],
    route: ROUTES[i % ROUTES.length],
    tick: 0, temp: rand(4, 6), hum: rand(45, 60), progress: rand(0, 0.3),
    stopTicks: 0, lidTicks: 0, nextLid: randInt(15, 35),
  }));
}

// Advance one box by one message. Returns the reading, or null if the box has gone silent.
function step(b, intervalS, speed) {
  b.tick++;
  const t = b.tick;
  let lid = false;
  let vib = rand(0, 0.12);
  let tilt = rand(0, 8);
  let targetT = 5, targetH = 55, k = 0.25;

  switch (b.scenario) {
    case 'lid_openings':
      if (b.lidTicks === 0 && t >= b.nextLid) { b.lidTicks = randInt(2, 3); b.nextLid = t + randInt(25, 45); }
      if (b.lidTicks > 0) { lid = true; b.lidTicks--; targetT = 8.5; }
      break;
    case 'rough_handling':
      if (Math.random() < 0.1) { vib = rand(1.6, 3.0); tilt = rand(50, 80); }
      break;
    case 'slow_warming':
      if (t > 8) targetT = Math.min(12, 5 + (t - 8) * 0.25);
      break;
    case 'freezing':
      k = 0.5;
      if (t > 12) targetT = Math.max(-3, 5 - (t - 12) * 0.8);
      break;
    case 'overheat':
      k = 0.5;
      if (t >= 18 && t <= 21) targetT = 18;
      break;
    case 'high_humidity':
      if (t > 10) targetH = 92;
      break;
    case 'long_excursion':
      if (t > 5) targetT = 9.2;
      break;
    case 'goes_offline':
      if (t > 18) return null;
      break;
  }
  b.temp = clamp(b.temp + (targetT - b.temp) * k + gauss() * 0.15, -5, 30);
  b.hum = clamp(b.hum + (targetH - b.hum) * 0.1 + gauss() * 0.5, 15, 99);

  // position along the route, with occasional stops
  if (b.stopTicks > 0) b.stopTicks--;
  else if (Math.random() < 0.03) b.stopTicks = randInt(2, 4);
  const stopped = b.stopTicks > 0;
  if (!stopped) b.progress = (b.progress + 0.004) % 1;
  const [a, z] = b.route;
  const lat = a[0] + (z[0] - a[0]) * b.progress + rand(-0.0004, 0.0004);
  const lng = a[1] + (z[1] - a[1]) * b.progress + rand(-0.0004, 0.0004);

  return {
    box_id: b.id,
    ts: Math.floor(Date.now() / 1000),
    temp_c: round(b.temp),
    hum_pct: Math.round(b.hum),
    vib_g: round(vib, 3),
    tilt_deg: round(tilt),
    moving: !stopped,
    lid_open: lid,
    interval_s: Math.round(intervalS * speed),
    rssi: randInt(-80, -45),
    light_raw: lid ? randInt(1900, 2600) : randInt(85, 125),
    ...(lid && Math.random() < 0.5 ? {} : { distance_cm: round(lid ? rand(90, 140) : rand(29.5, 30.5)) }),
    heading_deg: Math.round(bearing(a, z)),
    lat: round(lat, 6),
    lng: round(lng, 6),
    speed_kmph: stopped ? 0 : round(rand(35, 65)),
  };
}

module.exports = { createBoxes, step, MIX };

// ---------------- run ----------------
if (require.main === module) {
  const cfg = {
    url: process.env.MQTT_URL,
    user: process.env.MQTT_USER || 'esp32',
    pass: process.env.MQTT_PASS,
    intervalS: Number(process.env.INTERVAL_S || 10),
    speed: Number(process.env.SPEED || 30),
    start: Number(process.env.BOX_START || 2),
    count: Number(process.env.BOX_COUNT || 20),
    dry: !!process.env.DRY_RUN,
  };
  if (!cfg.dry && (!cfg.url || !cfg.pass)) {
    console.error('Set MQTT_URL and MQTT_PASS in .env (copy .env.example). Or run "npm run dry" to test without a broker.');
    process.exit(1);
  }

  const boxes = createBoxes(cfg.count, cfg.start);
  console.log(`Simulating ${boxes.length} boxes (${boxes[0].id} to ${boxes[boxes.length - 1].id}), one message every ${cfg.intervalS}s, speed x${cfg.speed}`);
  boxes.forEach((b) => console.log(`  ${b.id}  ${b.scenario}`));

  let client = null;
  if (!cfg.dry) {
    const mqtt = require('mqtt');
    client = mqtt.connect(cfg.url, {
      username: cfg.user, password: cfg.pass, clientId: 'coldchain-simulator-' + process.pid,
    });
    client.on('connect', () => console.log('MQTT connected'));
    client.on('error', (e) => console.error('MQTT error:', e.message));
  }

  const tick = () => {
    let sent = 0, silent = 0;
    boxes.forEach((b) => {
      const reading = step(b, cfg.intervalS, cfg.speed);
      if (!reading) { silent++; return; }
      sent++;
      const payload = JSON.stringify(reading);
      if (cfg.dry) console.log(payload);
      else setTimeout(() => client.publish(`coldchain/${b.id}/telemetry`, payload, { qos: 1 }), rand(0, 1500));
    });
    console.log(`[${new Date().toLocaleTimeString()}] sent ${sent} readings${silent ? `, ${silent} box(es) silent` : ''}`);
  };

  tick();
  const timer = setInterval(tick, cfg.intervalS * 1000);
  process.on('SIGINT', () => { clearInterval(timer); console.log('\nStopped.'); if (client) client.end(false, () => process.exit(0)); else process.exit(0); });
}
