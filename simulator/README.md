# Cold chain simulator

Publishes sample readings for 20 boxes (BOX-002 to BOX-021) to your MQTT broker, in the same JSON the ESP32 sends.

## Run
```powershell
cd simulator
npm install
copy .env.example .env     # then edit .env: MQTT_URL (terraform output -raw mqtt_host) and MQTT_PASS (terraform output -raw mqtt_esp32_password)
npm start                  # Ctrl+C to stop
```
`npm run dry` prints the messages without sending them (no broker needed; on Windows PowerShell use `$env:DRY_RUN=1; node simulate.js`).

## What the 20 boxes do
| Behaviour | Boxes | What you should see on the dashboard |
|---|---|---|
| healthy | 9 | Stay "Usable", temperature 4 to 6 C |
| lid_openings | 3 | Lid opens for a few readings now and then; "Use with caution" |
| rough_handling | 1 | Random shocks and tipping over; "Use with caution" |
| slow_warming | 2 | Temperature creeps up to 12 C: caution first, then "Not usable" |
| long_excursion | 1 | Sits at about 9 C: "Not usable" once the time limit is used up |
| freezing | 1 | Drops below 0 C: "Not usable" at once |
| overheat | 1 | Spikes to 18 C for a short time: "Not usable" at once |
| high_humidity | 1 | Humidity climbs to about 92%: "Use with caution" |
| goes_offline | 1 | Stops sending after about 3 minutes; shows "Offline" 5 minutes later |

Every box also drives along a route between two cities, so location, speed and motion change.

## Time acceleration
With the default `SPEED=30` and `INTERVAL_S=10`, each message counts as 300 simulated seconds, so "one hour out of range" takes 12 messages (2 minutes). Most states appear within 3 to 8 minutes. Set `SPEED=1` for real time.

## Cleaning up
The boxes stay in the database after you stop. To remove them, open a Session Manager shell on the mqtt-ingest server, run `sudo -i`, and paste `cleanup-on-server.sh`. Mark-as-delivered boxes are removed too.
Leaving the simulator running for days adds about 170,000 rows a day and slows the dashboard, so use it for demos.
