# Indoor positioning (offices, warehouses)

**GPS does not give usable positions indoors** (multi-metre to tens-of-metres error, no floor
information). Indoor positions in MIHIR therefore come only from hardware you install. Choose by the
precision you need:

| Need | Technology | Typical precision | What to buy | How it reaches MIHIR |
|---|---|---|---|---|
| Which building / outside | GPS (phone) | 5–30 m outdoors | nothing | Places (geofences) |
| Which room / zone / floor | **BLE beacons** (iBeacon) | room level; 2–5 m with ≥3 beacons in range | 1 beacon per room or every ~8–10 m (e.g. Kontakt.io, Minew, Estimote, Feasycom), coin-cell or USB powered | The phone app scans and sends sightings; the server estimates position |
| Which desk | **UWB RTLS** | 10–30 cm | Anchors on walls/ceiling + a badge/tag per person, with the vendor's positioning engine (e.g. Pozyx, Sewio, Quuppa (BLE AoA), Kontakt.io UWB, Zebra) | The vendor engine pushes positions to `/api/location/indoor/rtls` |

Desk-level positioning from BLE alone is not reliable — the UI labels BLE positions "BLE" and UWB "UWB".

## Setting up a floor (Locations → Indoor, Admin)

1. Turn on **Indoor positioning** in Privacy & policy.
2. **Add floor**: name, level, building (a Place), floor-plan image (PNG/JPG/SVG ≤ ~9 MB), and the
   **scale in metres per pixel** (measure a known wall: metres ÷ pixels on the image).
3. **Draw zones**: click the corners of each room / desk / restricted area, name it, pick the type,
   Save. Restricted zones raise a "restricted entry" alert (add a rule under Alerts).
4. **Place beacons**: click where each beacon is mounted and enter its id as `UUID:major:minor`
   (from the beacon's label or its configuration app). Use one UUID for the whole company and
   different major/minor numbers per beacon. "Seen …" shows when a phone last heard it.
5. Phones in a work session start sending sightings automatically (the app is told which UUIDs to
   look for). Live positions appear on the floor plan.

### BLE positioning method (`backend/location/geo.js → estimateBlePosition`)
- Ignores beacons not placed on a plan and signals weaker than −95 dBm.
- 1–2 beacons heard → position of the strongest ("nearest beacon"), accuracy from the RSSI.
- ≥ 3 on the same floor → RSSI-weighted centroid of the 4 strongest.
- The zone is the smallest drawn zone containing the point (a desk inside a room wins).

Beacon tips: transmit interval 300–500 ms, TX power −12 to −4 dBm, mounted ~2–2.5 m high away from
metal; set the measured "TX power at 1 m" on the beacon in MIHIR if known.

## UWB / RTLS integration

1. In Indoor → *UWB / RTLS badges*: assign each badge/tag id to a person.
2. Create an **integration key** (shown once; only a hash is stored; revocable).
3. Configure the vendor engine (or a small forwarder) to POST:

```
POST https://<your-site>/api/location/indoor/rtls
X-Location-Key: mtk_loc_…
Content-Type: application/json

{ "positions": [ { "tag": "uwb-0042", "floorId": 3, "x": 512.4, "y": 233.0, "accuracyM": 0.3, "t": "2026-10-12T09:15:02Z" } ] }
```

`x`/`y` are **floor-plan pixels** of the plan uploaded to MIHIR — configure the vendor's coordinate
transform (most engines report metres from an origin: `px = metres / metersPerPx`). Up to 1000
positions per request. Response: `{stored, ignoredNoSession, unknownTag, invalid}`.

**Privacy rule:** positions are stored only for people who currently have a work session on; badge
data outside sessions is discarded (`ignoredNoSession`).

## Hardware / setup you need to provide

- Beacons or a UWB system (purchase, installation, power).
- Floor-plan images with a known scale.
- For UWB: the vendor's engine/server and someone to configure its export to the endpoint above.
- The Android app 1.5 (BLE scanning) on employees' phones; Bluetooth on.
