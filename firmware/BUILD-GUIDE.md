# Building the sensor hub

Step by step, from loose parts to a working station. Allow about two hours the
first time. Nothing here is difficult, but two mistakes can destroy a sensor, so
they are called out in bold where they can happen.

**The ESP32 does not go on the prototype board.** Only the two sensor sockets,
the screw terminals and the capacitors do. The ESP32 stays on its jumper wires,
which keeps its USB port reachable and means it can be pulled out and reflashed
without desoldering anything.

**The one rule: wire by the printed label, never by pin position.** Your two
sensors do not use the same pin order.

| Board | pin 1 | pin 2 | pin 3 | pin 4 |
|-------|-------|-------|-------|-------|
| BME280 | VIN | GND | SCL | SDA |
| SCD41 | GND | VCC | SCL | SDA |

Power and ground are swapped between them. On the hub the SCL and SDA lines run
straight across, and the two power lines **cross over in an X**.

---

## What you need

**From the kits**

- 1 × prototype board, 3 × 7 cm (the 5 × 7 also works if you want more room)
- 2 × 4-pin **female** header — the sockets your sensors plug into
- 1 × 4-pin **male** header — solders into the SCD41's bare holes
- 2 × 2-pin screw terminal — where the wires from the ESP32 land
- 1 × 100 µF electrolytic capacitor (10 V rating or higher)
- 1 × 0.1 µF ceramic capacitor — the little disc marked **104**
- 4 × nylon standoff + screws (optional, see step 10)

**Already yours**

- ESP32, BME280, SCD41
- 4 × female-to-female jumper wires
- Soldering iron and solder, side cutters, USB cable

**Useful if you have it**

- Multimeter (for the checks in step 9)
- Helping hands or a bit of putty to hold parts still

---

## Step 0 — Set up

Work somewhere ventilated and **do not lean over the iron**. Rosin flux smoke is
a respiratory irritant and a plausible trigger in its own right — an open window
and keeping your head out of the plume is enough. If you are using leaded solder,
wash your hands before eating.

Set the iron to about **330 °C**. Once it is hot, melt a little solder onto the
tip and wipe it on the sponge or brass wool — a tip that looks silver transfers
heat well, a dull grey one barely transfers at all.

Have the pinout table above where you can see it.

---

## Step 1 — Cut the headers

The long strips are meant to be cut between pins.

1. Count **4 pins**, then cut through the plastic on the **5th**. You sacrifice
   that 5th pin — this is normal and expected.
2. Side cutters work; so does scoring the plastic with a knife and snapping it.
3. Cut **two 4-pin female** pieces and **one 4-pin male** piece.

Check your BME280 first: if it already has pins sticking out (it should, since
your jumper wires push onto them), you need only the one male piece. If it turns
out to have bare holes as well, cut a second male piece for it.

---

## Step 2 — Solder the male header into the SCD41

This is the only soldering that happens on a sensor, so take it slowly.

**Which way round.** The black plastic goes against the **plain back face** —
the one without the big sensor package on it. Get this backwards and the plastic
cannot sit flush, because the package is in the way.

The quickest check is to hold your BME280 next to it and copy the arrangement:
plastic on the back, long pins pointing down, components facing up, solder blobs
on the component side.

```
   how it should end up, plugged into its socket:

        ┌──────────────┐
        │  ▓▓▓▓▓▓      │ ← SCD41 package, facing UP into the room
        └──┬─┬─┬─┬─────┘   ← solder the little stubs on THIS face
           │ │ │ │
        ▐██╪═╪═╪═╪██▌      ← black plastic flat against the plain back
           ║ ║ ║ ║
           ▼ ▼ ▼ ▼         ← long pins down into the socket
```

It has to end up with the sensor facing up into the room: the SCD41 reads the
air that reaches its opening, and pointing it down into the gap above the hub
board leaves it sampling a stale pocket and responding slowly.

1. Push the header into the four holes from the plain back, plastic flat against
   that face, long pins pointing away from the components.
2. Turn the board component-side-up. Only **1–2 mm of each pin will poke
   through** — that is correct and all you need. What makes the joint is solder
   flowing into the plated hole and wetting the copper ring, not the length of
   pin sticking out.
3. **Solder one pin only.** Heat the pin and the ring of copper around the hole
   at the same time, count one-two, then feed solder in against the joint — not
   onto the iron tip. Remove the solder first, then the iron.
4. Look at it from the side. Is the header square against the board? If it is
   leaning, reheat that single joint and straighten it while the solder is
   liquid. This is why you only did one.
5. Once it sits square, solder the other three. Keep the iron tip on the pin and
   off the sensor package next door.

A good joint is a small shiny cone that has flowed onto both the pin and the
ring. A dull grey ball perched on top has not bonded — reheat it, and add a
touch more solder to help it flow.

---

## Step 3 — Plan the layout before soldering anything else

Put the parts on the board and look at it before committing.

```
                 ┌──────────────────────────────────┐
                 │ ○                              ○ │  ← leave the corners free
                 │                                  │
 BME280 socket → │    ●    ●    ●    ●              │
                 │   VIN  GND  SCL  SDA             │
                 │    1    2    3    4              │
                 │                                  │
                 │        (wires underneath)        │
                 │                                  │
 SCD41 socket  → │    ●    ●    ●    ●              │
                 │   GND  VCC  SCL  SDA             │
                 │    1    2    3    4              │
                 │                                  │
                 │   ═╪═ 100µF     ═╪═ 104          │
                 │                                  │
                 │   [▣▣] [▣▣]  ← to ESP32          │
                 │ ○                              ○ │
                 └──────────────────────────────────┘
```

Points that matter:

- **Line the two sockets up column for column.** Pin 1 above pin 1, and so on.
  It makes the wiring underneath obvious and easy to check.
- **Leave a few holes clear at each corner** for the standoffs.
- Leave a couple of rows between the sockets — that is where the wires go.
- Sensors plug in from the top, so nothing should sit directly above a socket.

Mark the corners of each part with a pencil so you can find the spot again.

---

## Step 4 — Solder the two female sockets

Same technique as step 2: **one pin, check it is square, then the rest.**

Female headers have a habit of tilting because there is nothing holding them
down. Two ways to deal with that:

- Press the socket down with a fingernail or a bit of putty while you tack the
  first pin, or
- Plug the sensor into the socket first — the weight of the board holds it
  square while you tack it. Take the sensor off again before soldering the rest,
  so you are not heating it needlessly.

Do both sockets. Take a moment to confirm they are aligned column for column.

---

## Step 5 — Solder the screw terminals

The 2-pin terminals usually have a dovetail on the side so two of them slide
together into a 4-way block. Slide them together first, then solder — it is
fiddly afterwards.

Point the wire openings **outward**, off the edge of the board, so you can get a
screwdriver in later.

Solder both pins of each. These carry all the current, so make them solid.

---

## Step 6 — Wire the four nets underneath

Clip the legs off your capacitors first (leave about 6 mm on the capacitor
itself) — those offcuts are stiff bare wire, perfect for this and free.

Turn the board over. Work in this order, and **verify each net before starting
the next**:

**a. SCL — a straight run.** BME pin 3 → SCD pin 3 → one screw terminal. If your
sockets are aligned, this is a straight line.

**b. SDA — the other straight run.** BME pin 4 → SCD pin 4 → the next terminal.

**c. GND.** BME pin **2** → SCD pin **1** → a screw terminal. This one is a
diagonal.

**d. 3V3.** BME pin **1** → SCD pin **2** → the last screw terminal. Also a
diagonal, crossing the one you just did.

Steps c and d cross each other. **If your two power wires end up running
parallel instead of crossing, stop and re-read the pinout table** — parallel
means you are about to put 3V3 into a sensor's ground pin.

Keep bare wires from touching where they cross: lift one over the other, or
sleeve one in a scrap of insulation. Solder joins by heating the pad and wire
together and letting solder flow into both.

---

## Step 7 — Fit the capacitors

Both go across the **3V3 and GND** nets, as close to the SCD41 socket as you can
manage. They are there to supply the 205 mA gulp the SCD41 takes each time it
measures.

**The electrolytic (100 µF) is polarised and this matters.**

- It has a **stripe down one side marking the negative leg**.
- The **longer leg is positive**.
- Stripe / short leg → **GND**. Long leg → **3V3**.

Fitted backwards it will get hot and eventually vent. Check twice.

The **104 ceramic disc has no polarity** — either way round is fine. It goes in
parallel with the electrolytic, across the same two nets.

---

## Step 8 — Inspect before any power goes near it

Five minutes here saves a dead sensor.

1. **Find the X.** Look at the underside. The two power wires must cross. If
   they run parallel, fix it now.
2. **Hunt for bridges.** Look along each row of pads with a light behind the
   board. Any accidental solder blob joining two neighbouring pads must go —
   reheat it and wipe the tip clean, or use solder wick.
3. **Check the electrolytic's stripe** points at the GND net.
4. **Confirm the pins.** Trace with a finger: BME pin 1 (VIN) really does end up
   on the same wire as SCD pin 2 (VCC), not SCD pin 1.

**With a multimeter, in continuity mode:**

| Probe A | Probe B | Expected |
|---|---|---|
| BME pin 1 | SCD pin 2 | beeps (3V3 net) |
| BME pin 2 | SCD pin 1 | beeps (GND net) |
| BME pin 3 | SCD pin 3 | beeps (SCL) |
| BME pin 4 | SCD pin 4 | beeps (SDA) |
| 3V3 net | GND net | **must NOT beep** |

On that last one, with the capacitor fitted you may hear a brief chirp as it
charges, then silence. A steady continuous beep is a short — find it before
powering anything.

---

## Step 9 — Flash the ESP32 first, with nothing plugged in

Do this before connecting the hub, so you know the ESP32 and the code are good.

1. Open `firmware/weather_station/weather_station.ino` in the Arduino IDE.
2. **Tools → Board →** ESP32 Dev Module (or whichever matches your board).
3. **Tools → Port →** your ESP32's port.
4. Confirm the libraries are installed: Adafruit BME280, Sensirion I2C SCD4x,
   Sensirion Core, ThingSpeak.
5. Upload. If it sits on "Connecting…", hold the **BOOT** button while it starts.
6. Open **Tools → Serial Monitor**, set to **115200 baud**.

You should see the scan, then the BME280 failing, then a reboot — that loop is
correct right now, because nothing is connected:

```
--- ESP32 Weather Station Booting Up ---
Scanning I2C bus...
  nothing responded. Check SDA (GPIO21), SCL (GPIO22),
  power and a shared ground between every board.
Initializing BME280.....  not found at 0x76 or 0x77. Rebooting in 10s.
```

Seeing that is a pass. The code runs and the serial link works.

---

## Step 10 — Connect and test in stages

Unplug the ESP32 from USB before changing any wiring. Every time.

**Stage 1 — power and bus, no sensors.**

Screw the four jumper wires into the terminals: 3V3, GND, G21 (SDA), G22 (SCL).
Plug the other ends onto the matching ESP32 pins. No sensors in the sockets yet.

Power up. Expect `nothing responded` again — but now it proves the wiring has no
short, because the ESP32 booted at all.

**Stage 2 — add the BME280.**

Unplug USB. Push the BME280 into its socket, pins fully home, component side up.
Power up. Type `x` and Enter in the Serial Monitor:

```
Scanning I2C bus...
  found 0x76   <- BME280
```

The station should now start posting to ThingSpeak every 30 seconds.

**Stage 3 — add the SCD41.**

Unplug USB. Push the SCD41 into its socket. Power up, press `x`:

```
Scanning I2C bus...
  found 0x62   <- SCD41
  found 0x76   <- BME280
```

Both addresses means you are done. The first CO₂ reading arrives about 30
seconds later (low-power mode), and the dashboard unhides its CO₂ tile, chart
and fog analysis on its own once field 5 has data.

Press `i` for a status summary, including the SCD41-versus-BME280 temperature
cross-check. A steady **+2 to +4 °C** is normal self-heating, not a fault.

---

## Step 11 — Standoffs

These keep the solder joints off the desk and let air move under the board.

**First check whether they fit.** The grid holes are 1 mm; M3 nylon screws need
3 mm. Some prototype boards have larger holes at the corners, some do not.

**If the corner holes are big enough:**

A nylon standoff set usually has three kinds of piece — threaded pillars, screws
and nuts. Depending on which pillars you have:

- *Male–female pillars* (a stud on one end, a threaded hole in the other): push
  the stud up through the corner hole from underneath and put a nut on top. The
  pillar body is the foot.
- *Female–female pillars* (threaded holes at both ends): hold the pillar under
  the corner and drive a screw down through the board into it.

Do all four finger-tight, then a gentle nip. Nylon threads strip easily — if it
suddenly turns freely, you have gone too far.

**If the corner holes are too small,** do not force a screw through: you will
lift the copper. Either enlarge one grid hole at each corner with a 3 mm drill
bit (slowly, board flat on scrap wood), or skip the standoffs and rest the board
on anything non-conductive. Cardboard is perfectly adequate.

---

## Step 12 — Where to put it

Placement changes the numbers, so it is worth thinking about once and then
leaving alone.

- **Put it in the room you actually work in**, at roughly seated head height.
  CO₂ near the ceiling or floor is not the air you are breathing.
- **Keep it at least 50 cm from your face.** Exhaled breath is around 40,000 ppm
  — leaning over the sensor will spike it to nonsense.
- **Not next to a window, door or air-conditioning vent.** You want the room's
  air, not a jet of whatever is on the other side.
- **Out of direct sunlight**, which would cook the temperature reading.
- **Keep the ESP32 10 cm or so from the BME280.** The board runs warm; that is
  why it is on wires rather than bolted to the hub.
- **Then leave it there.** Consistency matters more than the perfect spot —
  moving it halfway through breaks comparability between your early and late
  data, which is exactly what the correlations depend on.

Do not run the `c` recalibration for the first **5 days**. The datasheet
requires that settling period before a forced recalibration is valid on a new
sensor.

---

## If something is wrong

| What you see | Most likely cause |
|---|---|
| `nothing responded` with sensors plugged in | A break in SDA, SCL, 3V3 or GND. Check continuity from the ESP32 pin all the way to the sensor pin. |
| Only `0x76` (BME280) | The fault is on the SCD41's four connections — a dry joint on its male header is the usual culprit. Reflow all four. |
| Only `0x62` (SCD41) | Same, on the BME280 side. |
| BME280 shows as `0x77` | Fine, and handled — some modules are strapped that way and the sketch tries both addresses. |
| Both found, but CO₂ stays "waiting" | Give it 30 seconds. If it persists, the sensor answers but is not measuring — power it down fully and back up. |
| ESP32 reboots at random | Power. The SCD41's 205 mA peak on a weak USB supply. Try another cable or a 1 A charger, and confirm the capacitors are actually connected. |
| Everything found, nothing on the dashboard | ThingSpeak side, not hardware. Check Field 5 is enabled on the channel, and read the serial log for the HTTP code. |
| Nothing on serial at all | Wrong baud rate — it must be 115200 — or the wrong port. |

Whatever happens, the `x` command is the first thing to reach for. It separates
a wiring problem from everything else in one second.
