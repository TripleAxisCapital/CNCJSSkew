# CNCJSSkew

**Two-point workpiece alignment for CNCjs + GRBL.**  
Clamp the workpiece slightly crooked, capture two known reference points, and CNCJSSkew rotates + translates the loaded G-code to match the real part.

No electrical probe. No cloud runtime. No GRBL EEPROM changes. Once installed, it works offline on the Raspberry Pi.

---

# Install

## First time only

### 1 — Install Git + GitHub CLI

Copy and paste:

```bash
sudo apt update && sudo apt install -y git gh
```

### 2 — Sign in to GitHub

Copy and paste:

```bash
gh auth login
```

Choose:

```text
GitHub.com
HTTPS
Yes
Login with a web browser
```

Follow the one-time browser login.

### 3 — Download + install CNCJSSkew

Copy and paste this whole line:

```bash
cd ~ && gh repo clone TripleAxisCapital/CNCJSSkew && cd CNCJSSkew && ./setup.sh
```

That is it for the Raspberry Pi.

The setup script:

- checks the code
- installs the local CNCjs widget
- preserves your existing CNCjs config
- makes a backup of `~/.cncrc`
- restarts CNCjs automatically when it can identify the service

If it cannot restart CNCjs automatically, it will tell you. In that case, restart CNCjs the same way you normally do.

---

# Add it to CNCjs

Open CNCjs in your browser.

Go to:

**Manage Widgets → Add Custom Widget**

Set the URL to:

```text
/cncjs-skew/
```

The **CNCJSSkew · Workpiece Align** panel should appear.

At this point everything is local on the Raspberry Pi. Internet is no longer required.

---

# Use it

For the watch, create two reference holes in Fusion 360 and know their exact CAD coordinates.

Example:

```text
Point A = X0  Y-40
Point B = X0  Y+40
```

Then:

1. Load the original Fusion G-code into CNCjs.
2. Enter the CAD coordinates for A and B in CNCJSSkew.
3. Jog the spindle to the exact center of physical Point A.
4. Press **Capture current position as A**.
5. Jog to the exact center of physical Point B.
6. Press **Capture current position as B**.
7. CNCJSSkew calculates rotation + X/Y translation automatically.
8. Press **Apply & load aligned preview**.
9. Check the normal CNCjs visualizer.
10. Run the job normally.

No electrical probing is used.

---

# Flip the watch

For Side 2:

1. Flip and secure the stock.
2. Load the **original Side 2 G-code**.
3. Capture A again.
4. Capture B again.
5. Press **Apply & load aligned preview**.
6. Inspect the toolpath.
7. Set/re-zero **Z** normally.
8. Run Side 2.

The stock does not need to return to exactly the same XY position or angle. CNCJSSkew recalculates the alignment from the two points.

---

# What it corrects

CNCJSSkew solves one rigid 2D transform:

```text
X translation
Y translation
XY rotation / de-skew
```

It does **not** scale the job and does **not** modify Z.

---

# Before the real watch

Do one air-cut first:

1. Use scrap.
2. Clamp it slightly crooked on purpose.
3. Keep the spindle **OFF**.
4. Keep Z safely above the stock.
5. Capture A and B.
6. Apply alignment.
7. Run a simple test toolpath.
8. Confirm the Shapeoko follows the crooked part correctly.

Always inspect the aligned toolpath in CNCjs before running a real cut.

For good angular accuracy, place the two reference points as far apart as practical. Roughly **60–100 mm apart** is a useful target for this watch setup if the stock allows it.

---

# Update later

Copy and paste:

```bash
cd ~/CNCJSSkew && git pull
```

Refresh CNCjs.

If a future update changes the installer, run:

```bash
cd ~/CNCJSSkew && ./setup.sh
```

---

# Test manually

Optional:

```bash
cd ~/CNCJSSkew && npm test
```

---

# Uninstall

Copy and paste:

```bash
cd ~/CNCJSSkew && ./uninstall.sh
```

Then restart CNCjs.

---

# Supported G-code

CNCJSSkew is intentionally conservative and targets normal **GRBL 3-axis Fusion 360 output**.

Supported common cases include:

- G0 / G1 XY motion
- G2 / G3 in the G17 XY plane
- G90 / G91
- G20 / G21
- G53 Z-only retracts
- one work coordinate system such as G54

For safety it refuses ambiguous/risky cases such as G53 XY moves, multiple WCSs, G68/G69 rotation, G50/G51 scaling, unsupported arc-center modes, XY probing/canned cycles, non-G17 arcs requiring rotation, dynamic macro expressions, or double-aligning an already aligned file.

---

# Offline by design

GitHub is used only to download or update the project.

There is no GitHub Pages dependency, no GitHub Actions dependency, no CDN, no cloud runtime, and no internet requirement while machining.

# License

MIT
