import { useEffect, useState } from 'react';

const VERDICT = {
  safe: ['Usable', 'safe'],
  caution: ['Use with caution', 'caution'],
  unusable: ['Not usable', 'bad'],
  no_data: ['No data yet', 'idle'],
};
const f = (v, d = 1) => (v == null ? '–' : Number(v).toFixed(d));
const ago = (t) => {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(t)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const when = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');

// Calls that change data. If the server has an admin token set, ask for it once and remember it for this tab.
async function api(method, url) {
  const run = () => fetch(url, { method, headers: { 'x-admin-token': sessionStorage.getItem('adminToken') || '' } });
  let r = await run();
  if (r.status === 401) {
    const token = window.prompt('This action needs the admin token:');
    if (!token) return r;
    sessionStorage.setItem('adminToken', token);
    r = await run();
    if (r.status === 401) sessionStorage.removeItem('adminToken');
  }
  return r;
}

// Scale showing the vaccine's safe band and where the box is right now
function Gauge({ b }) {
  const lo = b.min_temp_c - 8, hi = b.max_temp_c + 8;
  const pos = (t) => `${Math.min(100, Math.max(0, ((t - lo) / (hi - lo)) * 100))}%`;
  return (
    <div className="gauge" aria-label={`Current ${f(b.temp_c)} degrees, safe ${b.min_temp_c} to ${b.max_temp_c}`}>
      <div className="band" style={{ left: pos(b.min_temp_c), width: `calc(${pos(b.max_temp_c)} - ${pos(b.min_temp_c)})` }} />
      {b.temp_c != null && <div className="marker" style={{ left: pos(b.temp_c) }} />}
      <span className="lo">{b.min_temp_c}°</span><span className="hi">{b.max_temp_c}°</span>
    </div>
  );
}

function Spark({ id }) {
  const [pts, setPts] = useState([]);
  useEffect(() => {
    const load = () => fetch(`/api/boxes/${id}/readings?limit=60`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setPts(Array.isArray(d) ? d : []))
      .catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [id]);
  if (pts.length < 2) return <div className="spark" />;
  const ys = pts.map((p) => p.temp_c), lo = Math.min(...ys), span = Math.max(...ys) - lo || 1;
  const d = pts.map((p, i) => `${(i / (pts.length - 1)) * 200},${36 - ((p.temp_c - lo) / span) * 32}`).join(' ');
  return <svg className="spark" viewBox="0 0 200 40" preserveAspectRatio="none"><polyline points={d} /></svg>;
}

// Line chart over time. band = [min, max] draws the safe range.
function LineChart({ title, pts, unit, band }) {
  const W = 600, H = 130, L = 44, R = 8, T = 8, B = 20;
  const data = pts.filter((p) => p.v != null);
  if (data.length < 2) return <figure className="chart"><figcaption>{title}</figcaption><p className="empty">Not enough data yet</p></figure>;
  const vals = data.map((p) => p.v);
  const dmin = Math.min(...vals), dmax = Math.max(...vals);
  let lo = dmin, hi = dmax;
  if (band) { lo = Math.min(lo, band[0]); hi = Math.max(hi, band[1]); }
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const t0 = data[0].t, t1 = data[data.length - 1].t;
  const x = (t) => L + ((t - t0) / ((t1 - t0) || 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = data.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const tm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}, from ${f(dmin)} to ${f(dmax)} ${unit}`}>
        {band && <rect className="safeband" x={L} width={W - L - R} y={y(band[1])} height={Math.max(0, y(band[0]) - y(band[1]))} />}
        <line className="axis" x1={L} y1={T} x2={L} y2={H - B} />
        <line className="axis" x1={L} y1={H - B} x2={W - R} y2={H - B} />
        <polyline points={line} />
        <text x={L - 4} y={y(dmax) + 3} textAnchor="end">{f(dmax)}{unit}</text>
        <text x={L - 4} y={y(dmin) + 3} textAnchor="end">{f(dmin)}{unit}</text>
        <text x={L} y={H - 5}>{tm(t0)}</text>
        <text x={W - R} y={H - 5} textAnchor="end">{tm(t1)}</text>
      </svg>
    </figure>
  );
}

const RANGES = [['1 hour', 1], ['6 hours', 6], ['24 hours', 24], ['All', 0]];

function HistoryModal({ box, onClose, onChanged }) {
  const [hours, setHours] = useState(6);
  const [rev, setRev] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [danger, setDanger] = useState(null); // 'clear' | 'delete'
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null); setError('');
    fetch(`/api/boxes/${box.id}/history?hours=${hours}&limit=400`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => alive && setData(d))
      .catch(() => alive && setError('Could not load the history.'));
    return () => { alive = false; };
  }, [box.id, hours, rev]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = data ? data.readings : [];
  const s = data ? data.box : null;
  const series = (k) => rows.map((r) => ({ t: new Date(r.recorded_at).getTime(), v: r[k] }));

  const downloadCsv = async () => {
    const r = await fetch(`/api/boxes/${box.id}/history?hours=${hours}&limit=5000`);
    if (!r.ok) return;
    const { readings } = await r.json();
    const cols = ['recorded_at', 'temp_c', 'hum_pct', 'vib_g', 'tilt_deg', 'moving', 'lid_open', 'speed_kmph', 'lat', 'lng'];
    const csv = [cols.join(','), ...readings.map((x) => cols.map((c) => x[c] ?? '').join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${box.id}-history.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const runDanger = async () => {
    setBusy(true);
    const r = danger === 'delete'
      ? await api('DELETE', `/api/boxes/${box.id}`)
      : await api('DELETE', `/api/boxes/${box.id}/readings`);
    setBusy(false);
    if (!r.ok) { setError('That action failed or was not allowed.'); return; }
    onChanged();
    if (danger === 'delete') { onClose(); return; }
    setDanger(null); setTyped(''); setRev((v) => v + 1);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`${box.name} history`} onClick={(e) => e.stopPropagation()}>
        <header>
          <div><h2>{box.name} history</h2><p>{box.vaccine}{s ? `, dispatched ${when(s.dispatched_at)}` : ''}</p></div>
          <button className="ghost" onClick={onClose}>Close</button>
        </header>

        <div className="range" role="group" aria-label="Time range">
          {RANGES.map(([label, h]) => (
            <button key={label} aria-pressed={hours === h} onClick={() => setHours(h)}>{label}</button>
          ))}
        </div>

        {error && <p className="error">{error}</p>}
        {!data && !error && <p className="empty">Loading…</p>}

        {s && (s.n === 0 ? <p className="empty">No readings in this time range.</p> : (
          <>
            <dl className="sum">
              <div><dt>Readings</dt><dd>{s.n}</dd></div>
              <div><dt>Temperature (min / avg / max)</dt><dd>{f(s.min_temp)} / {f(s.avg_temp)} / {f(s.max_temp)} °C</dd></div>
              <div><dt>Out of safe range</dt><dd>{Math.round(s.out_of_range_s / 60)} min</dd></div>
              <div><dt>Lid openings</dt><dd>{s.lid_openings} ({Math.round(s.lid_open_s / 60)} min open)</dd></div>
              <div><dt>Shocks</dt><dd>{s.shocks} (peak {f(s.max_vib, 2)} g)</dd></div>
              <div><dt>Tipped readings</dt><dd>{s.tipped} (max {f(s.max_tilt, 0)}°)</dd></div>
              <div><dt>Humidity (max)</dt><dd>{f(s.max_hum, 0)}%</dd></div>
              <div><dt>Period</dt><dd>{when(s.first_at)} to {when(s.last_at)}</dd></div>
            </dl>

            <div className="charts">
              <LineChart title="Temperature" unit="°C" pts={series('temp_c')} band={[s.min_temp_c, s.max_temp_c]} />
              <LineChart title="Humidity" unit="%" pts={series('hum_pct')} />
              <LineChart title="Vibration" unit=" g" pts={series('vib_g')} />
              <LineChart title="Tilt" unit="°" pts={series('tilt_deg')} />
            </div>

            <div className="tablewrap">
              <table>
                <thead><tr><th>Time</th><th>Temp °C</th><th>Hum %</th><th>Vib g</th><th>Tilt °</th><th>Lid</th><th>Motion</th><th>km/h</th></tr></thead>
                <tbody>
                  {rows.slice(-100).reverse().map((r) => (
                    <tr key={r.recorded_at}>
                      <td>{when(r.recorded_at)}</td><td>{f(r.temp_c)}</td><td>{f(r.hum_pct, 0)}</td><td>{f(r.vib_g, 2)}</td>
                      <td>{f(r.tilt_deg, 0)}</td><td>{r.lid_open ? 'Open' : 'Closed'}</td><td>{r.moving ? 'Moving' : 'Still'}</td><td>{f(r.speed_kmph, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small">Showing the newest {Math.min(100, rows.length)} of {rows.length} sampled rows. Charts and the CSV cover the whole time range.</p>
            <div><button className="ghost" onClick={downloadCsv}>Download CSV</button></div>
          </>
        ))}

        <section className="danger-zone">
          <h3>Delete data</h3>
          {!danger && (
            <div className="row">
              <button className="ghost" onClick={() => setDanger('clear')}>Clear history</button>
              <button className="danger" onClick={() => setDanger('delete')}>Delete box</button>
            </div>
          )}
          {danger && (
            <>
              <p>
                {danger === 'delete'
                  ? `This removes ${box.name} and all of its readings. If the device keeps sending, the box reappears on its next message.`
                  : `This removes all readings of ${box.name} and starts its shipment again from now. The box stays on the dashboard.`}
                {' '}It cannot be undone. Type <b>{box.id}</b> to confirm.
              </p>
              <div className="row">
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={box.id} aria-label="Type the box ID to confirm" />
                <button className="danger" disabled={typed !== box.id || busy} onClick={runDanger}>
                  {danger === 'delete' ? 'Delete box' : 'Clear history'}
                </button>
                <button className="ghost" onClick={() => { setDanger(null); setTyped(''); }}>Cancel</button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function BoxCard({ b, onDeliver, onRestart, onHistory }) {
  const [label, cls] = VERDICT[b.verdict];
  const used = b.max_excursion_s ? Math.min(100, (b.excursion_s / b.max_excursion_s) * 100) : 0;
  return (
    <article className={`box ${cls}`}>
      <header>
        <div><h2>{b.name}</h2><p>{b.vaccine}{b.destination ? `, to ${b.destination}` : ''}</p></div>
        <span className={`badge ${cls}`}>{label}</span>
      </header>
      <div className="temp">{f(b.temp_c)}<span>°C</span></div>
      <Gauge b={b} />
      <Spark id={b.id} />
      <dl>
        <div><dt>Humidity</dt><dd>{f(b.hum_pct, 0)}%</dd></div>
        <div><dt>Vibration</dt><dd>{f(b.vib_g, 2)} g</dd></div>
        <div><dt>Tilt</dt><dd>{f(b.tilt_deg, 0)}°</dd></div>
        <div><dt>Lid</dt><dd>{b.lid_open ? 'Open' : 'Closed'}</dd></div>
        <div><dt>Motion</dt><dd>{b.moving ? 'Moving' : 'Still'}</dd></div>
        <div><dt>Speed</dt><dd>{f(b.speed_kmph, 0)} km/h</dd></div>
      </dl>
      <p className="loc">
        {b.lat != null
          ? <a href={`https://www.openstreetmap.org/?mlat=${b.lat}&mlon=${b.lng}#map=15/${b.lat}/${b.lng}`} target="_blank" rel="noreferrer">Location: {f(b.lat, 5)}, {f(b.lng, 5)}</a>
          : 'Location: no GPS fix yet'}
      </p>
      <div className="budget">
        <div className="bar"><span style={{ width: `${used}%` }} /></div>
        <p>Time out of range: {Math.round(b.excursion_s / 60)} of {Math.round(b.max_excursion_s / 60)} min allowed</p>
      </div>
      {b.reasons.length > 0 && <ul className="reasons">{b.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      <footer>
        <span className={b.offline ? 'offline' : ''}>
          {b.status === 'delivered' ? `Delivered ${ago(b.delivered_at)}` : `${b.offline ? 'Offline. ' : ''}Last reading ${ago(b.last_seen)}`}
        </span>
        <div className="actions">
          <button className="ghost" onClick={() => onHistory(b)}>History</button>
          {b.status === 'in_transit'
            ? <button onClick={() => onDeliver(b)}>Mark delivered</button>
            : <button onClick={() => onRestart(b)}>New shipment</button>}
        </div>
      </footer>
    </article>
  );
}

export default function App() {
  const [boxes, setBoxes] = useState([]);
  const [error, setError] = useState('');
  const [historyBox, setHistoryBox] = useState(null);
  const load = () =>
    fetch('/api/boxes')
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((d) => { setBoxes(Array.isArray(d) ? d : []); setError(''); })
      .catch(() => setError('Server error. Check the backend terminal for the database or MQTT message.'));
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  const deliver = async (b) => {
    if (!window.confirm(`Mark ${b.name} as delivered?\n\nThe usable / not usable check stops counting new readings from this moment.`)) return;
    await api('POST', `/api/boxes/${b.id}/deliver`);
    load();
  };
  const restart = async (b) => {
    if (!window.confirm(`Start a new shipment for ${b.name}?\n\nThe usable / not usable check starts again from now. Older readings stay in the history.`)) return;
    await api('POST', `/api/boxes/${b.id}/restart`);
    load();
  };
  const count = (v) => boxes.filter((b) => b.verdict === v).length;

  return (
    <main>
      <h1>Vaccine boxes</h1>
      <p className="tally">
        <b className="safe">{count('safe')} usable</b>
        <b className="caution">{count('caution')} need a look</b>
        <b className="bad">{count('unusable')} not usable</b>
      </p>
      {error && <p className="error">{error}</p>}
      {!error && boxes.length === 0 && <p className="empty">No boxes yet. A box appears here after its first MQTT message.</p>}
      <section className="grid">
        {boxes.map((b) => <BoxCard key={b.id} b={b} onDeliver={deliver} onRestart={restart} onHistory={setHistoryBox} />)}
      </section>
      {historyBox && <HistoryModal box={historyBox} onClose={() => setHistoryBox(null)} onChanged={load} />}
    </main>
  );
}
